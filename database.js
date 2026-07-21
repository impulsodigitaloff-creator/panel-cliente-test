const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const path = require('path');
const fs = require('fs');

const dbPath = process.env.DB_PATH || path.join(__dirname, 'data', 'panelcliente.db');
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

// Session store persistente (express-session)
db.exec(`CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  expires DATETIME,
  data TEXT
)`);

function pruneExpiredSessions() {
  db.prepare("DELETE FROM sessions WHERE expires IS NOT NULL AND expires <= datetime('now', '-3 hours')").run();
}
setInterval(pruneExpiredSessions, 600000).unref();

const { EventEmitter } = require('events');
class SQLiteSessionStore extends EventEmitter {
  constructor() { super(); this.db = db; }
  get(sid, cb) {
    try {
      const row = this.db.prepare("SELECT data FROM sessions WHERE sid = ? AND (expires IS NULL OR expires > datetime('now', '-3 hours'))").get(sid);
      cb(null, row ? JSON.parse(row.data) : null);
    } catch (e) { cb(e); }
  }
  set(sid, session, cb) {
    try {
      const expires = session.cookie?.expires ? new Date(session.cookie.expires).toISOString().replace('T', ' ').split('.')[0] : null;
      this.db.prepare('REPLACE INTO sessions (sid, expires, data) VALUES (?, ?, ?)').run(sid, expires, JSON.stringify(session));
      cb(null);
    } catch (e) { cb(e); }
  }
  destroy(sid, cb) {
    try { this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid); cb(null); } catch (e) { cb(e); }
  }
  touch(sid, session, cb) {
    try {
      const expires = session.cookie?.expires ? new Date(session.cookie.expires).toISOString().replace('T', ' ').split('.')[0] : null;
      this.db.prepare('UPDATE sessions SET expires = ? WHERE sid = ?').run(expires, sid);
      cb(null);
    } catch (e) { cb(e); }
  }
}

function sanitizeText(input, maxLength = 2000) {
  if (typeof input !== 'string') return '';
  return input.trim().slice(0, maxLength);
}

db.exec(`
  CREATE TABLE IF NOT EXISTS businesses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    contact TEXT DEFAULT '',
    phone TEXT DEFAULT '',
    email TEXT DEFAULT '',
    password_hash TEXT NOT NULL,
    active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT (datetime('now', '-3 hours'))
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_businesses_email ON businesses(email);

  CREATE TABLE IF NOT EXISTS employees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    business_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    phone TEXT DEFAULT '',
    active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT (datetime('now', '-3 hours')),
    FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS services (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    business_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    price REAL DEFAULT 0,
    duration INTEGER DEFAULT 30,
    active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT (datetime('now', '-3 hours')),
    FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    business_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    phone TEXT DEFAULT '',
    email TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    created_at DATETIME DEFAULT (datetime('now', '-3 hours')),
    FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS appointments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    business_id INTEGER NOT NULL,
    customer_id INTEGER NOT NULL,
    service_id INTEGER,
    employee_id INTEGER,
    date TEXT NOT NULL,
    time TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    notes TEXT DEFAULT '',
    sale_id INTEGER DEFAULT NULL,
    reminder_sent INTEGER DEFAULT 0,
    customer_confirmation_sent INTEGER DEFAULT 0,
    customer_reminder_1d_sent INTEGER DEFAULT 0,
    customer_reminder_1h_sent INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT (datetime('now', '-3 hours')),
    FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE,
    FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
    FOREIGN KEY (service_id) REFERENCES services(id) ON DELETE SET NULL,
    FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS sales (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    business_id INTEGER NOT NULL,
    customer_id INTEGER,
    service_id INTEGER,
    amount REAL NOT NULL,
    payment_method TEXT DEFAULT 'cash',
    notes TEXT DEFAULT '',
    date TEXT NOT NULL,
    created_at DATETIME DEFAULT (datetime('now', '-3 hours')),
    FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE,
    FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL,
    FOREIGN KEY (service_id) REFERENCES services(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS whatsapp_connections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    business_id INTEGER NOT NULL UNIQUE,
    status TEXT DEFAULT 'disconnected',
    qr_string TEXT DEFAULT '',
    phone TEXT DEFAULT '',
    session_data TEXT DEFAULT '',
    created_at DATETIME DEFAULT (datetime('now', '-3 hours')),
    updated_at DATETIME DEFAULT (datetime('now', '-3 hours')),
    FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS wa_conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    business_id INTEGER NOT NULL,
    phone TEXT NOT NULL,
    name TEXT DEFAULT '',
    mode TEXT DEFAULT 'AI' CHECK(mode IN ('AI','HUMAN')),
    last_message_at DATETIME DEFAULT (datetime('now', '-3 hours')),
    created_at DATETIME DEFAULT (datetime('now', '-3 hours')),
    FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS wa_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('user','assistant','human')),
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT (datetime('now', '-3 hours')),
    FOREIGN KEY (conversation_id) REFERENCES wa_conversations(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS wa_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    business_id INTEGER NOT NULL,
    phone TEXT NOT NULL,
    content TEXT NOT NULL,
    sent INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT (datetime('now', '-3 hours')),
    FOREIGN KEY (conversation_id) REFERENCES wa_conversations(id) ON DELETE CASCADE,
    FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_appointments_business_date_time ON appointments(business_id, date, time);
  CREATE INDEX IF NOT EXISTS idx_appointments_business_status ON appointments(business_id, status);
  CREATE INDEX IF NOT EXISTS idx_appointments_customer ON appointments(customer_id);
  CREATE INDEX IF NOT EXISTS idx_customers_business_phone ON customers(business_id, phone);
  CREATE INDEX IF NOT EXISTS idx_services_business ON services(business_id, active);
  CREATE INDEX IF NOT EXISTS idx_employees_business ON employees(business_id, active);
  CREATE INDEX IF NOT EXISTS idx_sales_business_date ON sales(business_id, date);
  CREATE INDEX IF NOT EXISTS idx_wa_messages_conversation ON wa_messages(conversation_id);
  CREATE INDEX IF NOT EXISTS idx_wa_conversations_business_phone ON wa_conversations(business_id, phone);

`);

// Migración: agregar columnas de info del negocio si no existen
function runMigration(sql) {
  try { db.exec(sql); } catch (e) {
    if (!e.message.includes('duplicate column')) {
      console.log('[db] Migración warning:', e.message);
    }
  }
}
runMigration('ALTER TABLE businesses ADD COLUMN address TEXT DEFAULT \'\'');
runMigration('ALTER TABLE businesses ADD COLUMN hours TEXT DEFAULT \'\'');
runMigration('ALTER TABLE businesses ADD COLUMN instagram TEXT DEFAULT \'\'');
runMigration('ALTER TABLE businesses ADD COLUMN human_phone TEXT DEFAULT \'\'');
runMigration('ALTER TABLE businesses ADD COLUMN promo TEXT DEFAULT \'\'');
runMigration('ALTER TABLE businesses ADD COLUMN custom_prompt TEXT DEFAULT \'\'');
runMigration('ALTER TABLE appointments ADD COLUMN reminder_sent INTEGER DEFAULT 0');
runMigration('ALTER TABLE appointments ADD COLUMN customer_confirmation_sent INTEGER DEFAULT 0');
runMigration('ALTER TABLE appointments ADD COLUMN customer_reminder_1d_sent INTEGER DEFAULT 0');
runMigration('ALTER TABLE appointments ADD COLUMN customer_reminder_1h_sent INTEGER DEFAULT 0');
runMigration('ALTER TABLE wa_conversations ADD COLUMN remote_jid TEXT DEFAULT \'\'');

// Migración: cargar servicios iniciales para todos los negocios que no tengan
try {
  const bizList = db.prepare('SELECT id FROM businesses ORDER BY id').all();
  const svcIns = db.prepare('INSERT INTO services (business_id, name, price, duration) VALUES (?, ?, ?, ?)');
  const services = [
    ['Corte hombre o niño', 15000, 30],
    ['Corte mujer', 30000, 45],
    ['Brushing', 25000, 30],
    ['Peinado semirecogido', 40000, 45],
    ['Peinado recogido completo', 60000, 60],
    ['Peinado novia/madrina/egresada', 70000, 90],
    ['Trenzados laterales', 30000, 40],
    ['Semitrenzado', 50000, 50],
    ['Trenzado completo', 70000, 60],
    ['Lavado de cabello (incluye secado en máquina)', 15000, 20],
    ['Aplicación de color/hena (incluye secado en máquina)', 20000, 30],
    ['Color raíz o crecimiento', 35000, 60],
    ['Coloración nacional', 50000, 90],
    ['Coloración importada', 70000, 90],
    ['Mechas o babylights', 75000, 120],
    ['Balayage', 85000, 150],
    ['Mechón contorno', 50000, 60],
    ['Barrido de color', 25000, 60],
    ['Decoloración global', 50000, 90],
    ['Ondulación permanente', 65000, 120],
    ['Hidratación', 20000, 30],
    ['Nutrición ácida/argán/biotina', 25000, 30],
    ['Ampolla reestructurante', 30000, 30],
    ['Alisado', 65000, 180],
    ['Keratina/botox', 35000, 90],
    ['Tratamiento matizador violeta o azul', 30000, 30],
    ['Tratamiento caída de cabello (por sesión)', 35000, 45]
  ];
  for (const biz of bizList) {
    const existing = db.prepare('SELECT name FROM services WHERE business_id = ?').all(biz.id).map(r => r.name);
    let added = 0;
    for (const [name, price, duration] of services) {
      if (!existing.includes(name)) {
        svcIns.run(biz.id, name, price, duration);
        added++;
      }
    }
    if (added > 0) {
      console.log(`[db] ${added} servicios nuevos agregados para negocio ${biz.id} (total: ${existing.length + added})`);
    }
  }
} catch (e) { console.log('[db] Migración servicios skip:', e.message); }

// Migración: actualizar negocio "Carolina Lobos Estilista" con info completa SOLO si falta dirección
try {
  const caro = db.prepare("SELECT id FROM businesses WHERE name LIKE '%Carolina%' OR name LIKE '%carolina%' ORDER BY id DESC LIMIT 1").get();
  if (caro) {
    // Migración: reconstruir remote_jid para conversaciones existentes
    const convs = db.prepare('SELECT id, phone FROM wa_conversations WHERE remote_jid IS NULL OR remote_jid = ?').all('');
    for (const c of convs) {
      const remoteJid = /^\d{13,}$/.test(c.phone) ? `${c.phone}@lid` : `${c.phone}@s.whatsapp.net`;
      db.prepare('UPDATE wa_conversations SET remote_jid=? WHERE id=?').run(remoteJid, c.id);
    }
    const existing = db.prepare('SELECT address FROM businesses WHERE id = ?').get(caro.id);
    if (!existing || !existing.address) {
      db.prepare('UPDATE businesses SET contact=?, phone=?, email=?, address=?, hours=?, instagram=?, human_phone=? WHERE id=?').run(
        'Carolina Lobos',
        '+54 264 470 1979',
        'loboscarolinayanina@yahoo.com.ar',
        'Mendoza Sur 340, J5402GUH, San Juan, Argentina',
        'Lunes a Sábados: 9:30 a 20:00 hs. Domingos: Cerrado.',
        '@carolinalobosestilista',
        '+54 264 470 1979',
        caro.id
      );
      console.log(`[db] Info de Carolina Lobos Estilista actualizada (negocio ${caro.id})`);
    }
    // Ya no reseteamos la contraseña automáticamente por seguridad.
  }
} catch (e) { console.log('[db] Migración Carolina skip:', e.message); }

function isBusinessOpen(date, time) {
  const d = new Date(date + 'T' + time);
  const day = d.getDay();
  if (day === 0) return false;
  const [h, m] = time.split(':').map(Number);
  const minutes = h * 60 + m;
  return minutes >= 9 * 60 + 30 && minutes < 20 * 60;
}

const dbMethods = {
  isBusinessOpen,
  // Auth
  createBusiness(data) {
    const hash = bcrypt.hashSync(data.password, 10);
    const r = db.prepare('INSERT INTO businesses (name, contact, phone, email, password_hash) VALUES (?, ?, ?, ?, ?)').run(data.name, data.contact || '', data.phone || '', data.email, hash);
    return r.lastInsertRowid;
  },
  getServiceById(id, businessId) {
    if (businessId) {
      return db.prepare('SELECT * FROM services WHERE id = ? AND business_id = ?').get(id, businessId);
    }
    return db.prepare('SELECT * FROM services WHERE id = ?').get(id);
  },
  getEmployeeById(id, businessId) {
    if (businessId) {
      return db.prepare('SELECT * FROM employees WHERE id = ? AND business_id = ?').get(id, businessId);
    }
    return db.prepare('SELECT * FROM employees WHERE id = ?').get(id);
  },
  getSaleById(id, businessId) {
    if (businessId) {
      return db.prepare('SELECT * FROM sales WHERE id = ? AND business_id = ?').get(id, businessId);
    }
    return db.prepare('SELECT * FROM sales WHERE id = ?').get(id);
  },
  getBusinessByEmail(email) {
    return db.prepare('SELECT * FROM businesses WHERE email = ? AND active = 1').get(email);
  },
  getBusinessById(id) {
    return db.prepare('SELECT * FROM businesses WHERE id = ?').get(id);
  },
  updateBusinessEmail(id, email) {
    db.prepare('UPDATE businesses SET email = ? WHERE id = ?').run(email, id);
  },
  updateBusinessPassword(id, hash) {
    db.prepare('UPDATE businesses SET password_hash = ? WHERE id = ?').run(hash, id);
  },
  updateBusinessInfo(id, data) {
    const allowedCols = ['name', 'contact', 'phone', 'address', 'hours', 'instagram', 'human_phone', 'promo', 'custom_prompt'];
    const cols = Object.keys(data).filter(k => allowedCols.includes(k));
    if (cols.length === 0) return;
    const sets = cols.map(k => `${k}=?`).join(',');
    const vals = cols.map(k => data[k]);
    db.prepare(`UPDATE businesses SET ${sets} WHERE id=?`).run(...vals, id);
  },

  // Dashboard
  getDashboardStats(businessId) {
    const totalCustomers = db.prepare('SELECT COUNT(*) as c FROM customers WHERE business_id = ?').get(businessId).c;
    const todayAppointments = db.prepare("SELECT COUNT(*) as c FROM appointments WHERE business_id = ? AND date = date('now', '-3 hours')").get(businessId).c;
    const pendingAppointments = db.prepare("SELECT COUNT(*) as c FROM appointments WHERE business_id = ? AND (status = 'pending' OR status = 'confirmed') AND date >= date('now', '-3 hours')").get(businessId).c;
    const todaySales = db.prepare("SELECT COALESCE(SUM(amount), 0) as t FROM sales WHERE business_id = ? AND date = date('now', '-3 hours')").get(businessId).t;
    const totalSalesMonth = db.prepare("SELECT COALESCE(SUM(amount), 0) as t FROM sales WHERE business_id = ? AND strftime('%Y-%m', date) = strftime('%Y-%m', 'now', '-3 hours')").get(businessId).t;
    return { totalCustomers, todayAppointments, pendingAppointments, todaySales, totalSalesMonth };
  },

  // Customers
  getCustomers(businessId) {
    return db.prepare('SELECT * FROM customers WHERE business_id = ? ORDER BY created_at DESC').all(businessId);
  },
  getCustomerById(id) {
    return db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
  },
  searchCustomers(businessId, term) {
    const like = `%${term}%`;
    return db.prepare('SELECT * FROM customers WHERE business_id = ? AND (name LIKE ? OR phone LIKE ? OR email LIKE ?) ORDER BY created_at DESC').all(businessId, like, like, like);
  },
  createCustomer(data) {
    const r = db.prepare('INSERT INTO customers (business_id, name, phone, email, notes) VALUES (?, ?, ?, ?, ?)').run(data.business_id, data.name, data.phone, data.email, data.notes);
    return r.lastInsertRowid;
  },
  updateCustomer(id, data) {
    const fields = [];
    const vals = [];
    if (data.name !== undefined) { fields.push('name=?'); vals.push(data.name); }
    if (data.phone !== undefined) { fields.push('phone=?'); vals.push(data.phone); }
    if (data.email !== undefined) { fields.push('email=?'); vals.push(data.email); }
    if (data.notes !== undefined) { fields.push('notes=?'); vals.push(data.notes); }
    if (fields.length === 0) return;
    vals.push(id);
    db.prepare(`UPDATE customers SET ${fields.join(',')} WHERE id=?`).run(...vals);
  },
  deleteCustomer(id) {
    db.prepare('DELETE FROM customers WHERE id = ?').run(id);
  },

  // Employees
  getEmployees(businessId) {
    return db.prepare('SELECT * FROM employees WHERE business_id = ? AND active = 1 ORDER BY name').all(businessId);
  },
  getAllEmployees(businessId) {
    return db.prepare('SELECT * FROM employees WHERE business_id = ? ORDER BY name').all(businessId);
  },
  createEmployee(data) {
    return db.prepare('INSERT INTO employees (business_id, name, phone) VALUES (?, ?, ?)').run(data.business_id, data.name, data.phone).lastInsertRowid;
  },
  updateEmployee(id, data) {
    const fields = [];
    const vals = [];
    if (data.name !== undefined) { fields.push('name=?'); vals.push(data.name); }
    if (data.phone !== undefined) { fields.push('phone=?'); vals.push(data.phone); }
    if (fields.length === 0) return;
    vals.push(id);
    db.prepare(`UPDATE employees SET ${fields.join(',')} WHERE id=?`).run(...vals);
  },
  deleteEmployee(id) {
    db.prepare('DELETE FROM employees WHERE id = ?').run(id);
  },

  // Services
  getServices(businessId) {
    return db.prepare('SELECT * FROM services WHERE business_id = ? AND active = 1 ORDER BY name').all(businessId);
  },
  getAllServices(businessId) {
    return db.prepare('SELECT * FROM services WHERE business_id = ? ORDER BY name').all(businessId);
  },
  createService(data) {
    return db.prepare('INSERT INTO services (business_id, name, price, duration) VALUES (?, ?, ?, ?)').run(data.business_id, data.name, data.price, data.duration).lastInsertRowid;
  },
  updateService(id, data) {
    db.prepare('UPDATE services SET name=?, price=?, duration=? WHERE id=?').run(data.name, data.price, data.duration, id);
  },
  deleteService(id) {
    db.prepare('UPDATE services SET active = 0 WHERE id = ?').run(id);
  },

  // Appointments
  getAppointments(businessId, date) {
    if (date) {
      return db.prepare(`
        SELECT a.*, c.name as customer_name, c.phone as customer_phone,
               s.name as service_name, s.price as service_price,
               e.name as employee_name
        FROM appointments a
        LEFT JOIN customers c ON a.customer_id = c.id
        LEFT JOIN services s ON a.service_id = s.id
        LEFT JOIN employees e ON a.employee_id = e.id
        WHERE a.business_id = ? AND a.date = ?
        ORDER BY a.time
      `).all(businessId, date);
    }
    return db.prepare(`
      SELECT a.*, c.name as customer_name, c.phone as customer_phone,
             s.name as service_name, s.price as service_price,
             e.name as employee_name
      FROM appointments a
      LEFT JOIN customers c ON a.customer_id = c.id
      LEFT JOIN services s ON a.service_id = s.id
      LEFT JOIN employees e ON a.employee_id = e.id
      WHERE a.business_id = ?
      ORDER BY a.date DESC, a.time
    `).all(businessId);
  },
  getUpcomingAppointmentsForReminder(businessId) {
    const now = new Date(Date.now() - 3 * 3600 * 1000);
    const inOneHour = new Date(now.getTime() + 60 * 60 * 1000);
    const today = now.toISOString().slice(0, 10);
    const maxTime = inOneHour.toISOString().slice(11, 16);
    return db.prepare(`
      SELECT a.*, c.name as customer_name, c.phone as customer_phone,
             s.name as service_name, e.name as employee_name
      FROM appointments a
      LEFT JOIN customers c ON a.customer_id = c.id
      LEFT JOIN services s ON a.service_id = s.id
      LEFT JOIN employees e ON a.employee_id = e.id
      WHERE a.business_id = ? AND a.date = ? AND a.time <= ? 
        AND a.status IN ('pending','confirmed') AND a.reminder_sent = 0
      ORDER BY a.time
    `).all(businessId, today, maxTime);
  },
  markReminderSent(appointmentId) {
    db.prepare('UPDATE appointments SET reminder_sent = 1 WHERE id = ?').run(appointmentId);
  },
  getAppointmentsNeedingConfirmation(businessId) {
    return db.prepare(`
      SELECT a.*, c.name as customer_name, c.phone as customer_phone,
             s.name as service_name, e.name as employee_name
      FROM appointments a
      LEFT JOIN customers c ON a.customer_id = c.id
      LEFT JOIN services s ON a.service_id = s.id
      LEFT JOIN employees e ON a.employee_id = e.id
      WHERE a.business_id = ? AND a.status IN ('pending','confirmed') AND a.customer_confirmation_sent = 0
    `).all(businessId);
  },
  getAppointmentsNeeding1dReminder(businessId) {
    return db.prepare(`
      SELECT a.*, c.name as customer_name, c.phone as customer_phone,
             s.name as service_name, e.name as employee_name
      FROM appointments a
      LEFT JOIN customers c ON a.customer_id = c.id
      LEFT JOIN services s ON a.service_id = s.id
      LEFT JOIN employees e ON a.employee_id = e.id
      WHERE a.business_id = ? AND a.status IN ('pending','confirmed')
        AND a.customer_reminder_1d_sent = 0
        AND a.date = date('now','-3 hours','+1 day')
    `).all(businessId);
  },
  getAppointmentsNeeding1hReminder(businessId) {
    return db.prepare(`
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
    `).all(businessId);
  },
  markCustomerConfirmationSent(appointmentId) {
    db.prepare('UPDATE appointments SET customer_confirmation_sent = 1 WHERE id = ?').run(appointmentId);
  },
  markCustomerReminder1dSent(appointmentId) {
    db.prepare('UPDATE appointments SET customer_reminder_1d_sent = 1 WHERE id = ?').run(appointmentId);
  },
  markCustomerReminder1hSent(appointmentId) {
    db.prepare('UPDATE appointments SET customer_reminder_1h_sent = 1 WHERE id = ?').run(appointmentId);
  },
  getAppointmentsByCustomer(customerId, businessId) {
    return db.prepare(`
      SELECT a.*, s.name as service_name, e.name as employee_name
      FROM appointments a
      LEFT JOIN services s ON a.service_id = s.id
      LEFT JOIN employees e ON a.employee_id = e.id
      WHERE a.customer_id = ? AND a.business_id = ?
      ORDER BY a.date DESC
    `).all(customerId, businessId);
  },
  getAppointmentById(id) {
    return db.prepare(`
      SELECT a.*, c.name as customer_name, c.phone as customer_phone,
             s.name as service_name, s.price as service_price,
             e.name as employee_name
      FROM appointments a
      LEFT JOIN customers c ON a.customer_id = c.id
      LEFT JOIN services s ON a.service_id = s.id
      LEFT JOIN employees e ON a.employee_id = e.id
      WHERE a.id = ?
    `).get(id);
  },
  isAppointmentSlotOccupied(businessId, date, time, excludeId = null) {
    if (excludeId) {
      return db.prepare("SELECT id FROM appointments WHERE business_id = ? AND date = ? AND time = ? AND status IN ('pending','confirmed') AND id != ?").get(businessId, date, time, excludeId);
    }
    return db.prepare("SELECT id FROM appointments WHERE business_id = ? AND date = ? AND time = ? AND status IN ('pending','confirmed')").get(businessId, date, time);
  },
  createAppointment(data) {
    if (this.isAppointmentSlotOccupied(data.business_id, data.date, data.time)) {
      throw new Error('El horario ya está ocupado');
    }
    const r = db.prepare('INSERT INTO appointments (business_id, customer_id, service_id, employee_id, date, time, status, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(data.business_id, data.customer_id, data.service_id, data.employee_id, data.date, data.time, data.status || 'pending', data.notes);
    return r.lastInsertRowid;
  },
  updateAppointment(id, data) {
    const existing = db.prepare('SELECT business_id, date, time FROM appointments WHERE id = ?').get(id);
    if (existing && data.date && data.time && (existing.date !== data.date || existing.time !== data.time)) {
      if (this.isAppointmentSlotOccupied(existing.business_id, data.date, data.time, id)) {
        throw new Error('El horario ya está ocupado');
      }
    }
    const fields = [];
    const vals = [];
    if (data.customer_id !== undefined) { fields.push('customer_id=?'); vals.push(data.customer_id); }
    if (data.service_id !== undefined) { fields.push('service_id=?'); vals.push(data.service_id); }
    if (data.employee_id !== undefined) { fields.push('employee_id=?'); vals.push(data.employee_id); }
    if (data.date !== undefined) { fields.push('date=?'); vals.push(data.date); }
    if (data.time !== undefined) { fields.push('time=?'); vals.push(data.time); }
    if (data.status !== undefined) { fields.push('status=?'); vals.push(data.status); }
    if (data.notes !== undefined) { fields.push('notes=?'); vals.push(data.notes); }
    if (fields.length === 0) return;
    vals.push(id);
    db.prepare(`UPDATE appointments SET ${fields.join(',')} WHERE id=?`).run(...vals);
  },
  updateAppointmentStatus(id, status) {
    const tx = db.transaction(() => {
      const old = db.prepare('SELECT * FROM appointments WHERE id = ?').get(id);
      if (!old) return { error: 'Turno no encontrado' };
      db.prepare('UPDATE appointments SET status=? WHERE id=?').run(status, id);
      // If completed, create sale
      if (status === 'completed' && !old.sale_id) {
        const service = old.service_id ? db.prepare('SELECT price FROM services WHERE id = ?').get(old.service_id) : null;
        const amount = service ? service.price : 0;
        if (amount > 0) {
          const saleId = this.createSale({
            business_id: old.business_id,
            customer_id: old.customer_id,
            service_id: old.service_id,
            amount,
            payment_method: 'pending',
            notes: 'Venta automática desde turno',
            date: old.date
          });
          db.prepare('UPDATE appointments SET sale_id=? WHERE id=?').run(saleId, id);
          return { saleCreated: true, saleId, amount };
        }
        return { saleCreated: false, message: 'El turno no tiene servicio con precio asignado. Registrá la venta manualmente.' };
      }
      // If un-completed, remove linked sale
      if (status !== 'completed' && old.sale_id) {
        this.deleteSale(old.sale_id, old.business_id);
        db.prepare('UPDATE appointments SET sale_id=NULL WHERE id=?').run(id);
        return { saleRemoved: true };
      }
      return null;
    });
    return tx();
  },
  deleteAppointment(id, businessId) {
    const a = businessId
      ? db.prepare('SELECT * FROM appointments WHERE id = ? AND business_id = ?').get(id, businessId)
      : db.prepare('SELECT * FROM appointments WHERE id = ?').get(id);
    if (!a) return false;
    if (a.sale_id) {
      this.deleteSale(a.sale_id, a.business_id);
    }
    db.prepare('DELETE FROM appointments WHERE id = ?').run(id);
    return true;
  },

  // Sales
  getSales(businessId, date) {
    if (date) {
      return db.prepare(`
        SELECT s.*, c.name as customer_name, sv.name as service_name
        FROM sales s
        LEFT JOIN customers c ON s.customer_id = c.id
        LEFT JOIN services sv ON s.service_id = sv.id
        WHERE s.business_id = ? AND s.date = ?
        ORDER BY s.created_at DESC
      `).all(businessId, date);
    }
    return db.prepare(`
      SELECT s.*, c.name as customer_name, sv.name as service_name
      FROM sales s
      LEFT JOIN customers c ON s.customer_id = c.id
      LEFT JOIN services sv ON s.service_id = sv.id
      WHERE s.business_id = ?
      ORDER BY s.date DESC, s.created_at DESC
    `).all(businessId);
  },
  getSalesByCustomer(customerId, businessId) {
    return db.prepare(`
      SELECT s.*, sv.name as service_name
      FROM sales s
      LEFT JOIN services sv ON s.service_id = sv.id
      WHERE s.customer_id = ? AND s.business_id = ?
      ORDER BY s.date DESC
    `).all(customerId, businessId);
  },
  createSale(data) {
    const r = db.prepare('INSERT INTO sales (business_id, customer_id, service_id, amount, payment_method, notes, date) VALUES (?, ?, ?, ?, ?, ?, ?)').run(data.business_id, data.customer_id, data.service_id, data.amount, data.payment_method, data.notes, data.date);
    return r.lastInsertRowid;
  },
  deleteSale(id, businessId) {
    const sale = businessId
      ? db.prepare('SELECT * FROM sales WHERE id = ? AND business_id = ?').get(id, businessId)
      : db.prepare('SELECT * FROM sales WHERE id = ?').get(id);
    if (!sale) return false;
    db.prepare('UPDATE appointments SET sale_id=NULL WHERE sale_id=?').run(id);
    db.prepare('DELETE FROM sales WHERE id = ?').run(id);
    return true;
  },

  // WhatsApp
  getWhatsAppConnection(businessId) {
    return db.prepare('SELECT * FROM whatsapp_connections WHERE business_id = ?').get(businessId);
  },
  upsertWhatsAppConnection(data) {
    const allowedCols = ['status', 'qr_string', 'phone', 'session_data'];
    const existing = db.prepare('SELECT id FROM whatsapp_connections WHERE business_id = ?').get(data.business_id);
    if (existing) {
      const keys = Object.keys(data).filter(k => k !== 'business_id' && allowedCols.includes(k));
      const sets = keys.map(k => `${k}=?`).join(',');
      const vals = keys.map(k => data[k]);
      db.prepare(`UPDATE whatsapp_connections SET ${sets}, updated_at=(datetime('now','-3 hours')) WHERE business_id=?`).run(...vals, data.business_id);
    } else {
      const keys = Object.keys(data).filter(k => allowedCols.includes(k) || k === 'business_id');
      const q = keys.map(() => '?').join(',');
      db.prepare(`INSERT INTO whatsapp_connections (${keys.join(',')}) VALUES (${q})`).run(...keys.map(k => data[k]));
    }
  },
  deleteWhatsAppConnection(businessId) {
    db.prepare('DELETE FROM whatsapp_connections WHERE business_id = ?').run(businessId);
  },
  getWACoversations(businessId) {
    return db.prepare(`
      SELECT c.*, (SELECT content FROM wa_messages WHERE conversation_id = c.id ORDER BY id DESC LIMIT 1) as last_message
      FROM wa_conversations c WHERE c.business_id = ? ORDER BY c.last_message_at DESC
    `).all(businessId);
  },
  getWAMessages(conversationId, limit = 50) {
    return db.prepare('SELECT * FROM wa_messages WHERE conversation_id = ? ORDER BY id ASC LIMIT ?').all(conversationId, limit);
  },
  getRecentWAHistory(conversationId, limit = 20) {
    const msgs = db.prepare('SELECT * FROM wa_messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?').all(conversationId, limit);
    return msgs.reverse();
  },
  getOrCreateWACoversation(businessId, phone, name, remoteJid) {
    let c = db.prepare('SELECT * FROM wa_conversations WHERE business_id = ? AND phone = ?').get(businessId, phone);
    if (!c) {
      const r = db.prepare('INSERT INTO wa_conversations (business_id, phone, name, remote_jid) VALUES (?, ?, ?, ?)').run(businessId, phone, name || '', remoteJid || '');
      c = db.prepare('SELECT * FROM wa_conversations WHERE id = ?').get(r.lastInsertRowid);
    } else {
      if (name && name !== c.name) {
        db.prepare('UPDATE wa_conversations SET name=? WHERE id=?').run(name, c.id);
        c.name = name;
      }
      if (remoteJid && remoteJid !== c.remote_jid) {
        db.prepare('UPDATE wa_conversations SET remote_jid=? WHERE id=?').run(remoteJid, c.id);
        c.remote_jid = remoteJid;
      }
    }
    return c;
  },
  insertWAMessage(conversationId, role, content) {
    db.prepare('UPDATE wa_conversations SET last_message_at=(datetime(\'now\',\'-3 hours\')) WHERE id=?').run(conversationId);
    const r = db.prepare('INSERT INTO wa_messages (conversation_id, role, content) VALUES (?, ?, ?)').run(conversationId, role, content);
    return r.lastInsertRowid;
  },
  setWAMode(conversationId, mode) {
    db.prepare('UPDATE wa_conversations SET mode=? WHERE id=?').run(mode, conversationId);
  },
  enqueueWAOutbox(conversationId, businessId, phone, content) {
    db.prepare('INSERT INTO wa_outbox (conversation_id, business_id, phone, content) VALUES (?, ?, ?, ?)').run(conversationId, businessId, phone, content);
  },
  getPendingWAOutbox() {
    return db.prepare('SELECT * FROM wa_outbox WHERE sent = 0 ORDER BY id ASC LIMIT 10').all();
  },
  markWAOutboxSent(id) {
    db.prepare('UPDATE wa_outbox SET sent = 1 WHERE id = ?').run(id);
  },
  deleteWACoversation(id) {
    db.prepare('DELETE FROM wa_messages WHERE conversation_id = ?').run(id);
    db.prepare('DELETE FROM wa_outbox WHERE conversation_id = ?').run(id);
    db.prepare('DELETE FROM wa_conversations WHERE id = ?').run(id);
  }
};

// Exportamos los wrappers pero mantenemos acceso a métodos raw de better-sqlite3
const exported = Object.create(db);
Object.assign(exported, dbMethods);
exported.SQLiteSessionStore = SQLiteSessionStore;
module.exports = exported;
