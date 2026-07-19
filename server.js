require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const path = require('path');
const db = require('./database');
const wa = require('./whatsapp-manager');

const app = express();
const PORT = process.env.PORT || 3001;
const isProduction = process.env.NODE_ENV === 'production';

app.set('trust proxy', 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// CORS for CRM
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', 'http://localhost:3000');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(session({
  secret: process.env.SESSION_SECRET || 'panelcliente-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: isProduction,
    httpOnly: true,
    sameSite: isProduction ? 'none' : 'lax',
    maxAge: 24 * 60 * 60 * 1000
  }
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

// Auth
app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email y contraseña requeridos' });
  }
  const business = db.getBusinessByEmail(email);
  if (!business || !bcrypt.compareSync(password, business.password_hash)) {
    return res.status(401).json({ error: 'Credenciales inválidas' });
  }
  req.session.businessId = business.id;
  req.session.businessName = business.name;
  res.json({ success: true, business: { id: business.id, name: business.name } });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) return res.status(500).json({ error: 'Error al cerrar sesión' });
    res.clearCookie('connect.sid');
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
  if (!name) return res.status(400).json({ error: 'Nombre requerido' });
  const id = db.createCustomer({ business_id: req.session.businessId, name, phone, email, notes });
  res.json({ success: true, id });
});

app.put('/api/customers/:id', requireAuth, (req, res) => {
  const c = db.getCustomerById(req.params.id);
  if (!c || c.business_id !== req.session.businessId) return res.status(404).json({ error: 'No encontrado' });
  db.updateCustomer(req.params.id, req.body);
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
  if (!name) return res.status(400).json({ error: 'Nombre requerido' });
  const id = db.createEmployee({ business_id: req.session.businessId, name, phone });
  res.json({ success: true, id });
});

app.put('/api/employees/:id', requireAuth, (req, res) => {
  db.updateEmployee(req.params.id, req.body);
  res.json({ success: true });
});

app.delete('/api/employees/:id', requireAuth, (req, res) => {
  db.deleteEmployee(req.params.id);
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
  if (!name) return res.status(400).json({ error: 'Nombre requerido' });
  const id = db.createService({ business_id: req.session.businessId, name, price, duration });
  res.json({ success: true, id });
});

app.put('/api/services/:id', requireAuth, (req, res) => {
  db.updateService(req.params.id, req.body);
  res.json({ success: true });
});

app.delete('/api/services/:id', requireAuth, (req, res) => {
  db.deleteService(req.params.id);
  res.json({ success: true });
});

// Appointments
app.get('/api/appointments', requireAuth, (req, res) => {
  const { date } = req.query;
  res.json(db.getAppointments(req.session.businessId, date || null));
});

app.get('/api/appointments/:id', requireAuth, (req, res) => {
  const a = db.getAppointmentById(req.params.id);
  if (!a || a.business_id !== req.session.businessId) return res.status(404).json({ error: 'No encontrado' });
  res.json(a);
});

app.post('/api/appointments', requireAuth, (req, res) => {
  const { customer_id, service_id, employee_id, date, time, status, notes } = req.body;
  if (!customer_id || !date || !time) return res.status(400).json({ error: 'Cliente, fecha y hora requeridos' });
  const id = db.createAppointment({ business_id: req.session.businessId, customer_id, service_id, employee_id, date, time, status, notes });
  res.json({ success: true, id });
});

app.put('/api/appointments/:id', requireAuth, (req, res) => {
  const a = db.getAppointmentById(req.params.id);
  if (!a || a.business_id !== req.session.businessId) return res.status(404).json({ error: 'No encontrado' });
  db.updateAppointment(req.params.id, req.body);
  res.json({ success: true });
});

app.patch('/api/appointments/:id/status', requireAuth, (req, res) => {
  const a = db.getAppointmentById(req.params.id);
  if (!a || a.business_id !== req.session.businessId) return res.status(404).json({ error: 'No encontrado' });
  const result = db.updateAppointmentStatus(req.params.id, req.body.status);
  if (result && result.saleCreated) {
    return res.json({ success: true, saleCreated: true, saleId: result.saleId, amount: result.amount, message: 'Venta generada automáticamente' });
  }
  if (result && result.saleRemoved) {
    return res.json({ success: true, saleRemoved: true, message: 'Venta eliminada por cambio de estado' });
  }
  res.json({ success: true });
});

app.delete('/api/appointments/:id', requireAuth, (req, res) => {
  const a = db.getAppointmentById(req.params.id);
  if (!a || a.business_id !== req.session.businessId) return res.status(404).json({ error: 'No encontrado' });
  db.deleteAppointment(req.params.id);
  res.json({ success: true });
});

// Sales
app.get('/api/sales', requireAuth, (req, res) => {
  const { date } = req.query;
  res.json(db.getSales(req.session.businessId, date || null));
});

app.post('/api/sales', requireAuth, (req, res) => {
  const { customer_id, service_id, amount, payment_method, notes, date } = req.body;
  if (!amount) return res.status(400).json({ error: 'Monto requerido' });
  const id = db.createSale({ business_id: req.session.businessId, customer_id, service_id, amount, payment_method, notes, date });
  res.json({ success: true, id });
});

app.delete('/api/sales/:id', requireAuth, (req, res) => {
  db.deleteSale(req.params.id);
  res.json({ success: true });
});

// Master API (for CRM)
app.post('/api/businesses', requireMasterKey, (req, res) => {
  const { name, contact, phone, email, password } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Nombre, email y contraseña requeridos' });
  }
  const existing = db.getBusinessByEmail(email);
  if (existing) return res.status(400).json({ error: 'Ya existe un negocio con ese email' });
  const id = db.createBusiness({ name, contact, phone, email, password });
  res.json({ success: true, id, email, password });
});

app.put('/api/businesses/:id', requireMasterKey, (req, res) => {
  const business = db.getBusinessById(parseInt(req.params.id));
  if (!business) return res.status(404).json({ error: 'Negocio no encontrado' });
  const { email, password } = req.body;
  if (email) {
    const existing = db.getBusinessByEmail(email);
    if (existing && existing.id !== business.id) return res.status(400).json({ error: 'El email ya está en uso' });
    db.updateBusinessEmail(business.id, email);
  }
  if (password) {
    const hash = bcrypt.hashSync(password, 10);
    db.updateBusinessPassword(business.id, hash);
  }
  res.json({ success: true });
});

// Auto-login via link (GET with email & password in query params)
app.get('/auto-login', (req, res) => {
  const { email, password } = req.query;
  if (!email || !password) {
    return res.redirect('/?error=missing_params');
  }
  const business = db.getBusinessByEmail(email);
  if (!business || !bcrypt.compareSync(password, business.password_hash)) {
    return res.redirect('/?error=invalid_credentials');
  }
  req.session.businessId = business.id;
  req.session.businessName = business.name;
  res.redirect('/');
});

app.post('/api/businesses/setup', requireMasterKey, (req, res) => {
  const { name, contact, phone, email, password, employees, services } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Nombre, email y contraseña requeridos' });
  }
  const existing = db.getBusinessByEmail(email);
  if (existing) return res.status(400).json({ error: 'Ya existe un negocio con ese email' });
  const id = db.createBusiness({ name, contact, phone, email, password });
  if (employees && employees.length > 0) {
    for (const e of employees) {
      db.createEmployee({ business_id: id, name: e.name, phone: e.phone || '' });
    }
  }
  if (services && services.length > 0) {
    for (const s of services) {
      db.createService({ business_id: id, name: s.name, price: s.price || 0, duration: s.duration || 30 });
    }
  }
  res.json({ success: true, id, email, password, employeesCount: (employees || []).length, servicesCount: (services || []).length });
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
  const conv = db.prepare('SELECT * FROM wa_conversations WHERE id = ? AND business_id = ?').get(req.params.id, req.session.businessId);
  if (!conv) return res.status(404).json({ error: 'No encontrada' });
  const messages = db.getWAMessages(conv.id);
  res.json({ ...conv, messages });
});

app.post('/api/whatsapp/conversations/:id/messages', requireAuth, async (req, res) => {
  const conv = db.prepare('SELECT * FROM wa_conversations WHERE id = ? AND business_id = ?').get(req.params.id, req.session.businessId);
  if (!conv) return res.status(404).json({ error: 'No encontrada' });
  const { content } = req.body;
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
  const conv = db.prepare('SELECT * FROM wa_conversations WHERE id = ? AND business_id = ?').get(req.params.id, req.session.businessId);
  if (!conv) return res.status(404).json({ error: 'No encontrada' });
  const { mode } = req.body;
  if (!mode || !['AI', 'HUMAN'].includes(mode)) return res.status(400).json({ error: 'Modo inválido' });
  db.setWAMode(conv.id, mode);
  res.json({ success: true });
});

app.delete('/api/whatsapp/conversations/:id', requireAuth, (req, res) => {
  const conv = db.prepare('SELECT * FROM wa_conversations WHERE id = ? AND business_id = ?').get(req.params.id, req.session.businessId);
  if (!conv) return res.status(404).json({ error: 'No encontrada' });
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

app.listen(PORT, () => {
  console.log(`\n  Panel Cliente - Impulso Digital`);
  console.log(`  → http://localhost:${PORT}\n`);
  console.log(`  Iniciá sesión con las credenciales de tu negocio\n`);
  wa.initAllConnections();
});
