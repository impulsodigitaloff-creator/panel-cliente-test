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

function isBusinessOpen(date, time) {
  const d = new Date(date + 'T' + time);
  const day = d.getDay(); // 0=domingo, 1=lunes, ..., 6=sábado
  if (day === 0) return false;
  const [h, m] = time.split(':').map(Number);
  const minutes = h * 60 + m;
  const open = 9 * 60 + 30;  // 9:30
  const close = 20 * 60;     // 20:00
  return minutes >= open && minutes < close;
}

function formatDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const dias = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
  const meses = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  return `${dias[date.getDay()]} ${d} de ${meses[date.getMonth()]} de ${y}`;
}

function isSlotOccupied(businessId, date, time) {
  const existing = db.prepare("SELECT id FROM appointments WHERE business_id = ? AND date = ? AND time = ? AND status IN ('pending','confirmed')").get(businessId, date, time);
  return !!existing;
}

function findAvailableSlots(businessId, date, count = 3) {
  const slots = [];
  const d = new Date(date + 'T00:00');
  if (d.getDay() === 0) return slots;
  const open = 9 * 60 + 30;
  const close = 20 * 60;
  for (let minutes = open; minutes < close; minutes += 30) {
    const h = Math.floor(minutes / 60).toString().padStart(2, '0');
    const m = (minutes % 60).toString().padStart(2, '0');
    const time = `${h}:${m}`;
    if (!isSlotOccupied(businessId, date, time)) {
      slots.push({ date, time });
      if (slots.length >= count) break;
    }
  }
  return slots;
}

function getNextAvailableSlots(businessId, fromDate, fromTime, count = 3) {
  const slots = [];
  let currentDate = new Date(fromDate + 'T' + fromTime);
  // Empezar desde el siguiente slot de 30 min
  currentDate.setMinutes(currentDate.getMinutes() + 30);
  while (slots.length < count) {
    const y = currentDate.getFullYear();
    const m = (currentDate.getMonth() + 1).toString().padStart(2, '0');
    const d = currentDate.getDate().toString().padStart(2, '0');
    const dateStr = `${y}-${m}-${d}`;
    const h = currentDate.getHours().toString().padStart(2, '0');
    const min = currentDate.getMinutes().toString().padStart(2, '0');
    const timeStr = `${h}:${min}`;
    if (isBusinessOpen(dateStr, timeStr) && !isSlotOccupied(businessId, dateStr, timeStr)) {
      slots.push({ date: dateStr, time: timeStr });
    }
    currentDate.setMinutes(currentDate.getMinutes() + 30);
  }
  return slots;
}

function formatConfirmation(result, biz) {
  const address = (biz && biz.address) ? biz.address : 'Mendoza Sur 340, J5402GUH, San Juan, Argentina';
  const mapsLink = 'https://maps.google.com/?q=Mendoza+Sur+340+J5402GUH+San+Juan+Argentina';
  return `✅ ¡Turno confirmado, ${result.nombre || 'Cliente'}!

✂️ Servicio: ${result.servicio || 'Servicio'}
🗓️ Fecha: ${formatDate(result.fecha)}
🕐 Hora: ${result.hora}
📍 Dirección: ${address}
🌎 Google Maps: ${mapsLink}

Si necesitás cancelar o reprogramar, respondé por WhatsApp y te ayudamos. 🙌`;
}

function formatAlternatives(args, slots) {
  if (!slots || slots.length === 0) {
    return '😊 No encontré horarios disponibles próximos. Escribime otra fecha/hora y te confirmo.';
  }
  const list = slots.map((s, i) => `${i + 1}. ${formatDate(s.date)} a las ${s.time}`).join('\n');
  return `😊 Disculpá, el horario del ${formatDate(args.fecha)} a las ${args.hora} no está disponible.

Te ofrezco estas alternativas:\n${list}\n\n¿Alguno te sirve?`;
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
- Horarios de atención: Lunes a Sábados 9:30-20:00, Domingos cerrado
`;
  }

  const address = (biz && biz.address) ? biz.address : 'Mendoza Sur 340, J5402GUH, San Juan, Argentina';
  const mapsLink = 'https://maps.google.com/?q=Mendoza+Sur+340+J5402GUH+San+Juan+Argentina';
  return `
Sos la asistente virtual de "${bizName}", una peluquería/barbería/estética en San Juan. Respondé en español, tono cálido, profesional y amable. Usá emojis con moderación ✨.

Tu rol: sos recepcionista y asesora. Ayudás al cliente a agendar turnos y resolver dudas.
${bizInfo}
Reglas CRÍTICAS:
- Horarios de atención: Lunes a Sábados de 9:30 a 20:00 hs. Domingos CERRADO.
- SOLO ofrecé horarios disponibles entre 9:30 y 20:00 de lunes a sábado. NUNCA sugieras horarios fuera de ese rango ni domingos.
- Si el cliente pide un horario fuera de atención (ej: a las 21:00, 08:00 o domingo), respondé amablemente que el negocio está cerrado y ofrecé el siguiente horario disponible dentro del horario de atención.
- Si el cliente pide un horario ocupado, ofrecé automáticamente las alternativas más cercanas disponibles.
- NUNCA digas "no tengo ese servicio" o "no tengo X en mi lista". Si el cliente pide algo que no está literalmente en la lista, IGUAL agendá el turno con lo que pidió. Anotá el servicio como el cliente lo dijo.
- Si el cliente pide algo específico (ej: "corte adulto", "corte hombre", "rayitos"), aceptalo y pedí los datos para el turno: nombre, fecha, hora. No cuestiones si lo hacemos o no.
- Si el cliente no sabe qué quiere, RECOMENDÁ de la lista los servicios que más le convengan según lo que cuenta.
- Si el cliente dice "quiero cortarme el pelo", pedí nombre y hora, y agendá "Corte" como servicio.
- Si pide hablar con un humano/asesor, dale el teléfono: ${biz && (biz.human_phone || biz.phone) ? (biz.human_phone || biz.phone) : 'consultar'} 📞
- Si pide la ubicación, dale la dirección: ${address} y el link: ${mapsLink} 📍
- Si pide el Instagram, dale: ${biz && biz.instagram ? biz.instagram : 'consultar'} 📷
- Si pregunta horarios, dale: Lunes a Sábados 9:30-20:00, Domingos cerrado 🕐
- Mensajes breves, cordiales y claros, 2 a 4 líneas.
- Al iniciar la conversación: "¡Hola! Bienvenido/a 😊 ¿En qué puedo ayudarte hoy?"
- Si no podés resolver algo: "Perdón, déjame derivarte con un asesor 🙏"
- Cuando confirmes un turno, INCLUÍ siempre: fecha, hora, servicio, nombre del cliente, dirección (${address}) y el mensaje de que puede cancelar/reprogramar por WhatsApp.
- REGLA DE AGENDADO: cuando ya tengas el nombre, fecha y hora del cliente dentro del horario de atención, agregá al final de tu mensaje EXACTAMENTE esta línea (sin decirle al cliente que lo estás agregando):\n[AGENDAR nombre=NOMBRE fecha=YYYY-MM-DD hora=HH:MM servicio=SERVICIO]

Ejemplo: si el cliente es Augusto, pide corte para mañana 20/07 a las 11:30, tu mensaje termina con:\n[AGENDAR nombre=Augusto fecha=2026-07-20 hora=11:30 servicio=Corte]

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
    const biz = db.getBusinessById(businessId);
    // Validar horario de atención
    if (!isBusinessOpen(args.fecha, args.hora)) {
      const alternatives = getNextAvailableSlots(businessId, args.fecha, args.hora, 3);
      return { success: false, reason: 'closed', message: 'Fuera de horario de atención (Lunes a Sábados 9:30-20:00)', alternatives, args };
    }
    // Validar que no esté ocupado
    if (isSlotOccupied(businessId, args.fecha, args.hora)) {
      const alternatives = getNextAvailableSlots(businessId, args.fecha, args.hora, 3);
      return { success: false, reason: 'occupied', message: 'Horario ocupado', alternatives, args };
    }
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
    const result = { success: true, message: 'Turno creado exitosamente', nombre: args.nombre, fecha: args.fecha, hora: args.hora, servicio: args.servicio };
    result.confirmationText = formatConfirmation(result, biz);
    return result;
  } catch (e) {
    console.error('[bot] Error creando turno:', e.message);
    return { success: false, message: e.message, args };
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
      const conv = db.getOrCreateWACoversation(businessId, phone, pushName, msg.key.remoteJid);
      db.insertWAMessage(conv.id, 'user', text);
      console.log(`[bot] ← ${phone}: ${text.slice(0, 60)}`);
      if (conv.mode === 'HUMAN') continue;
      const history = db.getRecentWAHistory(conv.id, 20);
      let reply = await callLLM(history, businessId, phone, pushName);

      // Detectar y ejecutar agendado
      const agendaMatch = reply.match(/\[AGENDAR\s+([^\]]+)\]/);
      if (agendaMatch) {
        const args = Object.fromEntries(agendaMatch[1].trim().split(/\s+/).map(p => p.split('=')));
        if (args.nombre && args.fecha && args.hora && args.servicio) {
          const result = createAppointmentFromAI(businessId, args, phone, pushName);
          if (result.success && result.confirmationText) {
            reply = result.confirmationText;
          } else if (result.alternatives) {
            reply = formatAlternatives(result.args || args, result.alternatives);
          } else {
            reply = reply.replace(agendaMatch[0], '').trim() + ' (Perdón, hubo un error al guardar el turno. Te llamamos para confirmar 🙏)';
          }
        }
      }

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
      const conv = db.getOrCreateWACoversation(businessId, phone, pushName, msg.key.remoteJid);
      db.insertWAMessage(conv.id, 'user', text);
      console.log(`[bot] ← ${phone}: ${text.slice(0, 60)}`);
      if (conv.mode === 'HUMAN') continue;
      const history = db.getRecentWAHistory(conv.id, 20);
      let reply = await callLLM(history, businessId, phone, pushName);

      // Detectar y ejecutar agendado
      const agendaMatch = reply.match(/\[AGENDAR\s+([^\]]+)\]/);
      if (agendaMatch) {
        const args = Object.fromEntries(agendaMatch[1].trim().split(/\s+/).map(p => p.split('=')));
        if (args.nombre && args.fecha && args.hora && args.servicio) {
          const result = createAppointmentFromAI(businessId, args, phone, pushName);
          if (result.success && result.confirmationText) {
            reply = result.confirmationText;
          } else if (result.alternatives) {
            reply = formatAlternatives(result.args || args, result.alternatives);
          } else {
            reply = reply.replace(agendaMatch[0], '').trim() + ' (Perdón, hubo un error al guardar el turno. Te llamamos para confirmar 🙏)';
          }
        }
      }

      db.insertWAMessage(conv.id, 'assistant', reply);
      try {
        await conn.sock.sendMessage(msg.key.remoteJid, { text: reply });
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
      const conv = db.prepare('SELECT remote_jid FROM wa_conversations WHERE id = ?').get(item.conversation_id);
      const jid = (conv && conv.remote_jid) || (item.phone.includes('@') ? item.phone : item.phone + '@s.whatsapp.net');
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
function getCustomerJid(customerPhone, customerId) {
  // Si el cliente tiene una conversación de WA, usar ese remote_jid
  if (customerId) {
    const conv = db.prepare('SELECT remote_jid FROM wa_conversations WHERE phone = ? ORDER BY id DESC LIMIT 1').get(customerPhone);
    if (conv && conv.remote_jid) return conv.remote_jid;
  }
  if (!customerPhone) return null;
  const clean = customerPhone.replace(/[^0-9]/g, '');
  if (!clean) return null;
  if (/^\d{13,}$/.test(clean)) return `${clean}@lid`;
  return `${clean}@s.whatsapp.net`;
}

async function processReminders() {
  try {
    const Database = require('better-sqlite3');
    const path = require('path');
    const d = new Database(process.env.DB_PATH || path.join(__dirname, 'data', 'panelcliente.db'));
    const businesses = d.prepare('SELECT id, name, phone FROM businesses WHERE active = 1').all();
    for (const biz of businesses) {
      const conn = connections.get(biz.id);
      if (!conn) continue;

      // Confirmación a clientes y al negocio
      const mapsLink = 'https://maps.google.com/?q=Mendoza+Sur+340+J5402GUH+San+Juan+Argentina';
      const address = biz.address || 'Mendoza Sur 340, J5402GUH, San Juan, Argentina';
      const confirmations = d.prepare(`
        SELECT a.*, c.name as customer_name, c.phone as customer_phone,
               s.name as service_name, e.name as employee_name
        FROM appointments a
        LEFT JOIN customers c ON a.customer_id = c.id
        LEFT JOIN services s ON a.service_id = s.id
        LEFT JOIN employees e ON a.employee_id = e.id
        WHERE a.business_id = ? AND a.status IN ('pending','confirmed') AND a.customer_confirmation_sent = 0
      `).all(biz.id);
      for (const appt of confirmations) {
        const jid = getCustomerJid(appt.customer_phone, appt.customer_id);
        if (jid) {
          const msg = `✅ ¡Hola ${appt.customer_name || ''}! Tu turno quedó confirmado:\n\n✂️ ${appt.service_name || 'Servicio'}\n🗓️ ${appt.date}\n🕐 ${appt.time}${appt.employee_name ? '\n💅 ' + appt.employee_name : ''}\n📍 ${address}\n🌎 ${mapsLink}\n\nSi necesitás cancelar o reprogramar, respondé por WhatsApp y te ayudamos. 🙌\n\nNos vemos en ${biz.name} 😊`;
          try {
            await conn.sock.sendMessage(jid, { text: msg });
            console.log(`[reminder] Confirmación turno ${appt.id} enviada a cliente`);
          } catch (e) { console.error('[reminder] Error confirmación cliente:', e.message); }
        }
        // Confirmación al negocio
        const bizJid = biz.phone.includes('@') ? biz.phone : (biz.phone ? biz.phone + '@s.whatsapp.net' : null);
        if (bizJid) {
          const msgBiz = `✅ Nuevo turno agendado\n\n👤 ${appt.customer_name || 'Cliente'}\n✂️ ${appt.service_name || 'Servicio'}\n🗓️ ${appt.date}\n🕐 ${appt.time}${appt.employee_name ? '\n💅 ' + appt.employee_name : ''}\n📞 ${appt.customer_phone || 'sin teléfono'}`;
          try {
            await conn.sock.sendMessage(bizJid, { text: msgBiz });
            console.log(`[reminder] Confirmación turno ${appt.id} enviada a negocio`);
          } catch (e) { console.error('[reminder] Error confirmación negocio:', e.message); }
        }
        d.prepare('UPDATE appointments SET customer_confirmation_sent = 1 WHERE id = ?').run(appt.id);
      }

      // Recordatorio 1 día antes al cliente y al negocio
      const reminders1d = d.prepare(`
        SELECT a.*, c.name as customer_name, c.phone as customer_phone,
               s.name as service_name, e.name as employee_name
        FROM appointments a
        LEFT JOIN customers c ON a.customer_id = c.id
        LEFT JOIN services s ON a.service_id = s.id
        LEFT JOIN employees e ON a.employee_id = e.id
        WHERE a.business_id = ? AND a.status IN ('pending','confirmed')
          AND a.customer_reminder_1d_sent = 0
          AND a.date = date('now','-3 hours','+1 day')
      `).all(biz.id);
      for (const appt of reminders1d) {
        const jid = getCustomerJid(appt.customer_phone, appt.customer_id);
        if (jid) {
          const msg = `📅 Recordatorio de turno\n\nHola ${appt.customer_name || ''}, te recordamos tu turno de mañana:\n\n✂️ ${appt.service_name || 'Servicio'}\n🕐 ${appt.time}${appt.employee_name ? '\n💅 ' + appt.employee_name : ''}\n📍 ${address}\n🌎 ${mapsLink}\n\nSi necesitás cancelar o reprogramar, respondé por WhatsApp. Te esperamos 😊`;
          try {
            await conn.sock.sendMessage(jid, { text: msg });
            console.log(`[reminder] 1 día turno ${appt.id} enviado a cliente`);
          } catch (e) { console.error('[reminder] Error 1d cliente:', e.message); }
        }
        const bizJid = biz.phone.includes('@') ? biz.phone : (biz.phone ? biz.phone + '@s.whatsapp.net' : null);
        if (bizJid) {
          const msgBiz = `📅 Recordatorio de turno mañana\n\n👤 ${appt.customer_name || 'Cliente'}\n✂️ ${appt.service_name || 'Servicio'}\n🗓️ ${appt.date}\n🕐 ${appt.time}${appt.employee_name ? '\n💅 ' + appt.employee_name : ''}\n📞 ${appt.customer_phone || 'sin teléfono'}`;
          try {
            await conn.sock.sendMessage(bizJid, { text: msgBiz });
            console.log(`[reminder] 1 día turno ${appt.id} enviado a negocio`);
          } catch (e) { console.error('[reminder] Error 1d negocio:', e.message); }
        }
        d.prepare('UPDATE appointments SET customer_reminder_1d_sent = 1 WHERE id = ?').run(appt.id);
      }

      // Recordatorio 1 hora antes al cliente y al negocio
      const reminders1h = d.prepare(`
        SELECT a.*, c.name as customer_name, c.phone as customer_phone,
               s.name as service_name, e.name as employee_name
        FROM appointments a
        LEFT JOIN customers c ON a.customer_id = c.id
        LEFT JOIN services s ON a.service_id = s.id
        LEFT JOIN employees e ON a.employee_id = e.id
        WHERE a.business_id = ? AND a.status IN ('pending','confirmed')
          AND a.customer_reminder_1h_sent = 0
          AND a.date = date('now','-3 hours')
          AND a.time <= time('now','-3 hours','+1 hour')
          AND a.time > time('now','-3 hours')
      `).all(biz.id);
      for (const appt of reminders1h) {
        const jid = getCustomerJid(appt.customer_phone, appt.customer_id);
        if (jid) {
          const msg = `🔔 ¡Falta 1 hora!\n\nHola ${appt.customer_name || ''}, tu turno es hoy a las ${appt.time}:\n\n✂️ ${appt.service_name || 'Servicio'}${appt.employee_name ? '\n💅 ' + appt.employee_name : ''}\n📍 ${address}\n🌎 ${mapsLink}\n\nTe esperamos 🙌`;
          try {
            await conn.sock.sendMessage(jid, { text: msg });
            console.log(`[reminder] 1h turno ${appt.id} enviado a cliente`);
          } catch (e) { console.error('[reminder] Error 1h cliente:', e.message); }
        }
        const bizJid = biz.phone.includes('@') ? biz.phone : (biz.phone ? biz.phone + '@s.whatsapp.net' : null);
        if (bizJid) {
          const msgBiz = `🔔 ¡Falta 1 hora!\n\n👤 ${appt.customer_name || 'Cliente'}\n✂️ ${appt.service_name || 'Servicio'}\n🗓️ ${appt.date}\n🕐 ${appt.time}${appt.employee_name ? '\n💅 ' + appt.employee_name : ''}\n📞 ${appt.customer_phone || 'sin teléfono'}`;
          try {
            await conn.sock.sendMessage(bizJid, { text: msgBiz });
            console.log(`[reminder] 1h turno ${appt.id} enviado a negocio`);
          } catch (e) { console.error('[reminder] Error 1h negocio:', e.message); }
        }
        d.prepare('UPDATE appointments SET customer_reminder_1h_sent = 1, reminder_sent = 1 WHERE id = ?').run(appt.id);
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
