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

function getServiceDescription(name) {
  const desc = {
    'Corte hombre o niño': 'Corte y estilizado para hombres o niños. Ideal para mantener el pelo en forma y fresco.',
    'Corte mujer': 'Corte personalizado según el rostro y estilo. Incluye lavado y secado para un resultado prolijo.',
    'Brushing': 'Lavado + cepillado con secador para dejar el cabello liso, brillante y sin frizz. Ideal para el día a día.',
    'Peinado semirecogido': 'Peinado elegante con parte del cabello recogido. Ideal para eventos, fiestas o casamientos.',
    'Peinado recogido completo': 'Todo el cabello recogido en un moño o trenza. Ideal para bodas, fiestas de 15 o eventos formales.',
    'Peinado novia/madrina/egresada': 'Peinado sofisticado y duradero para ocasiones especiales. Look impecable durante horas.',
    'Trenzados laterales': 'Trenzas decorativas a los costados. Ideal para looks románticos, festivos o informales.',
    'Semitrenzado': 'Mitad del cabello trenzado y mitad suelto. Look moderno, femenino y versátil.',
    'Trenzado completo': 'Todo el cabello trenzado. Ideal para eventos, deportes o looks prácticos y ordenados.',
    'Lavado de cabello (incluye secado en máquina)': 'Lavado profesional con productos específicos y secado en máquina. Ideal para mantener la higiene y el cabello suelto.',
    'Aplicación de color/hena (incluye secado en máquina)': 'Aplicación de color o hena natural. Ideal para matizar, cubrir canas o dar reflejos.',
    'Color raíz o crecimiento': 'Tinte solo en la raíz para cubrir crecimiento o canas. Ideal para mantener el color sin teñir todo el cabello.',
    'Coloración nacional': 'Tinte completo con coloración nacional. Ideal para cambios de color o cubrir canas de forma económica.',
    'Coloración importada': 'Tinte completo con coloración importada de mejor calidad. Ideal para colores más vibrantes, duraderos y cuidados.',
    'Mechas o babylights': 'Mechas finas y naturales que iluminan el cabello. Ideal para dar luz y movimiento sin un cambio drástico.',
    'Balayage': 'Técnica de mechas a mano alzada para un efecto degradado natural. Ideal para un look moderno y luminoso.',
    'Mechón contorno': 'Mechas en el contorno del rostro para iluminar. Ideal para resaltar facciones.',
    'Barrido de color': 'Técnica que aclara o cambia el color en las puntas. Ideal para transiciones suaves.',
    'Decoloración global': 'Decoloración de todo el cabello para rubios o colores fantasía. Ideal para cambios radicales.',
    'Ondulación permanente': 'Proceso químico para crear ondas o rizos permanentes. Ideal para quienes quieren volumen y textura constante.',
    'Hidratación': 'Tratamiento superficial que devuelve humedad al cabello. Ideal para pelo seco o apagado.',
    'Nutrición ácida/argán/biotina': 'Tratamiento profundo con activos que reparan y nutren. Ideal para cabello seco, sin brillo o con frizz.',
    'Ampolla reestructurante': 'Tratamiento intensivo para reconstruir la fibra capilar. Ideal para cabello muy dañado por químicas o calor.',
    'Alisado': 'Alisado permanente o semipermanente para eliminar el frizz y dejar el pelo liso. Ideal para quienes quieren facilidad de peinado.',
    'Keratina/botox': 'Tratamiento con keratina o botox capilar que alisa, hidrata y reduce el volumen. Ideal para cabello rebelde o con frizz.',
    'Tratamiento matizador violeta o azul': 'Tratamiento con pigmentos violetas o azules para neutralizar tonos amarillos/naranjas. Ideal para rubios o decolorados.',
    'Tratamiento caída de cabello (por sesión)': 'Tratamiento específico para fortalecer el cabello y reducir la caída. Ideal para cabellos débiles o con pérdida de densidad.'
  };
  return desc[name] || 'Servicio profesional disponible en el salón. Te explico más si querés.';
}

function buildSystemPrompt(businessId) {
  const services = db.getServices(businessId);
  const employees = db.getEmployees(businessId);
  const biz = db.getBusinessById(businessId);
  const bizName = (biz && biz.name) ? biz.name : 'nuestro salón';
  let srvList = services.map(s => {
    const desc = getServiceDescription(s.name);
    return `  - ${s.name}: $${s.price} (${s.duration} min) — ${desc}`;
  }).join('\n') || '  (sin servicios cargados)';
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
Sos una estilista profesional y asesora de "${bizName}". Tu trabajo NO es solo dar precios: sos una consultora de belleza capilar. Respondé en español, tono cálido, profesional, amable y cercano. Usá emojis con moderación ✨.

Tu rol: entender la necesidad del cliente, recomendarle el mejor servicio, explicarle por qué y recién después mostrar precio y agendar turno.
${bizInfo}
FLUJO DE ATENCIÓN OBLIGATORIO:
1. SALUDO: "¡Hola! Soy la asistente de ${bizName}. Contame, ¿qué te gustaría lograr con tu cabello hoy? ¿Buscás un cambio, mantenimiento o reparación? 😊"
2. DIAGNÓSTICO: Antes de recomendar, hacé preguntas UNA A UNA para entender:
   - ¿Qué problema o deseo tiene? (seco, dañado, frizz, sin brillo, cambio de color, cubrir raíces, etc.)
   - ¿El cabello está teñido o es natural?
   - ¿Hace cuánto se hizo un color/tratamiento?
   - ¿Qué resultado espera?
   - ¿Tiene alguna alergia o sensibilidad en el cuero cabelludo?
   NO hagas todas las preguntas de golpe. Adaptate a la conversación.
3. RECOMENDACIÓN: Con la info suficiente, recomendá 1 o 2 servicios de la lista EXPLICANDO:
   - Para qué sirve.
   - Qué beneficios trae.
   - En qué casos se recomienda.
   - Por qué se ajusta a lo que el cliente contó.
4. PRECIO: Mostrá el precio real de la base de datos SOLO cuando el cliente lo pida o cuando ya esté de acuerdo con la recomendación.
5. COMPLEMENTARIOS: Si aplica, sugerí tratamientos complementarios explicando el motivo, pero sin insistir ni presionar.
6. RESERVA: Solo cuando el cliente confirme que quiere el servicio, pedí nombre, fecha y hora para agendar el turno.

Reglas CRÍTICAS:
- NUNCA inventes servicios, tratamientos o precios. Usá EXACTAMENTE los que están en la lista de la base de datos.
- NUNCA respondas solo con un precio. Siempre acompañá con una breve explicación profesional.
- Si el cliente no sabe qué necesita, hacéle preguntas de diagnóstico antes de recomendar.
- Si el cliente dice "mi pelo está seco/sin brillo", recomendá hidratación o nutrición explicando por qué.
- Si el cliente dice "mi pelo está muy dañado", recomendá ampolla reestructurante o keratina/botox.
- Si el cliente dice "quiero cambiar de color", preguntá si busca cubrir canas, reflejos, mechas o un cambio total, y luego recomendá el servicio adecuado.
- Si el cliente dice "quiero cortarme el pelo", preguntá si es corte de mujer o hombre/niño y luego agendá el correcto.
- Horarios de atención: Lunes a Sábados de 9:30 a 20:00 hs. Domingos CERRADO.
- SOLO ofrecé horarios disponibles entre 9:30 y 20:00 de lunes a sábado. NUNCA sugieras horarios fuera de ese rango ni domingos.
- Si el cliente pide un horario fuera de atención u ocupado, respondé amablemente y ofrecé las alternativas más cercanas disponibles.
- Si pide hablar con un humano/asesor, dale el teléfono: ${biz && (biz.human_phone || biz.phone) ? (biz.human_phone || biz.phone) : 'consultar'} 📞
- Si pide la ubicación, dale la dirección: ${address} y el link: ${mapsLink} 📍
- Si pide el Instagram, dale: ${biz && biz.instagram ? biz.instagram : 'consultar'} 📷
- Si pregunta horarios, dale: Lunes a Sábados 9:30-20:00, Domingos cerrado 🕐
- Mensajes breves, cordiales y claros, 2 a 4 líneas. Nunca saturés al cliente.
- Si no podés resolver algo: "Perdón, déjame derivarte con un asesor 🙏"
- Cuando confirmes un turno, INCLUÍ siempre: fecha, hora, servicio, nombre del cliente, dirección (${address}) y el mensaje de que puede cancelar/reprogramar por WhatsApp.
- REGLA DE AGENDADO: cuando ya tengas el nombre, fecha y hora del cliente dentro del horario de atención, agregá al final de tu mensaje EXACTAMENTE esta línea (sin decirle al cliente que lo estás agregando):\n[AGENDAR nombre=NOMBRE fecha=YYYY-MM-DD hora=HH:MM servicio=SERVICIO]

Ejemplo: si el cliente es Augusto, pide corte para mañana 20/07 a las 11:30, tu mensaje termina con:\n[AGENDAR nombre=Augusto fecha=2026-07-20 hora=11:30 servicio=Corte]

Servicios disponibles en la base de datos (recomendá SOLO de esta lista):
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
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages,
        temperature: 0.7,
        max_tokens: 600
      })
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Groq ${res.status}: ${errText.slice(0, 200)}`);
    }
    const data = await res.json();
    const choice = data.choices[0];
    return choice.message.content.trim();
  } catch (err) {
    console.error('[bot] LLM error:', err.message);
    return 'Ocurrió un error. Déjame derivarte con un asesor humano.';
  }
}

function createAppointmentFromAI(businessId, args, phone, pushName) {
  try {
    const biz = db.getBusinessById(businessId);
    if (!args || !args.fecha || !args.hora || !args.nombre || !args.servicio) {
      return { success: false, message: 'Faltan datos para agendar el turno' };
    }
    if (!validateDate(args.fecha) || !validateTime(args.hora)) {
      return { success: false, message: 'Fecha u hora inválidas', args };
    }
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
      const short = args.servicio.slice(0, 5);
      service = db.prepare('SELECT id FROM services WHERE business_id = ? AND name LIKE ?').get(businessId, '%' + short + '%');
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

function validateDate(date) {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && !isNaN(Date.parse(date));
}

function validateTime(time) {
  if (!/^\d{2}:\d{2}$/.test(time)) return false;
  const [h, m] = time.split(':').map(Number);
  return h >= 0 && h <= 23 && m >= 0 && m <= 59;
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
        if (conn.reconnectTimer) clearTimeout(conn.reconnectTimer);
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
      try {
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
        const agendaMatch = parseAgendarTag(reply);
        if (agendaMatch) {
          const args = agendaMatch;
          if (args.nombre && args.fecha && args.hora && args.servicio) {
            const result = createAppointmentFromAI(businessId, args, phone, pushName);
            if (result.success && result.confirmationText) {
              reply = result.confirmationText;
            } else if (result.alternatives) {
              reply = formatAlternatives(result.args || args, result.alternatives);
            } else {
              reply = reply.replace(agendaMatch.original, '').trim() + ' (Perdón, hubo un error al guardar el turno. Te llamamos para confirmar 🙏)';
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
      } catch (err) {
        console.error(`[bot] Error procesando mensaje:`, err.message);
      }
    }
  });

  return sock;
}

function parseAgendarTag(text) {
  const match = text.match(/\[AGENDAR\s+([^\]]+)\]/);
  if (!match) return null;
  const inner = match[1].trim();
  const keys = ['nombre', 'fecha', 'hora', 'servicio'];
  const result = { original: match[0] };
  let remaining = inner;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const nextKey = keys[i + 1];
    const regex = nextKey
      ? new RegExp(`${key}=(.*?)(?=\\s+${nextKey}=)`)
      : new RegExp(`${key}=(.*)`);
    const m = remaining.match(regex);
    if (m) {
      result[key] = m[1].trim();
      remaining = remaining.replace(m[0], '').trim();
    }
  }
  if (!result.nombre || !result.fecha || !result.hora || !result.servicio) return null;
  return result;
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
        if (conn.reconnectTimer) clearTimeout(conn.reconnectTimer);
        conn.reconnectTimer = setTimeout(() => startPairingConnection(businessId), code === 440 ? 15000 : 5000);
        connections.set(businessId, conn);
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      try {
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
        const agendaMatch = parseAgendarTag(reply);
        if (agendaMatch) {
          const args = agendaMatch;
          if (args.nombre && args.fecha && args.hora && args.servicio) {
            const result = createAppointmentFromAI(businessId, args, phone, pushName);
            if (result.success && result.confirmationText) {
              reply = result.confirmationText;
            } else if (result.alternatives) {
              reply = formatAlternatives(result.args || args, result.alternatives);
            } else {
              reply = reply.replace(agendaMatch.original, '').trim() + ' (Perdón, hubo un error al guardar el turno. Te llamamos para confirmar 🙏)';
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
      } catch (err) {
        console.error(`[bot] Error procesando mensaje:`, err.message);
      }
    }
  });

  return sock;
}

function stopConnection(businessId) {
  if (connections.has(businessId)) {
    const conn = connections.get(businessId);
    if (conn.reconnectTimer) clearTimeout(conn.reconnectTimer);
    conn.reconnectTimer = null;
    try { conn.sock.end(undefined); } catch (e) {}
    connections.delete(businessId);
  }
  db.upsertWhatsAppConnection({ business_id: businessId, status: 'disconnected', qr_string: '', phone: '' });
}

function stopAllConnections() {
  for (const [businessId, conn] of connections.entries()) {
    if (conn.reconnectTimer) clearTimeout(conn.reconnectTimer);
    conn.reconnectTimer = null;
    try { conn.sock.end(undefined); } catch (e) {}
    connections.delete(businessId);
  }
  if (outboxInterval) clearInterval(outboxInterval);
  if (reminderInterval) clearInterval(reminderInterval);
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

let outboxInterval = setInterval(processOutbox, 2000);

// Reminder processor every 60s - manda recordatorio al negocio 1h antes del turno
function getCustomerJid(customerPhone, customerId, businessId) {
  // Si el cliente tiene una conversación de WA del mismo negocio, usar ese remote_jid
  if (customerId && businessId) {
    const conv = db.prepare('SELECT remote_jid FROM wa_conversations WHERE business_id = ? AND phone = ? ORDER BY id DESC LIMIT 1').get(businessId, customerPhone);
    if (conv && conv.remote_jid) return conv.remote_jid;
  } else if (customerId) {
    const conv = db.prepare('SELECT remote_jid FROM wa_conversations WHERE phone = ? ORDER BY id DESC LIMIT 1').get(customerPhone);
    if (conv && conv.remote_jid) return conv.remote_jid;
  }
  if (!customerPhone) return null;
  const clean = customerPhone.replace(/[^0-9]/g, '');
  if (!clean) return null;
  if (/^\d{13,}$/.test(clean)) return `${clean}@lid`;
  return `${clean}@s.whatsapp.net`;
}

const reminderLocks = new Set();

async function processReminders() {
  try {
    const d = db;
    const businesses = d.prepare('SELECT id, name, phone FROM businesses WHERE active = 1').all();
    for (const biz of businesses) {
      const conn = connections.get(biz.id);
      if (!conn) continue;
      const mapsLink = 'https://maps.google.com/?q=Mendoza+Sur+340+J5402GUH+San+Juan+Argentina';
      const address = biz.address || 'Mendoza Sur 340, J5402GUH, San Juan, Argentina';
      const bizJid = biz.phone.includes('@') ? biz.phone : (biz.phone ? biz.phone + '@s.whatsapp.net' : null);

      async function sendReminder(appt, type, clientMsg, bizMsg) {
        if (reminderLocks.has(appt.id)) return;
        reminderLocks.add(appt.id);
        try {
        const jid = getCustomerJid(appt.customer_phone, appt.customer_id, biz.id);
        if (jid && clientMsg) {
            try {
              await conn.sock.sendMessage(jid, { text: clientMsg });
              console.log(`[reminder] ${type} turno ${appt.id} enviado a cliente`);
            } catch (e) { console.error(`[reminder] Error ${type} cliente:`, e.message); }
          }
          if (bizJid && bizMsg) {
            try {
              await conn.sock.sendMessage(bizJid, { text: bizMsg });
              console.log(`[reminder] ${type} turno ${appt.id} enviado a negocio`);
            } catch (e) { console.error(`[reminder] Error ${type} negocio:`, e.message); }
          }
        } finally {
          reminderLocks.delete(appt.id);
        }
      }

      // Confirmación a clientes y al negocio
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
        const clientMsg = `✅ ¡Hola ${appt.customer_name || ''}! Tu turno quedó confirmado:\n\n✂️ ${appt.service_name || 'Servicio'}\n🗓️ ${appt.date}\n🕐 ${appt.time}${appt.employee_name ? '\n💅 ' + appt.employee_name : ''}\n📍 ${address}\n🌎 ${mapsLink}\n\nSi necesitás cancelar o reprogramar, respondé por WhatsApp y te ayudamos. 🙌\n\nNos vemos en ${biz.name} 😊`;
        const bizMsg = `✅ Nuevo turno agendado\n\n👤 ${appt.customer_name || 'Cliente'}\n✂️ ${appt.service_name || 'Servicio'}\n🗓️ ${appt.date}\n🕐 ${appt.time}${appt.employee_name ? '\n💅 ' + appt.employee_name : ''}\n📞 ${appt.customer_phone || 'sin teléfono'}`;
        await sendReminder(appt, 'confirmación', clientMsg, bizMsg);
        d.prepare('UPDATE appointments SET customer_confirmation_sent = 1 WHERE id = ?').run(appt.id);
      }

      // Recordatorio 1 día antes
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
        const clientMsg = `📅 Recordatorio de turno\n\nHola ${appt.customer_name || ''}, te recordamos tu turno de mañana:\n\n✂️ ${appt.service_name || 'Servicio'}\n🕐 ${appt.time}${appt.employee_name ? '\n💅 ' + appt.employee_name : ''}\n📍 ${address}\n🌎 ${mapsLink}\n\nSi necesitás cancelar o reprogramar, respondé por WhatsApp. Te esperamos 😊`;
        const bizMsg = `📅 Recordatorio de turno mañana\n\n👤 ${appt.customer_name || 'Cliente'}\n✂️ ${appt.service_name || 'Servicio'}\n🗓️ ${appt.date}\n🕐 ${appt.time}${appt.employee_name ? '\n💅 ' + appt.employee_name : ''}\n📞 ${appt.customer_phone || 'sin teléfono'}`;
        await sendReminder(appt, '1d', clientMsg, bizMsg);
        d.prepare('UPDATE appointments SET customer_reminder_1d_sent = 1 WHERE id = ?').run(appt.id);
      }

      // Recordatorio 1 hora antes
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
        const clientMsg = `🔔 ¡Falta 1 hora!\n\nHola ${appt.customer_name || ''}, tu turno es hoy a las ${appt.time}:\n\n✂️ ${appt.service_name || 'Servicio'}${appt.employee_name ? '\n💅 ' + appt.employee_name : ''}\n📍 ${address}\n🌎 ${mapsLink}\n\nTe esperamos 🙌`;
        const bizMsg = `🔔 ¡Falta 1 hora!\n\n👤 ${appt.customer_name || 'Cliente'}\n✂️ ${appt.service_name || 'Servicio'}\n🗓️ ${appt.date}\n🕐 ${appt.time}${appt.employee_name ? '\n💅 ' + appt.employee_name : ''}\n📞 ${appt.customer_phone || 'sin teléfono'}`;
        await sendReminder(appt, '1h', clientMsg, bizMsg);
        d.prepare('UPDATE appointments SET customer_reminder_1h_sent = 1, reminder_sent = 1 WHERE id = ?').run(appt.id);
      }
    }
  } catch (e) {
    console.error('[reminder] Error general:', e.message);
  }
}
let reminderInterval = setInterval(processReminders, 60000);

// Auto-restart connections on startup
function initAllConnections() {
  try {
    const all = db.prepare('SELECT * FROM whatsapp_connections WHERE status = ? OR status = ?').all('connected', 'connecting');
    for (const c of all) {
      console.log(`[bot] Restaurando conexión negocio ${c.business_id}...`);
      startConnection(c.business_id);
    }
  } catch (e) {
    console.log('[bot] Sin conexiones previas para restaurar');
  }
}

module.exports = { startConnection, startPairingConnection, stopConnection, stopAllConnections, getConnection, initAllConnections };
