const { makeWASocket, fetchLatestBaileysVersion, useMultiFileAuthState, Browsers, DisconnectReason } = require('@whiskeysockets/baileys');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const db = require('./database');

const AUTH_DIR = process.env.AUTH_DIR || path.join(__dirname, 'data', 'auth');
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY || '');
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

const connections = new Map();

function getAuthPath(businessId) {
  const p = path.join(AUTH_DIR, `business_${businessId}`);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  return p;
}

function buildSystemPrompt(businessId) {
  const services = db.getServices(businessId);
  const employees = db.getEmployees(businessId);
  let srvList = services.map(s => `  - ${s.name}: $${s.price} (${s.duration} min)`).join('\n') || '  (sin servicios cargados)';
  let empList = employees.map(e => `  - ${e.name}${e.phone ? ' ('+e.phone+')' : ''}`).join('\n') || '  (sin empleados cargados)';
  return `
Eres un asistente virtual de un negocio. Respondes en español, mensajes breves de 2 a 4 líneas. Sin emojis.
Si el cliente quiere sacar un turno, pedile: nombre, fecha (YYYY-MM-DD), hora (HH:MM), servicio y empleado (opcional).
Si no tenés la info necesaria, pedila. No inventes datos.
Si no podés resolver, decí: "Déjame derivarte con un asesor humano."

Servicios del negocio:
${srvList}

Empleados:
${empList}
`.trim();
}

async function callLLM(history, businessId) {
  if (!process.env.GOOGLE_API_KEY) return '⚠️ WhatsApp sin configurar. Contactá al administrador.';
  try {
    const model = genAI.getGenerativeModel({ model: MODEL, systemInstruction: buildSystemPrompt(businessId) });
    const contents = history.map(m => ({
      role: m.role === 'user' ? 'user' : 'model',
      parts: [{ text: m.content }]
    }));
    const result = await model.generateContent({ contents });
    return result.response.text();
  } catch (err) {
    console.error('[bot] LLM error:', err.message);
    return 'Ocurrió un error. Déjame derivarte con un asesor humano.';
  }
}

async function startConnection(businessId) {
  if (connections.has(businessId)) {
    try { connections.get(businessId).sock.end(undefined); } catch (e) {}
    connections.delete(businessId);
  }

  const authPath = getAuthPath(businessId);
  const { state, saveCreds } = await useMultiFileAuthState(authPath);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    browser: Browsers.macOS('Desktop'),
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    generateHighQualityLink: true
  });

  const conn = { sock, saveCreds, reconnectTimer: null };
  connections.set(businessId, conn);

  sock.ev.on('connection.update', async (update) => {
    const { qr, connection, lastDisconnect } = update;
    if (qr) {
      db.upsertWhatsAppConnection({ business_id: businessId, status: 'qr', qr_string: qr });
    }
    if (connection === 'open') {
      const phone = sock.user?.id?.split(':')[0] || '';
      db.upsertWhatsAppConnection({ business_id: businessId, status: 'connected', qr_string: '', phone });
      console.log(`[bot] Negocio ${businessId} conectado: ${phone}`);
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        db.upsertWhatsAppConnection({ business_id: businessId, status: 'disconnected', qr_string: '', phone: '' });
        if (connections.has(businessId)) { connections.delete(businessId); }
        const authDir = getAuthPath(businessId);
        try { fs.rmSync(authDir, { recursive: true, force: true }); } catch (e) {}
        console.log(`[bot] Negocio ${businessId} deslogueado`);
      } else {
        db.upsertWhatsAppConnection({ business_id: businessId, status: 'connecting' });
        conn.reconnectTimer = setTimeout(() => startConnection(businessId), code === 440 ? 15000 : 5000);
        connections.set(businessId, conn);
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    console.log(`[bot] messages.upsert: type=${type}, count=${messages.length}`);
    if (type !== 'notify') return;
    for (const msg of messages) {
      console.log(`[bot] msg: fromMe=${msg.key.fromMe}, jid=${msg.key.remoteJid}, msgType=${msg.message ? Object.keys(msg.message).join(',') : 'EMPTY'}`);
      console.log(`[bot] msg raw: ${JSON.stringify(msg.message).slice(0,300)}`);
      if (msg.key.fromMe) continue;
      if (msg.key.remoteJid?.includes('@g.us')) continue;
      const isWA = msg.key.remoteJid?.includes('@s.whatsapp.net') || msg.key.remoteJid?.includes('@lid');
      if (!isWA) continue;
      const phone = msg.key.remoteJid.split('@')[0];
      const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
      if (!text) continue;
      const pushName = msg.pushName || '';
      const conv = db.getOrCreateWACoversation(businessId, phone, pushName);
      if (msg.key.remoteJid !== phone + '@s.whatsapp.net' && msg.key.remoteJid !== conv.phone) {
        db.prepare('UPDATE wa_conversations SET phone=? WHERE id=?').run(msg.key.remoteJid, conv.id);
        conv.phone = msg.key.remoteJid;
      }
      db.insertWAMessage(conv.id, 'user', text);
      console.log(`[bot] ← ${phone}: ${text.slice(0, 60)}`);
      if (conv.mode === 'HUMAN') continue;
      const history = db.getRecentWAHistory(conv.id, 20);
      const reply = await callLLM(history, businessId);
      db.insertWAMessage(conv.id, 'assistant', reply);
      try {
        await sock.sendMessage(msg.key.remoteJid, { text: reply });
        console.log(`[bot] → ${phone}: ${reply.slice(0, 60)}`);
      } catch (err) {
        console.error(`[bot] Error enviando a ${phone}:`, err.message);
        db.enqueueWAOutbox(conv.id, businessId, msg.key.remoteJid, reply);
      }
    }
  });

  return sock;
}

async function startPairingConnection(businessId, phoneNumber) {
  if (connections.has(businessId)) {
    try { connections.get(businessId).sock.end(undefined); } catch (e) {}
    connections.delete(businessId);
  }

  const authPath = getAuthPath(businessId);
  const { state, saveCreds } = await useMultiFileAuthState(authPath);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    browser: Browsers.macOS('Desktop'),
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    generateHighQualityLink: true
  });

  const conn = { sock, saveCreds, reconnectTimer: null };
  connections.set(businessId, conn);

  db.upsertWhatsAppConnection({ business_id: businessId, status: 'pairing_wait', qr_string: '' });

  setTimeout(async () => {
    try {
      const code = await sock.requestPairingCode(phoneNumber);
      const displayCode = code.match(/.{1,4}/g).join('-');
      db.upsertWhatsAppConnection({ business_id: businessId, status: 'pairing', qr_string: displayCode });
      console.log(`[bot] Pairing code for ${businessId}: ${displayCode}`);
    } catch (err) {
      console.error(`[bot] Pairing error:`, err.message);
      db.upsertWhatsAppConnection({ business_id: businessId, status: 'pairing_error', qr_string: err.message });
    }
  }, 2000);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === 'open') {
      const phone = sock.user?.id?.split(':')[0] || '';
      db.upsertWhatsAppConnection({ business_id: businessId, status: 'connected', qr_string: '', phone });
      console.log(`[bot] Negocio ${businessId} conectado vía pairing: ${phone}`);
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        db.upsertWhatsAppConnection({ business_id: businessId, status: 'disconnected', qr_string: '', phone: '' });
        if (connections.has(businessId)) { connections.delete(businessId); }
        const authDir = getAuthPath(businessId);
        try { fs.rmSync(authDir, { recursive: true, force: true }); } catch (e) {}
        console.log(`[bot] Negocio ${businessId} deslogueado por pairing`);
      } else {
        db.upsertWhatsAppConnection({ business_id: businessId, status: 'connecting' });
        conn.reconnectTimer = setTimeout(() => startPairingConnection(businessId), code === 440 ? 15000 : 5000);
        connections.set(businessId, conn);
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      if (msg.key.remoteJid?.includes('@g.us')) continue;
      const isWA = msg.key.remoteJid?.includes('@s.whatsapp.net') || msg.key.remoteJid?.includes('@lid');
      if (!isWA) continue;
      const phone = msg.key.remoteJid.split('@')[0];
      const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
      if (!text) continue;
      const pushName = msg.pushName || '';
      const conv = db.getOrCreateWACoversation(businessId, phone, pushName);
      if (msg.key.remoteJid !== phone + '@s.whatsapp.net' && msg.key.remoteJid !== conv.phone) {
        db.prepare('UPDATE wa_conversations SET phone=? WHERE id=?').run(msg.key.remoteJid, conv.id);
        conv.phone = msg.key.remoteJid;
      }
      db.insertWAMessage(conv.id, 'user', text);
      console.log(`[bot] ← ${phone}: ${text.slice(0, 60)}`);
      if (conv.mode === 'HUMAN') continue;
      const history = db.getRecentWAHistory(conv.id, 20);
      const reply = await callLLM(history, businessId);
      db.insertWAMessage(conv.id, 'assistant', reply);
      try {
        await sock.sendMessage(msg.key.remoteJid, { text: reply });
        console.log(`[bot] → ${phone}: ${reply.slice(0, 60)}`);
      } catch (err) {
        console.error(`[bot] Error enviando a ${phone}:`, err.message);
        db.enqueueWAOutbox(conv.id, businessId, msg.key.remoteJid, reply);
      }
    }
  });

  return sock;
}

function stopConnection(businessId) {
  if (connections.has(businessId)) {
    const conn = connections.get(businessId);
    if (conn.reconnectTimer) clearTimeout(conn.reconnectTimer);
    try { conn.sock.end(undefined); } catch (e) {}
    connections.delete(businessId);
  }
  db.upsertWhatsAppConnection({ business_id: businessId, status: 'disconnected', qr_string: '', phone: '' });
}

async function processOutbox() {
  const pending = db.getPendingWAOutbox();
  for (const item of pending) {
    const conn = connections.get(item.business_id);
    if (!conn) continue;
    try {
      const jid = item.phone.includes('@s.whatsapp.net') ? item.phone : item.phone + '@s.whatsapp.net';
      await conn.sock.sendMessage(jid, { text: item.content });
      db.markWAOutboxSent(item.id);
    } catch (e) {
      console.error(`[bot] Outbox error: ${e.message}`);
    }
  }
}

function getConnection(businessId) {
  return connections.get(businessId) || null;
}

// Outbox processor every 2s
setInterval(processOutbox, 2000);

// Auto-restart connections on startup
function initAllConnections() {
  try {
    const { getWhatsAppConnection } = require('./database');
    const Database = require('better-sqlite3');
    const path = require('path');
    const d = new Database(process.env.DB_PATH || path.join(__dirname, 'data', 'panelcliente.db'));
    const all = d.prepare('SELECT * FROM whatsapp_connections WHERE status = ? OR status = ?').all('connected', 'connecting');
    d.close();
    for (const c of all) {
      console.log(`[bot] Restaurando conexión negocio ${c.business_id}...`);
      startConnection(c.business_id);
    }
  } catch (e) {
    console.log('[bot] Sin conexiones previas para restaurar');
  }
}

module.exports = { startConnection, startPairingConnection, stopConnection, getConnection, initAllConnections };
