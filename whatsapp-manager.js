const { makeWASocket, fetchLatestBaileysVersion, useMultiFileAuthState, Browsers, DisconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const os = require('os');
const db = require('./database');
const OpenAI = require('openai');
const { GoogleGenAI } = require('@google/genai');

const AUTH_DIR = process.env.AUTH_DIR || path.join(__dirname, 'data', 'auth');
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-1.5-flash';
const gemini = GEMINI_API_KEY ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : null;
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

// Configuración de transcripción de voz (Groq Whisper por defecto, OpenAI opcional)
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const WHISPER_MODEL = process.env.WHISPER_MODEL || (OPENAI_API_KEY ? 'whisper-1' : 'whisper-large-v3-turbo');
let openai = null;
if (OPENAI_API_KEY) {
  openai = new OpenAI({ apiKey: OPENAI_API_KEY, timeout: 30000 });
} else if (GROQ_API_KEY) {
  openai = new OpenAI({ apiKey: GROQ_API_KEY, baseURL: 'https://api.groq.com/openai/v1', timeout: 30000 });
}
const VOICE_ENABLED = !!openai;
const MAX_VOICE_SIZE_MB = 25;

const connections = new Map();
const llmLocks = new Map(); // businessId -> Promise

function getAuthPath(businessId) {
  const p = path.join(AUTH_DIR, `business_${businessId}`);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  return p;
}

function parseArgentinaDate(date, time) {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  return new Date(Date.UTC(y, m - 1, d, hh + 3, mm));
}

function isBusinessOpen(date, time) {
  const d = parseArgentinaDate(date, time);
  const day = d.getUTCDay();
  if (day === 0) return false;
  const [h, m] = time.split(':').map(Number);
  const minutes = h * 60 + m;
  const open = 9 * 60 + 30;
  const close = 20 * 60;
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
  const biz = db.getBusinessById(businessId);
  const services = db.getServices(businessId);
  const employees = db.getEmployees(businessId);
  const bizName = (biz && biz.name) ? biz.name : 'nuestro salón';
  let srvList = services.map(s => {
    const desc = getServiceDescription(s.name);
    return `  - ${s.name}: desde $${s.price} (${s.duration} min) — ${desc}`;
  }).join('\n') || '  (sin servicios cargados)';
  let empList = employees.map(e => `  - ${e.name}${e.phone ? ' ('+e.phone+')' : ''}`).join('\n') || '  (sin empleados cargados)';

  const address = (biz && biz.address) ? biz.address : 'Mendoza Sur 340, J5402GUH, San Juan, Argentina';
  const mapsLink = 'https://maps.google.com/?q=Mendoza+Sur+340+J5402GUH+San+Juan+Argentina';
  const phone = biz && (biz.human_phone || biz.phone) ? (biz.human_phone || biz.phone) : 'consultar';
  const instagram = biz && biz.instagram ? biz.instagram : 'consultar';
  const promo = biz && biz.promo ? biz.promo : '';
  const defaultPrompt = `
Sos la asistente de "${bizName}". Asesorá con tono cálido, profesional y breve (2-4 líneas, emojis moderados ✨).
Tu objetivo: entender qué necesita el cliente, recomendar el servicio correcto de la lista y agendar turno.

Info del negocio:
- Dirección: ${address}
- Mapa: ${mapsLink}
- Horarios: Lunes a Sábados 9:30-20:00, Domingos cerrado
- Teléfono humano: ${phone}
- Instagram: ${instagram}
${promo ? '\nPromociones vigentes:\n' + promo : ''}

Flujo de atención:
1. Saludá y preguntá qué busca el cliente.
2. Hacé preguntas UNA A UNA según la necesidad.
3. Recomendá 1-2 servicios de la lista explicando brevemente por qué.
4. Cuando hables de precios, SIEMPRE decí "desde $X" o "aproximadamente $X", NUNCA un número exacto. Ej: "desde $7000" en vez de "$7000".
5. Para agendar, pedí nombre, fecha y hora. Solo ofrecé horarios de lunes a sábado 9:30-20:00.

Reglas CRÍTICAS:
- NUNCA inventes servicios, precios o tratamientos. Usá EXACTAMENTE la lista de abajo.
- NUNCA digas un precio exacto. Siempre decí "desde" o "aproximadamente". Ej: "Corte desde $7000".
- NO preguntes si hay disponibilidad. Si el horario está dentro del horario de atención (Lunes a Sábados 9:30-20:00), podés confirmar y agendar directamente.
- Si el horario está fuera del horario de atención, ofrecé alternativas cercanas disponibles.
- Si el cliente pide un horario y está dentro del horario de atención, decí "perfecto, te agendo" y usá la línea de agendado.
- Si no podés resolver algo: "Perdón, déjame derivarte con un asesor 🙏"
- Si pide hablar con un humano: ${phone} 📞
- Si pide la ubicación: ${address} (${mapsLink}) 📍
- Cuando confirmes un turno NUEVO, INCLUÍ siempre: fecha, hora, servicio, nombre del cliente, dirección y que puede cancelar/reprogramar por WhatsApp.
- REGLA DE AGENDADO:apenas tengas TODOS los datos (nombre, fecha, hora y servicio), agregá al final de tu mensaje EXACTAMENTE esta línea oculta:\n[AGENDAR nombre=NOMBRE fecha=YYYY-MM-DD hora=HH:MM servicio=SERVICIO]\nNo hace falta pedir teléfono, se usa el de WhatsApp automáticamente.
- NUNCA agregues la línea [AGENDAR ...] si te falta algún dato. Primero preguntá lo que falta.
- NUNCA hables de turnos PASADOS ni digas "recordá que tenés un turno". Si el cliente ya tuvo un turno, no lo menciones a menos que el cliente pregunte explícitamente por él.
- NUNCA inventes turnos existentes. No digas frases como "recuerda que tu turno es el día..." porque eso confunde al cliente. Cada nuevo mensaje es una NUEVA consulta.

Ejemplo cuando ya tenés todo: [AGENDAR nombre=Augusto fecha=2026-07-20 hora=11:30 servicio=Corte]

Servicios disponibles (solo de esta lista):
${srvList}

Empleados:
${empList}
`.trim();
  // Si hay prompt personalizado, usarlo pero siempre con la lista real de servicios
  if (biz && biz.custom_prompt && biz.custom_prompt.trim()) {
    return biz.custom_prompt.trim() + '\n\nServicios disponibles (precios reales):\n' + srvList;
  }
  return defaultPrompt;
}

async function callGemini(systemPrompt, history) {
  let contents = history
    .filter(m => m.content && m.content.trim())
    .map(m => ({
      role: m.role === 'user' ? 'user' : 'model',
      parts: [{ text: m.content.trim() }]
    }));

  // Gemini exige que el primer mensaje sea del usuario
  if (contents.length > 0 && contents[0].role !== 'user') {
    contents.shift();
  }
  if (contents.length === 0) {
    contents = [{ role: 'user', parts: [{ text: 'Hola' }] }];
  }

  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const result = await gemini.models.generateContent({
        model: GEMINI_MODEL,
        contents,
        config: {
          systemInstruction: systemPrompt,
          temperature: 0.7,
          maxOutputTokens: 500
        }
      });
      if (!result || !result.text) throw new Error('Respuesta vacía de Gemini');
      return result.text.trim();
    } catch (err) {
      lastErr = err.message;
      console.warn(`[bot] Gemini error (intento ${attempt + 1}/3): ${lastErr}`);
      if (attempt < 2) {
        await new Promise(r => setTimeout(r, (attempt + 1) * 3000));
      }
    }
  }
  throw new Error(lastErr);
}

async function callGroq(systemPrompt, history) {
  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.map(m => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: m.content
    }))
  ];

  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
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
          max_tokens: 500
        })
      });
      if (res.status === 429) {
        const errText = await res.text();
        lastErr = `Groq 429: ${errText.slice(0, 200)}`;
        console.warn(`[bot] Groq rate limit (intento ${attempt + 1}/3), esperando ${(attempt + 1) * 15}s...`);
        await new Promise(r => setTimeout(r, (attempt + 1) * 15000));
        continue;
      }
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Groq ${res.status}: ${errText.slice(0, 200)}`);
      }
      const data = await res.json();
      const choice = data.choices[0];
      return choice.message.content.trim();
    } catch (err) {
      lastErr = err.message;
      if (attempt < 2) {
        await new Promise(r => setTimeout(r, (attempt + 1) * 15000));
      }
    }
  }
  throw new Error(lastErr);
}

async function callLLM(history, businessId, phone, pushName) {
  let resolveLock, rejectLock;
  try {
    // Serialize LLM calls per business to avoid spikes
    while (llmLocks.has(businessId)) {
      try { await llmLocks.get(businessId); } catch (e) { /* ignore */ }
    }
    const lockPromise = new Promise((res, rej) => { resolveLock = res; rejectLock = rej; });
    llmLocks.set(businessId, lockPromise);

    const systemPrompt = buildSystemPrompt(businessId);

    // Usar Groq primero (más rápido, menos rate limiting)
    if (GROQ_API_KEY) {
      try {
        return await callGroq(systemPrompt, history);
      } catch (err) {
        console.warn('[bot] Groq falló, intentando Gemini como fallback:', err.message);
      }
    }

    // Fallback a Gemini
    if (gemini) {
      try {
        return await callGemini(systemPrompt, history);
      } catch (err) {
        console.error('[bot] Gemini también falló:', err.message);
      }
    }

    return '⚠️ WhatsApp sin configurar. Contactá al administrador.';
  } finally {
    if (resolveLock) resolveLock();
    llmLocks.delete(businessId);
  }
}

function createAppointmentFromAI(businessId, args, phone, pushName) {
  try {
    const biz = db.getBusinessById(businessId);
    if (!args || !args.fecha || !args.hora || !args.nombre || !args.servicio) {
      return { success: false, message: 'Faltan datos para agendar el turno' };
    }
    // Rechazar valores placeholder que la IA pone cuando todavía no tiene los datos
    const ph = (v) => /^(NOMBRE|TELEFONO|YYYY-MM-DD|HH:MM|SERVICIO|XXXXXX)$/i.test(v);
    if (ph(args.nombre) || ph(args.fecha) || ph(args.hora) || ph(args.servicio) || (args.telefono && ph(args.telefono))) {
      return { success: false, reason: 'placeholder', message: 'Faltan datos reales del cliente' };
    }
    if (!validateDate(args.fecha) || !validateTime(args.hora)) {
      return { success: false, message: 'Fecha u hora inválidas', args };
    }
    // Validar que no sea en el pasado (usando Argentina UTC-3)
    const dt = parseArgentinaDate(args.fecha, args.hora);
    if (isNaN(dt.getTime()) || dt.getTime() <= Date.now()) {
      return { success: false, reason: 'past', message: 'No se pueden agendar turnos en el pasado. Pedile al cliente una fecha y hora futura.', args };
    }
    // Validar horario de atención
    if (!isBusinessOpen(args.fecha, args.hora)) {
      const alternatives = getNextAvailableSlots(businessId, args.fecha, args.hora, 3);
      return { success: false, reason: 'closed', message: 'Fuera de horario de atención (Lunes a Sábados 9:30-20:00)', alternatives, args };
    }
    // Validar que no esté ocupado
    if (isSlotOccupied(businessId, args.fecha, args.hora) || db.isAppointmentSlotOccupied(businessId, args.fecha, args.hora)) {
      const alternatives = getNextAvailableSlots(businessId, args.fecha, args.hora, 3);
      return { success: false, reason: 'occupied', message: 'Horario ocupado', alternatives, args };
    }
    // Usar teléfono del cliente si lo dió, sino el de WhatsApp
    const customerPhone = args.telefono || phone;
    // Buscar o crear cliente por phone
    let customer = db.prepare('SELECT id FROM customers WHERE business_id = ? AND phone = ?').get(businessId, customerPhone);
    if (!customer) {
      const r = db.prepare('INSERT INTO customers (business_id, name, phone) VALUES (?, ?, ?)').run(businessId, args.nombre || pushName || customerPhone, customerPhone);
      customer = { id: r.lastInsertRowid };
    }
    // Buscar servicio por nombre (match parcial)
    let service = db.prepare('SELECT id FROM services WHERE business_id = ? AND name LIKE ?').get(businessId, '%' + args.servicio + '%');
    if (!service) {
      const short = args.servicio.slice(0, 5);
      service = db.prepare('SELECT id FROM services WHERE business_id = ? AND name LIKE ?').get(businessId, '%' + short + '%');
    }
    // Crear el turno
    db.createAppointment({
      business_id: businessId,
      customer_id: customer.id,
      service_id: service ? service.id : null,
      employee_id: null,
      date: args.fecha,
      time: args.hora,
      status: 'confirmed',
      notes: 'Agendado por IA WhatsApp'
    });
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

async function transcribeAudioBuffer(buffer, businessId, phone) {
  if (!openai) throw new Error('OpenAI no configurado');
  if (buffer.length > MAX_VOICE_SIZE_MB * 1024 * 1024) {
    throw new Error(`Audio demasiado grande (${(buffer.length / 1024 / 1024).toFixed(1)} MB > ${MAX_VOICE_SIZE_MB} MB)`);
  }
  const tmpPath = path.join(os.tmpdir(), `voice_${businessId}_${phone}_${Date.now()}.ogg`);
  fs.writeFileSync(tmpPath, buffer);
  try {
    const result = await openai.audio.transcriptions.create({
      file: fs.createReadStream(tmpPath),
      model: WHISPER_MODEL,
      language: 'es',
      response_format: 'json'
    });
    return result.text ? result.text.trim() : '';
  } finally {
    try { fs.unlinkSync(tmpPath); } catch (e) {}
  }
}

async function extractMessageText(sock, msg, businessId, phone) {
  const textMsg = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
  if (textMsg) return { text: textMsg, isVoice: false };

  const audioMsg = msg.message?.audioMessage || msg.message?.pttMessage;
  if (audioMsg) {
    if (!VOICE_ENABLED || !openai) {
      return { text: null, isVoice: true, error: 'voice_not_configured' };
    }
    console.log(`[bot] Audio recibido de ${phone}, descargando...`);
    const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
    console.log(`[bot] Audio descargado: ${buffer.length} bytes`);
    const text = await transcribeAudioBuffer(buffer, businessId, phone);
    console.log(`[bot] Audio transcrito: ${text.slice(0, 80)}...`);
    return { text, isVoice: true };
  }

  return { text: null, isVoice: false };
}

async function handleIncomingMessage(sock, msg, businessId) {
  if (msg.key.fromMe) return;
  if (msg.key.remoteJid?.includes('@g.us')) return;
  const isWA = msg.key.remoteJid?.includes('@s.whatsapp.net') || msg.key.remoteJid?.includes('@lid');
  if (!isWA) return;
  const phone = msg.key.remoteJid.split('@')[0];
  const pushName = msg.pushName || '';
  console.log(`[bot] msg: fromMe=${msg.key.fromMe}, jid=${msg.key.remoteJid}, msgType=${msg.message ? Object.keys(msg.message).join(',') : 'EMPTY'}`);
  console.log(`[bot] msg raw: ${JSON.stringify(msg.message).slice(0,300)}`);

  let extracted;
  try {
    extracted = await extractMessageText(sock, msg, businessId, phone);
  } catch (err) {
    console.error(`[bot] Error procesando audio de ${phone}:`, err.message);
    await sock.sendMessage(msg.key.remoteJid, { text: 'Perdón, no pude entender el audio. ¿Podés enviarlo de nuevo o escribirme el mensaje? 🙏' });
    return;
  }

  if (extracted.error === 'voice_not_configured') {
    console.log(`[bot] Audio recibido de ${phone} pero no hay proveedor de transcripción configurado`);
    await sock.sendMessage(msg.key.remoteJid, { text: 'Perdón, todavía no puedo escuchar audios. Escribime el mensaje por favor 🙏' });
    return;
  }

  const text = extracted.text;
  if (!text) return;
  const isVoice = extracted.isVoice;

  const conv = db.getOrCreateWACoversation(businessId, phone, pushName, msg.key.remoteJid);
  db.insertWAMessage(conv.id, 'user', text);
  console.log(`[bot] ← ${phone}: ${isVoice ? '[🎙️ audio] ' : ''}${text.slice(0, 80)}`);
  if (conv.mode === 'HUMAN') return;
  const history = db.getRecentWAHistory(conv.id, 20);
  let reply = await callLLM(history, businessId, phone, pushName);

  // Detectar y ejecutar agendado
  const agendaMatch = parseAgendarTag(reply);
  if (!agendaMatch && reply.includes('Turno confirmado')) {
    console.log(`[bot] ⚠️ AI dijo "Turno confirmado" pero sin tag [AGENDAR...] — respuesta raw: ${reply.slice(0, 200)}`);
  }
  if (agendaMatch) {
    const args = agendaMatch;
    if (args.nombre && args.fecha && args.hora && args.servicio) {
      const result = createAppointmentFromAI(businessId, args, phone, pushName);
      if (result.success && result.confirmationText) {
        reply = result.confirmationText;
      } else if (result.reason === 'placeholder') {
        // La IA preguntaba datos todavía, mostrar su mensaje original sin el tag
        reply = reply.replace(agendaMatch.original, '').trim();
      } else if (result.alternatives) {
        reply = formatAlternatives(result.args || args, result.alternatives);
      } else {
        reply = reply.replace(agendaMatch.original, '').trim() + ' (Perdón, hubo un error al guardar el turno. Te llamamos para confirmar 🙏)';
      }
    } else {
      reply = reply.replace(agendaMatch.original, '').trim();
    }
  }

  db.insertWAMessage(conv.id, 'assistant', reply);
  try {
    await sock.sendMessage(msg.key.remoteJid, { text: reply });
    console.log(`[bot] → ${phone}: ${reply.slice(0, 80)}`);
  } catch (err) {
    console.error(`[bot] Error enviando a ${phone}:`, err.message);
    db.enqueueWAOutbox(conv.id, businessId, msg.key.remoteJid, reply);
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
        await handleIncomingMessage(sock, msg, businessId);
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
  const keys = ['nombre', 'telefono', 'fecha', 'hora', 'servicio'];
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
        await handleIncomingMessage(sock, msg, businessId);
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
      const address = biz.address || 'Mendoza Sur 340, J5402GUH, San Juan, Argentina';
      const mapsLink = 'https://maps.google.com/?q=' + encodeURIComponent(address);
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
