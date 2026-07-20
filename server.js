require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const path = require('path');
const crypto = require('crypto');
const db = require('./database');
const wa = require('./whatsapp-manager');

const app = express();
const PORT = process.env.PORT || 3001;
const isProduction = process.env.NODE_ENV === 'production';

// Validación de variables críticas
const requiredEnv = ['SESSION_SECRET', 'PANEL_API_KEY'];
for (const key of requiredEnv) {
  if (!process.env[key]) {
    console.error(`[server] FATAL: ${key} no está configurado. El servidor no puede iniciar.`);
    process.exit(1);
  }
}

const AUTOLOGIN_SECRET = process.env.AUTOLOGIN_SECRET || process.env.PANEL_API_KEY;

function verifyAutoLoginToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  try {
    const expected = crypto.createHmac('sha256', AUTOLOGIN_SECRET).update(payload).digest('base64url');
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (!data.email || !data.exp || data.exp < Date.now()) return null;
    return data.email;
  } catch (e) {
    return null;
  }
}

app.set('trust proxy', ['loopback', 'linklocal']);

// Security headers básicos
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  next();
});

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// CORS for CRM
const allowedOrigins = process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : ['http://localhost:3000'];
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const sessionSecret = process.env.SESSION_SECRET;

app.use(session({
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: isProduction,
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000
  },
  name: 'pc.sid',
  proxy: isProduction
}));

function requireAuth(req, res, next) {
  if (!req.session.businessId) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  next();
}

function requireMasterKey(req, res, next) {
  const key = req.headers['x-api-key'];
  if (!key || key !== process.env.PANEL_API_KEY) {
    return res.status(401).json({ error: 'API key inválida' });
  }
  next();
}

function validateId(param) {
  const id = parseInt(param, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function validateEmail(email) {
  if (typeof email !== 'string') return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

function validateDate(date) {
  if (typeof date !== 'string') return false;
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && !isNaN(Date.parse(date));
}

function validateTime(time) {
  if (typeof time !== 'string') return false;
  if (!/^\d{2}:\d{2}$/.test(time)) return false;
  const [h, m] = time.split(':').map(Number);
  return h >= 0 && h <= 23 && m >= 0 && m <= 59;
}

function isFutureDateTime(date, time) {
  const dt = new Date(`${date}T${time}`);
  return !isNaN(dt.getTime()) && dt.getTime() > Date.now();
}

function validatePositiveNumber(n) {
  const num = Number(n);
  return Number.isFinite(num) && num >= 0;
}

function validateStatus(status) {
  return ['pending', 'confirmed', 'completed', 'cancelled'].includes(status);
}

function sanitizeString(str, maxLen = 500) {
  if (typeof str !== 'string') return '';
  return str.trim().slice(0, maxLen);
}

// Auth
const loginAttempts = new Map();
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email y contraseña requeridos' });
  }
  const cleanEmail = email.trim().toLowerCase();
  if (!validateEmail(cleanEmail)) {
    return res.status(400).json({ error: 'Email inválido' });
  }

  // Rate limiting básico por IP + email
  const key = `${req.ip || req.connection.remoteAddress}:${cleanEmail}`;
  const now = Date.now();
  const attempts = loginAttempts.get(key);
  if (attempts && now - attempts.last > LOGIN_WINDOW_MS) {
    loginAttempts.delete(key);
  }
  if (attempts && attempts.count >= MAX_LOGIN_ATTEMPTS && now - attempts.last < LOGIN_WINDOW_MS) {
    return res.status(429).json({ error: 'Demasiados intentos. Probá más tarde.' });
  }

  const business = db.getBusinessByEmail(cleanEmail);
  if (!business || !bcrypt.compareSync(password, business.password_hash)) {
    const current = loginAttempts.get(key) || { count: 0, first: now, last: now };
    if (now - current.last > LOGIN_WINDOW_MS) {
      current.count = 1;
      current.first = now;
    } else {
      current.count += 1;
    }
    current.last = now;
    loginAttempts.set(key, current);
    return res.status(401).json({ error: 'Credenciales inválidas' });
  }

  loginAttempts.delete(key);
  req.session.businessId = business.id;
  req.session.businessName = business.name;
  res.json({ success: true, business: { id: business.id, name: business.name } });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) return res.status(500).json({ error: 'Error al cerrar sesión' });
    res.clearCookie('pc.sid');
    res.json({ success: true });
  });
});

app.get('/api/session', (req, res) => {
  if (req.session.businessId) {
    res.json({ authenticated: true, business: { id: req.session.businessId, name: req.session.businessName } });
  } else {
    res.json({ authenticated: false });
  }
});

// Dashboard
app.get('/api/dashboard', requireAuth, (req, res) => {
  const stats = db.getDashboardStats(req.session.businessId);
  res.json(stats);
});

// Customers
app.get('/api/customers', requireAuth, (req, res) => {
  const { search } = req.query;
  if (search) return res.json(db.searchCustomers(req.session.businessId, search));
  res.json(db.getCustomers(req.session.businessId));
});

app.get('/api/customers/:id', requireAuth, (req, res) => {
  const c = db.getCustomerById(req.params.id);
  if (!c || c.business_id !== req.session.businessId) return res.status(404).json({ error: 'No encontrado' });
  const appointments = db.getAppointmentsByCustomer(c.id, req.session.businessId);
  const sales = db.getSalesByCustomer(c.id, req.session.businessId);
  res.json({ ...c, appointments, sales });
});

app.post('/api/customers', requireAuth, (req, res) => {
  const { name, phone, email, notes } = req.body;
  const cleanName = sanitizeString(name, 100);
  if (!cleanName) return res.status(400).json({ error: 'Nombre requerido' });
  const cleanEmail = email ? sanitizeString(email, 100).toLowerCase() : '';
  if (cleanEmail && !validateEmail(cleanEmail)) return res.status(400).json({ error: 'Email inválido' });
  const id = db.createCustomer({ business_id: req.session.businessId, name: cleanName, phone: sanitizeString(phone, 50), email: cleanEmail, notes: sanitizeString(notes, 1000) });
  res.json({ success: true, id });
});

app.put('/api/customers/:id', requireAuth, (req, res) => {
  const c = db.getCustomerById(req.params.id);
  if (!c || c.business_id !== req.session.businessId) return res.status(404).json({ error: 'No encontrado' });
  const { name, phone, email, notes } = req.body;
  const cleanName = sanitizeString(name, 100);
  if (!cleanName) return res.status(400).json({ error: 'Nombre requerido' });
  const cleanEmail = email ? sanitizeString(email, 100).toLowerCase() : '';
  if (cleanEmail && !validateEmail(cleanEmail)) return res.status(400).json({ error: 'Email inválido' });
  db.updateCustomer(req.params.id, { name: cleanName, phone: sanitizeString(phone, 50), email: cleanEmail, notes: sanitizeString(notes, 1000) });
  res.json({ success: true });
});

app.delete('/api/customers/:id', requireAuth, (req, res) => {
  const c = db.getCustomerById(req.params.id);
  if (!c || c.business_id !== req.session.businessId) return res.status(404).json({ error: 'No encontrado' });
  db.deleteCustomer(req.params.id);
  res.json({ success: true });
});

// Employees
app.get('/api/employees', requireAuth, (req, res) => {
  const { all } = req.query;
  if (all === '1') return res.json(db.getAllEmployees(req.session.businessId));
  res.json(db.getEmployees(req.session.businessId));
});

app.post('/api/employees', requireAuth, (req, res) => {
  const { name, phone } = req.body;
  const cleanName = sanitizeString(name, 100);
  if (!cleanName) return res.status(400).json({ error: 'Nombre requerido' });
  const id = db.createEmployee({ business_id: req.session.businessId, name: cleanName, phone: sanitizeString(phone, 50) });
  res.json({ success: true, id });
});

app.put('/api/employees/:id', requireAuth, (req, res) => {
  const id = validateId(req.params.id);
  if (!id) return res.status(400).json({ error: 'ID inválido' });
  const e = db.getEmployeeById(id, req.session.businessId);
  if (!e) return res.status(404).json({ error: 'No encontrado' });
  const { name, phone } = req.body;
  const cleanName = sanitizeString(name, 100);
  if (!cleanName) return res.status(400).json({ error: 'Nombre requerido' });
  db.updateEmployee(id, { name: cleanName, phone: sanitizeString(phone, 50) });
  res.json({ success: true });
});

app.delete('/api/employees/:id', requireAuth, (req, res) => {
  const id = validateId(req.params.id);
  if (!id) return res.status(400).json({ error: 'ID inválido' });
  const e = db.getEmployeeById(id, req.session.businessId);
  if (!e) return res.status(404).json({ error: 'No encontrado' });
  db.deleteEmployee(id);
  res.json({ success: true });
});

// Services
app.get('/api/services', requireAuth, (req, res) => {
  const { all } = req.query;
  if (all === '1') return res.json(db.getAllServices(req.session.businessId));
  res.json(db.getServices(req.session.businessId));
});

app.post('/api/services', requireAuth, (req, res) => {
  const { name, price, duration } = req.body;
  const cleanName = sanitizeString(name, 100);
  if (!cleanName) return res.status(400).json({ error: 'Nombre requerido' });
  if (!validatePositiveNumber(price)) return res.status(400).json({ error: 'Precio inválido' });
  const durationNum = parseInt(duration, 10);
  if (!Number.isInteger(durationNum) || durationNum <= 0) return res.status(400).json({ error: 'Duración inválida' });
  const id = db.createService({ business_id: req.session.businessId, name: cleanName, price, duration: durationNum });
  res.json({ success: true, id });
});

app.put('/api/services/:id', requireAuth, (req, res) => {
  const id = validateId(req.params.id);
  if (!id) return res.status(400).json({ error: 'ID inválido' });
  const s = db.getServiceById(id, req.session.businessId);
  if (!s) return res.status(404).json({ error: 'No encontrado' });
  const { name, price, duration } = req.body;
  const cleanName = sanitizeString(name, 100);
  if (!cleanName) return res.status(400).json({ error: 'Nombre requerido' });
  if (!validatePositiveNumber(price)) return res.status(400).json({ error: 'Precio inválido' });
  const durationNum = parseInt(duration, 10);
  if (!Number.isInteger(durationNum) || durationNum <= 0) return res.status(400).json({ error: 'Duración inválida' });
  db.updateService(id, { name: cleanName, price, duration: durationNum });
  res.json({ success: true });
});

app.delete('/api/services/:id', requireAuth, (req, res) => {
  const id = validateId(req.params.id);
  if (!id) return res.status(400).json({ error: 'ID inválido' });
  const s = db.getServiceById(id, req.session.businessId);
  if (!s) return res.status(404).json({ error: 'No encontrado' });
  db.deleteService(id);
  res.json({ success: true });
});

// Appointments
app.get('/api/appointments', requireAuth, (req, res) => {
  const { date } = req.query;
  if (date && !validateDate(date)) return res.status(400).json({ error: 'Fecha inválida' });
  res.json(db.getAppointments(req.session.businessId, date || null));
});

app.get('/api/appointments/:id', requireAuth, (req, res) => {
  const id = validateId(req.params.id);
  if (!id) return res.status(400).json({ error: 'ID inválido' });
  const a = db.getAppointmentById(id);
  if (!a || a.business_id !== req.session.businessId) return res.status(404).json({ error: 'No encontrado' });
  res.json(a);
});

app.post('/api/appointments', requireAuth, (req, res) => {
  const { customer_id, service_id, employee_id, date, time, status, notes } = req.body;
  const custId = validateId(customer_id);
  if (!custId) return res.status(400).json({ error: 'Cliente requerido' });
  if (!validateDate(date)) return res.status(400).json({ error: 'Fecha inválida' });
  if (!validateTime(time)) return res.status(400).json({ error: 'Hora inválida' });
  if (!isFutureDateTime(date, time)) return res.status(400).json({ error: 'No se pueden agendar turnos en el pasado' });
  if (!db.isBusinessOpen(date, time)) return res.status(400).json({ error: 'Horario fuera de atención. Lunes a Sábados 9:30-20:00' });

  const customer = db.getCustomerById(custId);
  if (!customer || customer.business_id !== req.session.businessId) return res.status(400).json({ error: 'Cliente inválido' });
  if (service_id) {
    const svc = db.getServiceById(parseInt(service_id, 10), req.session.businessId);
    if (!svc) return res.status(400).json({ error: 'Servicio inválido' });
  }
  if (employee_id) {
    const emp = db.getEmployeeById(parseInt(employee_id, 10), req.session.businessId);
    if (!emp) return res.status(400).json({ error: 'Empleado inválido' });
  }
  if (status && !validateStatus(status)) return res.status(400).json({ error: 'Estado inválido' });

  try {
    const id = db.createAppointment({ business_id: req.session.businessId, customer_id: custId, service_id: service_id ? parseInt(service_id, 10) : null, employee_id: employee_id ? parseInt(employee_id, 10) : null, date, time, status, notes: sanitizeString(notes, 1000) });
    res.json({ success: true, id });
  } catch (e) {
    return res.status(409).json({ error: e.message || 'Horario ocupado' });
  }
});

app.put('/api/appointments/:id', requireAuth, (req, res) => {
  const id = validateId(req.params.id);
  if (!id) return res.status(400).json({ error: 'ID inválido' });
  const a = db.getAppointmentById(id);
  if (!a || a.business_id !== req.session.businessId) return res.status(404).json({ error: 'No encontrado' });
  const { customer_id, service_id, employee_id, date, time, status, notes } = req.body;
  if (date && !validateDate(date)) return res.status(400).json({ error: 'Fecha inválida' });
  if (time && !validateTime(time)) return res.status(400).json({ error: 'Hora inválida' });
  if (date && time && !isFutureDateTime(date, time)) return res.status(400).json({ error: 'No se pueden agendar turnos en el pasado' });
  if (date && time && !db.isBusinessOpen(date, time)) return res.status(400).json({ error: 'Horario fuera de atención' });
  if (status && !validateStatus(status)) return res.status(400).json({ error: 'Estado inválido' });
  if (customer_id) {
    const customer = db.getCustomerById(validateId(customer_id));
    if (!customer || customer.business_id !== req.session.businessId) return res.status(400).json({ error: 'Cliente inválido' });
  }
  if (service_id) {
    const svc = db.getServiceById(parseInt(service_id, 10), req.session.businessId);
    if (!svc) return res.status(400).json({ error: 'Servicio inválido' });
  }
  if (employee_id) {
    const emp = db.getEmployeeById(parseInt(employee_id, 10), req.session.businessId);
    if (!emp) return res.status(400).json({ error: 'Empleado inválido' });
  }
  try {
    db.updateAppointment(id, { customer_id, service_id, employee_id, date, time, status, notes: sanitizeString(notes, 1000) });
    res.json({ success: true });
  } catch (e) {
    return res.status(409).json({ error: e.message || 'Horario ocupado' });
  }
});

app.patch('/api/appointments/:id/status', requireAuth, (req, res) => {
  const id = validateId(req.params.id);
  if (!id) return res.status(400).json({ error: 'ID inválido' });
  const a = db.getAppointmentById(id);
  if (!a || a.business_id !== req.session.businessId) return res.status(404).json({ error: 'No encontrado' });
  const status = req.body.status;
  if (!validateStatus(status)) return res.status(400).json({ error: 'Estado inválido' });
  const result = db.updateAppointmentStatus(id, status);
  if (result && result.error) return res.status(404).json({ error: result.error });
  if (result && result.saleCreated) {
    return res.json({ success: true, saleCreated: true, saleId: result.saleId, amount: result.amount, message: 'Venta generada automáticamente' });
  }
  if (result && result.saleRemoved) {
    return res.json({ success: true, saleRemoved: true, message: 'Venta eliminada por cambio de estado' });
  }
  res.json({ success: true });
});

app.delete('/api/appointments/:id', requireAuth, (req, res) => {
  const id = validateId(req.params.id);
  if (!id) return res.status(400).json({ error: 'ID inválido' });
  const a = db.getAppointmentById(id);
  if (!a || a.business_id !== req.session.businessId) return res.status(404).json({ error: 'No encontrado' });
  db.deleteAppointment(id, req.session.businessId);
  res.json({ success: true });
});

// Sales
app.get('/api/sales', requireAuth, (req, res) => {
  const { date } = req.query;
  if (date && !validateDate(date)) return res.status(400).json({ error: 'Fecha inválida' });
  res.json(db.getSales(req.session.businessId, date || null));
});

app.post('/api/sales', requireAuth, (req, res) => {
  const { customer_id, service_id, amount, payment_method, notes, date } = req.body;
  if (!validatePositiveNumber(amount)) return res.status(400).json({ error: 'Monto inválido' });
  if (!validateDate(date)) return res.status(400).json({ error: 'Fecha inválida' });
  const id = db.createSale({ business_id: req.session.businessId, customer_id: customer_id ? parseInt(customer_id, 10) : null, service_id: service_id ? parseInt(service_id, 10) : null, amount, payment_method: sanitizeString(payment_method, 50), notes: sanitizeString(notes, 1000), date });
  res.json({ success: true, id });
});

app.delete('/api/sales/:id', requireAuth, (req, res) => {
  const id = validateId(req.params.id);
  if (!id) return res.status(400).json({ error: 'ID inválido' });
  const s = db.getSaleById(id, req.session.businessId);
  if (!s) return res.status(404).json({ error: 'No encontrado' });
  db.deleteSale(id, req.session.businessId);
  res.json({ success: true });
});

// Master API (for CRM)
app.post('/api/businesses', requireMasterKey, (req, res) => {
  const { name, contact, phone, email, password } = req.body;
  const cleanName = sanitizeString(name, 100);
  const cleanEmail = sanitizeString(email, 100).toLowerCase();
  const cleanContact = sanitizeString(contact, 100);
  const cleanPhone = sanitizeString(phone, 50);
  if (!cleanName || !cleanEmail || !password) {
    return res.status(400).json({ error: 'Nombre, email y contraseña requeridos' });
  }
  if (!validateEmail(cleanEmail)) return res.status(400).json({ error: 'Email inválido' });
  if (password.length < 6) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
  const existing = db.getBusinessByEmail(cleanEmail);
  if (existing) return res.status(400).json({ error: 'Ya existe un negocio con ese email' });
  const id = db.createBusiness({ name: cleanName, contact: cleanContact, phone: cleanPhone, email: cleanEmail, password });
  res.json({ success: true, id, email: cleanEmail });
});

app.put('/api/businesses/:id', requireMasterKey, (req, res) => {
  const id = validateId(req.params.id);
  if (!id) return res.status(400).json({ error: 'ID inválido' });
  const business = db.getBusinessById(id);
  if (!business) return res.status(404).json({ error: 'Negocio no encontrado' });
  const { email, password } = req.body;
  if (email) {
    const cleanEmail = sanitizeString(email, 100).toLowerCase();
    if (!validateEmail(cleanEmail)) return res.status(400).json({ error: 'Email inválido' });
    const existing = db.getBusinessByEmail(cleanEmail);
    if (existing && existing.id !== business.id) return res.status(400).json({ error: 'El email ya está en uso' });
    db.updateBusinessEmail(business.id, cleanEmail);
  }
  if (password) {
    if (password.length < 6) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
    const hash = bcrypt.hashSync(password, 10);
    db.updateBusinessPassword(business.id, hash);
  }
  res.json({ success: true });
});

app.put('/api/businesses/:id/info', requireAuth, (req, res) => {
  if (req.session.businessId !== parseInt(req.params.id, 10)) {
    return res.status(403).json({ error: 'No autorizado' });
  }
  const { name, contact, phone, address, hours, instagram, human_phone } = req.body;
  const data = {
    name: name !== undefined ? sanitizeString(name, 100) : undefined,
    contact: contact !== undefined ? sanitizeString(contact, 100) : undefined,
    phone: phone !== undefined ? sanitizeString(phone, 50) : undefined,
    address: address !== undefined ? sanitizeString(address, 200) : undefined,
    hours: hours !== undefined ? sanitizeString(hours, 200) : undefined,
    instagram: instagram !== undefined ? sanitizeString(instagram, 100) : undefined,
    human_phone: human_phone !== undefined ? sanitizeString(human_phone, 50) : undefined
  };
  const filtered = Object.fromEntries(Object.entries(data).filter(([_, v]) => v !== undefined));
  if (Object.keys(filtered).length === 0) return res.status(400).json({ error: 'No hay datos para actualizar' });
  db.updateBusinessInfo(req.session.businessId, filtered);
  res.json({ success: true });
});

// Auto-login via POST (legacy, para compatibilidad con formularios antiguos)
app.post('/auto-login', (req, res) => {
  const email = req.body.email;
  const password = req.body.password;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email y contraseña requeridos' });
  }
  const cleanEmail = email.trim().toLowerCase();
  const business = db.getBusinessByEmail(cleanEmail);
  if (!business || !bcrypt.compareSync(password, business.password_hash)) {
    return res.status(401).json({ error: 'Credenciales inválidas' });
  }
  req.session.businessId = business.id;
  req.session.businessName = business.name;
  if (req.headers['content-type'] && req.headers['content-type'].includes('application/x-www-form-urlencoded')) {
    return res.redirect('/');
  }
  res.json({ success: true, redirect: '/' });
});

// Auto-login via token (seguro, usado desde el CRM)
app.get('/auto-login', (req, res) => {
  const email = verifyAutoLoginToken(req.query.token);
  if (!email) return res.status(401).send('Token inválido o expirado');
  const business = db.getBusinessByEmail(email.toLowerCase());
  if (!business) return res.status(401).send('Negocio no encontrado');
  req.session.businessId = business.id;
  req.session.businessName = business.name;
  res.redirect('/');
});

app.post('/api/businesses/setup', requireMasterKey, (req, res) => {
  const { name, contact, phone, email, password, employees, services } = req.body;
  const cleanName = sanitizeString(name, 100);
  const cleanEmail = sanitizeString(email, 100).toLowerCase();
  const cleanContact = sanitizeString(contact, 100);
  const cleanPhone = sanitizeString(phone, 50);
  if (!cleanName || !cleanEmail || !password) {
    return res.status(400).json({ error: 'Nombre, email y contraseña requeridos' });
  }
  if (!validateEmail(cleanEmail)) return res.status(400).json({ error: 'Email inválido' });
  if (password.length < 6) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
  const existing = db.getBusinessByEmail(cleanEmail);
  if (existing) return res.status(400).json({ error: 'Ya existe un negocio con ese email' });
  const id = db.createBusiness({ name: cleanName, contact: cleanContact, phone: cleanPhone, email: cleanEmail, password });
  if (Array.isArray(employees) && employees.length > 0) {
    for (const e of employees) {
      const ename = sanitizeString(e.name, 100);
      if (ename) db.createEmployee({ business_id: id, name: ename, phone: sanitizeString(e.phone, 50) || '' });
    }
  }
  if (Array.isArray(services) && services.length > 0) {
    for (const s of services) {
      const sname = sanitizeString(s.name, 100);
      if (sname && validatePositiveNumber(s.price)) {
        const dur = parseInt(s.duration, 10);
        db.createService({ business_id: id, name: sname, price: s.price, duration: Number.isInteger(dur) && dur > 0 ? dur : 30 });
      }
    }
  }
  res.json({ success: true, id, email: cleanEmail, employeesCount: (employees || []).length, servicesCount: (services || []).length });
});

// WhatsApp API
app.get('/api/whatsapp/status', requireAuth, (req, res) => {
  const conn = db.getWhatsAppConnection(req.session.businessId);
  res.json(conn || { status: 'disconnected', business_id: req.session.businessId });
});

app.post('/api/whatsapp/connect', requireAuth, async (req, res) => {
  try {
    db.upsertWhatsAppConnection({ business_id: req.session.businessId, status: 'connecting' });
    wa.startConnection(req.session.businessId).catch(err => console.error(err));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/whatsapp/pair', requireAuth, async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'Número de teléfono requerido' });
  const cleaned = phone.replace(/[^0-9]/g, '');
  if (cleaned.length < 10) return res.status(400).json({ error: 'Número inválido. Incluí código de área sin 15 ni 0' });
  try {
    db.upsertWhatsAppConnection({ business_id: req.session.businessId, status: 'pairing_wait', qr_string: '' });
    wa.startPairingConnection(req.session.businessId, cleaned).catch(err => console.error(err));
    res.json({ success: true, message: 'Generando código de vinculación...' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/whatsapp/disconnect', requireAuth, async (req, res) => {
  wa.stopConnection(req.session.businessId);
  res.json({ success: true });
});

app.get('/api/whatsapp/conversations', requireAuth, (req, res) => {
  res.json(db.getWACoversations(req.session.businessId));
});

app.get('/api/whatsapp/conversations/:id', requireAuth, (req, res) => {
  const conv = getConversation(req, res);
  if (!conv) return;
  const messages = db.getWAMessages(conv.id);
  res.json({ ...conv, messages });
});

function getConversation(req, res) {
  const id = validateId(req.params.id);
  if (!id) return null;
  const conv = db.prepare('SELECT * FROM wa_conversations WHERE id = ? AND business_id = ?').get(id, req.session.businessId);
  if (!conv) {
    res.status(404).json({ error: 'No encontrada' });
    return null;
  }
  return conv;
}

app.post('/api/whatsapp/conversations/:id/messages', requireAuth, async (req, res) => {
  const conv = getConversation(req, res);
  if (!conv) return;
  const content = sanitizeString(req.body.content, 2000);
  if (!content) return res.status(400).json({ error: 'Contenido requerido' });
  db.insertWAMessage(conv.id, 'human', content);
  const jid = conv.remote_jid || (conv.phone.includes('@') ? conv.phone : conv.phone + '@s.whatsapp.net');
  const conn = wa.getConnection(req.session.businessId);
  if (conn) {
    try {
      await conn.sock.sendMessage(jid, { text: content });
    } catch (err) {
      db.enqueueWAOutbox(conv.id, req.session.businessId, jid, content);
    }
  } else {
    db.enqueueWAOutbox(conv.id, req.session.businessId, jid, content);
  }
  res.json({ success: true });
});

app.post('/api/whatsapp/conversations/:id/mode', requireAuth, (req, res) => {
  const conv = getConversation(req, res);
  if (!conv) return;
  const { mode } = req.body;
  if (!mode || !['AI', 'HUMAN'].includes(mode)) return res.status(400).json({ error: 'Modo inválido' });
  db.setWAMode(conv.id, mode);
  res.json({ success: true });
});

app.delete('/api/whatsapp/conversations/:id', requireAuth, (req, res) => {
  const conv = getConversation(req, res);
  if (!conv) return;
  db.deleteWACoversation(conv.id);
  res.json({ success: true });
});

// Serve frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Error handler
app.use((err, req, res, next) => {
  console.error('[server error]', err.stack || err.message || err);
  res.status(500).json({ error: 'Error interno del servidor' });
});

const server = app.listen(PORT, () => {
  console.log(`\n  Panel Cliente - Impulso Digital`);
  console.log(`  → http://localhost:${PORT}\n`);
  console.log(`  Iniciá sesión con las credenciales de tu negocio\n`);
  wa.initAllConnections();
});

function gracefulShutdown(signal) {
  console.log(`[server] Recibido ${signal}, cerrando graceful...`);
  wa.stopAllConnections();
  server.close(() => {
    console.log('[server] Servidor cerrado');
    process.exit(0);
  });
  setTimeout(() => {
    console.error('[server] Forzando cierre por timeout');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
