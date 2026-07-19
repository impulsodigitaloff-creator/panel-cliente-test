const { makeWASocket, fetchLatestBaileysVersion, useMultiFileAuthState, Browsers, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const db = require('./database');

const AUTH_DIR = process.env.AUTH_DIR || path.join(__dirname, 'data', 'auth');
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

const connections = new Map();

function getAuthPath(businessId) {
  const p = path.join(AUTH_DIR, `business_${businessId}`);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  return p;
}

function buildSystemPrompt(businessId) {
  const services = db.getServices(businessId);
  const employees = db.getEmployees(businessId);
  const biz = db.getBusinessById(businessId);
  const bizName = (biz && biz.name) ? biz.name : 'nuestro salón';
  let srvList = services.map(s => `  - ${s.name}: $${s.price} (${s.duration} min)`).join('\n') || '  (sin servicios cargados)';
  let empList = employees.map(e => `  - ${e.name}${e.phone ? ' ('+e.phone+')' : ''}`).join('\n') || '  (sin empleados cargados)';

  let bizInfo = '';
  if (biz) {
    bizInfo = `
Info del negocio (usá esto si el cliente pregunta):
- Dirección: ${biz.address || 'consultar'}
- Horarios: ${biz.hours || 'consultar'}
- Teléfono para hablar con un humano: ${biz.human_phone || biz.phone || 'consultar'}
- Email: ${biz.email || 'consultar'}
- Instagram: ${biz.instagram || 'consultar'}
`;
  }

  return `
Sos la asistente virtual de "${bizName}", una peluquería/barbería/estética en San Juan. Respondé en español, tono cálido, profesional y amable. Usá emojis con moderación ✨.

Tu rol: sos recepcionista y asesora. Ayudás al cliente a agendar turnos y resolver dudas.
${bizInfo}
Reglas CRÍTICAS:
- NUNCA digas "no tengo ese servicio" o "no tengo X en mi lista". Si el cliente pide algo que no está literalmente en la lista, IGUAL agendá el turno con lo que pidió. Anotá el servicio como el cliente lo dijo.
- Si el cliente pide algo específico (ej: "corte adulto", "corte hombre", "rayitos"), aceptalo y pedí los datos para el turno: nombre, fecha, hora. No cuestiones si lo hacemos o no.
- Si el cliente no sabe qué quiere, RECOMENDÁ de la lista los servicios que más le convengan según lo que cuenta.
- Si el cliente dice "quiero cortarme el pelo", pedí nombre y hora, y agendá "Corte" como servicio.
- Si dice para qué día/hora, confirmá el turno.
- Si pide hablar con un humano/asesor, dale el teléfono: ${biz && (biz.human_phone || biz.phone) ? (biz.human_phone || biz.phone) : 'consultar'} 📞
- Si pide la ubicación, dale la dirección: ${biz && biz.address ? biz.address : 'consultar'} 📍
- Si pide el Instagram, dale: ${biz && biz.instagram ? biz.instagram : 'consultar'} 📷
- Si pregunta horarios, dale: ${biz && biz.hours ? biz.hours : 'consultar'} 🕐
- Mensajes breves, 2 a 4 líneas.
- Al iniciar la conversación: "¡Hola! Bienvenido/a 😊 ¿En qué puedo ayudarte hoy?"
- Si no podés resolver algo: "Perdón, déjame derivarte con un asesor 🙏"

Servicios que ofrecemos (para recomendar si el cliente no sabe qué elegir):
${srvList}

Empleados:
${empList}
`.trim();
}

async function callLLM(history, businessId, phone, pushName) {
  if (!GROQ_API_KEY) return '⚠️ WhatsApp sin configurar. Contactá al administrador.';
  try {
    const messages = [
      { role: 'system', content: buildSystemPrompt(businessId) },
      ...history.map(m => ({
        role: m.role === 'user' ? 'user' : 'assistant',
        content: m.content
      }))
    ];
    const tools = [
      {
        type: 'function',
        function: {
          name: 'crear_turno',
          description: 'Crear un turno en el sistema. Llamar esta función SOLO cuando tengas nombre del cliente, fecha y hora confirmados.',
          parameters: {
            type: 'object',
            properties: {
              nombre: { type: 'string', description: 'Nombre del cliente' },
              fecha: { type: 'string', description: 'Fecha en formato YYYY-MM-DD' },
              hora: { type: 'string', description: 'Hora en formato HH:MM (24hs)' },
              servicio: { type: 'string', description: 'Nombre del servicio solicitado' }
            },
            required: ['nombre', 'fecha', 'hora', 'servicio']
          }
        }
      }
    ];
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages,
        tools,
        tool_choice: 'auto',
        temperature: 0.7,
        max_tokens: 400
      })
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Groq ${res.status}: ${errText.slice(0, 200)}`);
    }
    const data = await res.json();
    const choice = data.choices[0];
    // Si la IA llamó una función, ejecutarla
    if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
      for (const tc of choice.message.tool_calls) {
        if (tc.function.name === 'crear_turno') {
          const args = JSON.parse(tc.function.arguments);
          const result = createAppointmentFromAI(businessId, args, phone, pushName);
          // Mandar una segunda llamada para que la IA confirme
          messages.push(choice.message);
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify(result)
          });
          const res2 = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${GROQ_API_KEY}`
            },
            body: JSON.stringify({
              model: GROQ_MODEL,
              messages,
              temperature: 0.7,
              max_tokens: 300
            })
          });
          if (res2.ok) {
            const data2 = await res2.json();
            return data2.choices[0].message.content.trim();
          }
          return '✅ Turno agendado. Te esperamos!';
        }
      }
    }
    return choice.message.content.trim();
  } catch (err) {
    console.error('[bot] LLM error:', err.message);
    return 'Ocurrió un error. Déjame derivarte con un asesor humano.';
  }
}

function createAppointmentFromAI(businessId, args, phone, pushName) {
  try {
    // Buscar o crear cliente por phone
    let customer = db.prepare('SELECT id FROM customers WHERE business_id = ? AND phone = ?').get(businessId, phone);
    if (!customer) {
      const r = db.prepare('INSERT INTO customers (business_id, name, phone) VALUES (?, ?, ?)').run(businessId, args.nombre || pushName || phone, phone);
      customer = { id: r.lastInsertRowid };
    }
    // Buscar servicio por nombre (match parcial)
    let service = db.prepare('SELECT id FROM services WHERE business_id = ? AND name LIKE ?').get(businessId, '%' + args.servicio + '%');
    if (!service) {
      service = db.prepare('SELECT id FROM services WHERE business_id = ? AND name LIKE ?').get(businessId, '%' + args.servicio.slice(0, 5) + '%');
    }
    // Crear el turno
    db.prepare('INSERT INTO appointments (business_id, customer_id, date, time, status, notes, service_id) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      businessId,
      customer.id,
      args.fecha,
      args.hora,
      'confirmed',
      'Agendado por IA WhatsApp',
      service ? service.id : null
    );
    console.log(`[bot] Turno creado: ${args.nombre} - ${args.servicio} - ${args.fecha} ${args.hora}`);
    return { success: true, message: 'Turno creado exitosamente', nombre: args.nombre, fecha: args.fecha, hora: args.hora, servicio: args.servicio };
  } catch (e) {
    console.error('[bot] Error creando turno:', e.message);
    return { success: false, message: e.message };
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
      try {
        const biz = db.getBusinessById(businessId);
        if (biz && biz.name) {
          await sock.updateProfileName(biz.name);
          console.log(`[bot] Perfil actualizado: ${biz.name}`);
        }
      } catch (e) { console.log('[bot] No se pudo actualizar perfil:', e.message); }
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
      db.insertWAMessage(conv.id, 'user', text);
      console.log(`[bot] ← ${phone}: ${text.slice(0, 60)}`);
      if (conv.mode === 'HUMAN') continue;
      const history = db.getRecentWAHistory(conv.id, 20);
      const reply = await callLLM(history, businessId, phone, pushName);
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
      try {
        const biz = db.getBusinessById(businessId);
        if (biz && biz.name) {
          await sock.updateProfileName(biz.name);
          console.log(`[bot] Perfil actualizado: ${biz.name}`);
        }
      } catch (e) { console.log('[bot] No se pudo actualizar perfil:', e.message); }
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
      db.insertWAMessage(conv.id, 'user', text);
      console.log(`[bot] ← ${phone}: ${text.slice(0, 60)}`);
      if (conv.mode === 'HUMAN') continue;
      const history = db.getRecentWAHistory(conv.id, 20);
      const reply = await callLLM(history, businessId, phone, pushName);
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
      const jid = item.phone.includes('@') ? item.phone : item.phone + '@s.whatsapp.net';
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

// Reminder processor every 60s - manda recordatorio al negocio 1h antes del turno
async function processReminders() {
  try {
    const bizList = db.prepare ? null : null;
    const Database = require('better-sqlite3');
    const path = require('path');
    const d = new Database(process.env.DB_PATH || path.join(__dirname, 'data', 'panelcliente.db'));
    const businesses = d.prepare('SELECT id, name, phone FROM businesses WHERE active = 1').all();
    for (const biz of businesses) {
      const upcoming = d.prepare(`
        SELECT a.*, c.name as customer_name, c.phone as customer_phone,
               s.name as service_name, e.name as employee_name
        FROM appointments a
        LEFT JOIN customers c ON a.customer_id = c.id
        LEFT JOIN services s ON a.service_id = s.id
        LEFT JOIN employees e ON a.employee_id = e.id
        WHERE a.business_id = ? AND a.date = date('now','-3 hours')
          AND a.time <= time('now','-3 hours','+1 hour')
          AND a.time > time('now','-3 hours')
          AND a.status IN ('pending','confirmed') AND a.reminder_sent = 0
        ORDER BY a.time
      `).all(biz.id);
      if (upcoming.length === 0) continue;
      const conn = connections.get(biz.id);
      if (!conn) continue;
      const bizPhone = biz.phone || '';
      const jid = bizPhone.includes('@') ? bizPhone : (bizPhone ? bizPhone + '@s.whatsapp.net' : null);
      if (!jid) continue;
      for (const appt of upcoming) {
        const msg = `🔔 Recordatorio de turno\n\n👤 ${appt.customer_name || 'Cliente'}\n✂️ ${appt.service_name || 'Servicio'}\n🕐 ${appt.time}${appt.employee_name ? '\n💅 ' + appt.employee_name : ''}\n📞 ${appt.customer_phone || 'sin teléfono'}\n\n¡Falta 1 hora!`;
        try {
          await conn.sock.sendMessage(jid, { text: msg });
          d.prepare('UPDATE appointments SET reminder_sent = 1 WHERE id = ?').run(appt.id);
          console.log(`[reminder] Turno ${appt.id} recordado a ${biz.name}`);
        } catch (e) {
          console.error('[reminder] Error:', e.message);
        }
      }
    }
    d.close();
  } catch (e) {
    console.error('[reminder] Error general:', e.message);
  }
}
setInterval(processReminders, 60000);

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
