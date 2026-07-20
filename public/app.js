let state = {
  currentView: 'dashboard',
  customers: [],
  employees: [],
  services: [],
  appointments: [],
  sales: [],
  editingId: null,
  currentDate: new Date().toISOString().split('T')[0]
};

function escapeHtml(text) {
  if (text === null || text === undefined) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...opts.headers },
    ...opts
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Error de conexión' }));
    throw new Error(err.error || 'Error del servidor');
  }
  return res.json();
}

function toast(msg, type = 'info') {
  const c = document.getElementById('toast-container');
  const t = document.createElement('div');
  t.className = `toast toast-${type}`;
  t.textContent = msg;
  c.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

function closeModal(id) { document.getElementById(id).classList.remove('open'); }
function openModal(id) { document.getElementById(id).classList.add('open'); }

function todayStr() { return new Date().toISOString().split('T')[0]; }

function formatTime(t) {
  if (!t) return '';
  const p = t.split(':');
  return `${p[0]}:${p[1]}`;
}

function formatDate(d) {
  if (!d) return '';
  const [y, m, day] = d.split('-');
  const months = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
  return `${parseInt(day)} ${months[parseInt(m)-1]} ${y}`;
}

function formatCurrency(n) {
  return '$' + Number(n).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function statusBadge(status) {
  const map = {
    pending: '<span class="badge badge-pending">Pendiente</span>',
    confirmed: '<span class="badge badge-active">Confirmado</span>',
    in_progress: '<span class="badge badge-active">En curso</span>',
    completed: '<span class="badge badge-completed">Completado</span>',
    cancelled: '<span class="badge badge-cancelled">Cancelado</span>'
  };
  return map[status] || '<span class="badge badge-pending">Pendiente</span>';
}

const statusLabels = {
  pending: 'Pendiente', confirmed: 'Confirmado', in_progress: 'En curso',
  completed: 'Completado', cancelled: 'Cancelado'
};

// ==================== AUTH ====================

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector('button');
  btn.disabled = true; btn.textContent = 'Ingresando...';
  document.getElementById('login-error').classList.remove('show');
  try {
    const data = await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({
        email: document.getElementById('login-email').value,
        password: document.getElementById('login-password').value
      })
    });
    if (data.success) initApp(data.business);
  } catch (err) {
    const el = document.getElementById('login-error');
    el.textContent = err.message;
    el.classList.add('show');
  }
  btn.disabled = false; btn.textContent = 'Iniciar Sesión';
});

document.getElementById('logout-btn').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' });
  document.getElementById('app-view').classList.add('hidden');
  document.getElementById('login-view').style.display = 'flex';
});

async function checkSession() {
  try {
    const data = await api('/api/session');
    if (data.authenticated) initApp(data.business);
  } catch (e) {}
}

function initApp(business) {
  document.getElementById('login-view').style.display = 'none';
  document.getElementById('app-view').classList.remove('hidden');
  document.getElementById('sidebar-business-name').textContent = business.name;
  document.getElementById('sidebar-name').textContent = business.name;
  showView('dashboard');
}

// ==================== NAV ====================

document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', () => showView(item.dataset.view));
});

document.getElementById('mobile-toggle').addEventListener('click', () => {
  document.getElementById('sidebar').classList.toggle('open');
});

function showView(view) {
  state.currentView = view;
  document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.view === view));
  const titles = {
    dashboard: ['Dashboard', 'Resumen de tu negocio'],
    appointments: ['Turnos', 'Gestión de turnos programados'],
    customers: ['Clientes', 'Tus clientes registrados'],
    sales: ['Ventas', 'Registro de ventas realizadas'],
    whatsapp: ['WhatsApp', 'Conexión y conversaciones'],
    settings: ['Configuración', 'Empleados y servicios']
  };
  document.getElementById('view-title').textContent = titles[view][0];
  document.getElementById('view-subtitle').textContent = titles[view][1];
  document.getElementById('header-actions').innerHTML = '';
  document.getElementById('main-content').innerHTML = '<div class="spinner"></div>';
  if (view !== 'whatsapp') {
    if (waPollTimer) { clearInterval(waPollTimer); waPollTimer = null; }
    waSelectedConv = null;
  }
  if (view === 'dashboard') renderDashboard();
  else if (view === 'appointments') renderAppointments();
  else if (view === 'customers') renderCustomers();
  else if (view === 'sales') renderSales();
  else if (view === 'whatsapp') renderWhatsApp();
  else if (view === 'settings') renderSettings();
  if (window.innerWidth <= 768) document.getElementById('sidebar').classList.remove('open');
}

// ==================== DASHBOARD ====================

async function renderDashboard() {
  try {
    const stats = await api('/api/dashboard');
    const today = todayStr();
    const appts = await api(`/api/appointments?date=${today}`);
    const pendingAppts = appts.filter(a => a.status === 'pending' || a.status === 'confirmed');

    let apptsHtml = '';
    if (pendingAppts.length > 0) {
      apptsHtml = '<h3 style="font-size:14px; font-weight:600; margin-bottom:12px;">Turnos de hoy</h3>';
      pendingAppts.forEach(a => {
        apptsHtml += `<div class="appt-card" style="cursor:pointer;" onclick="showView('appointments')">
          <div class="appt-time">${escapeHtml(formatTime(a.time))}</div>
          <div class="appt-info">
            <div class="appt-customer">${escapeHtml(a.customer_name)}</div>
            <div class="appt-detail">${escapeHtml(a.service_name || '')} ${a.employee_name ? 'con ' + escapeHtml(a.employee_name) : ''}</div>
          </div>
          <div>${statusBadge(a.status)}</div>
        </div>`;
      });
    } else {
      apptsHtml = '<div class="empty-state"><p>No hay turnos para hoy</p></div>';
    }

    const el = document.getElementById('main-content');
    el.innerHTML = `
      <div class="stats-grid">
        <div class="stat-card accent">
          <div class="stat-icon">👥</div>
          <div class="stat-value">${stats.totalCustomers}</div>
          <div class="stat-label">Clientes Registrados</div>
        </div>
        <div class="stat-card success">
          <div class="stat-icon">📅</div>
          <div class="stat-value">${stats.todayAppointments}</div>
          <div class="stat-label">Turnos Hoy</div>
        </div>
        <div class="stat-card warning">
          <div class="stat-icon">⏳</div>
          <div class="stat-value">${stats.pendingAppointments}</div>
          <div class="stat-label">Turnos Pendientes</div>
        </div>
        <div class="stat-card info">
          <div class="stat-icon">💰</div>
          <div class="stat-value">${formatCurrency(stats.todaySales)}</div>
          <div class="stat-label">Ventas Hoy</div>
        </div>
      </div>
      <div class="stat-card" style="margin-bottom:20px;">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <div>
            <div class="stat-value" style="font-size:20px;">${formatCurrency(stats.totalSalesMonth)}</div>
            <div class="stat-label">Ventas del Mes</div>
          </div>
          <div style="font-size:40px; opacity:0.3;">📊</div>
        </div>
      </div>
      ${apptsHtml}
    `;
  } catch (err) {
    document.getElementById('main-content').innerHTML = `<div class="empty-state"><p>Error: ${escapeHtml(err.message)}</p></div>`;
  }
}

// ==================== CUSTOMERS ====================

let customerSearch = '';

async function renderCustomers() {
  const el = document.getElementById('main-content');
  document.getElementById('header-actions').innerHTML = `<button class="btn btn-primary" onclick="openCustomerModal()">+ Nuevo Cliente</button>`;
  try {
    state.customers = await api('/api/customers');
    renderCustomersTable(el);
  } catch (err) {
    el.innerHTML = `<div class="empty-state"><p>Error: ${escapeHtml(err.message)}</p></div>`;
  }
}

function renderCustomersTable(el) {
  let data = state.customers;
  if (customerSearch) {
    const s = customerSearch.toLowerCase();
    data = data.filter(c => c.name.toLowerCase().includes(s) || (c.phone || '').includes(s));
  }

  const rows = data.map(c => `
    <tr>
      <td>
        <div class="info">
          <span class="info-name">${escapeHtml(c.name)}</span>
          <span class="info-sub">${escapeHtml(c.phone || c.email || 'Sin contacto')}</span>
        </div>
      </td>
      <td>${escapeHtml(c.phone || '—')}</td>
      <td>${escapeHtml(c.email || '—')}</td>
      <td>
        <div style="display:flex;gap:4px;">
          <button class="btn btn-sm btn-secondary" onclick="openCustomerModal(${c.id})" title="Editar">✏️</button>
          <button class="btn btn-sm btn-danger" onclick="deleteCustomer(${c.id})" title="Eliminar">🗑️</button>
        </div>
      </td>
    </tr>
  `).join('');

  el.innerHTML = `
    <div class="section-header">
      <div class="section-actions" style="flex:1;">
        <div class="search-box" style="flex:1;max-width:320px;">
          <span class="search-icon">🔍</span>
          <input type="text" id="customer-search" placeholder="Buscar clientes..." value="${escapeHtml(customerSearch)}" oninput="searchCustomers()">
        </div>
      </div>
    </div>
    <div class="table-container">
      <table>
        <thead>
          <tr>
            <th>Nombre</th>
            <th>Teléfono</th>
            <th>Email</th>
            <th>Acciones</th>
          </tr>
        </thead>
        <tbody>
          ${rows || '<tr><td colspan="4"><div class="empty-state"><p>No hay clientes registrados</p></div></td></tr>'}
        </tbody>
      </table>
    </div>
  `;
}

function searchCustomers() {
  customerSearch = document.getElementById('customer-search').value;
  renderCustomersTable(document.getElementById('main-content'));
}

async function openCustomerModal(id) {
  state.editingId = id || null;
  document.getElementById('form-customer').reset();
  document.getElementById('customer-id').value = '';
  document.getElementById('customer-history').style.display = 'none';

  if (id) {
    document.getElementById('modal-customer-title').textContent = 'Editar Cliente';
    try {
      const c = await api(`/api/customers/${id}`);
      document.getElementById('customer-id').value = c.id;
      document.getElementById('c-name').value = c.name || '';
      document.getElementById('c-phone').value = c.phone || '';
      document.getElementById('c-email').value = c.email || '';
      document.getElementById('c-notes').value = c.notes || '';

      // Show history
      document.getElementById('customer-history').style.display = 'block';
      let apptHtml = '<h4 style="font-size:13px;font-weight:600;margin-bottom:8px;color:var(--text-secondary);">Turnos</h4>';
      if (c.appointments && c.appointments.length > 0) {
        apptHtml += c.appointments.map(a => `
          <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border);font-size:13px;">
            <span>${escapeHtml(formatDate(a.date))} ${escapeHtml(formatTime(a.time))} - ${escapeHtml(a.service_name || 'Sin servicio')}</span>
            <span>${statusBadge(a.status)}</span>
          </div>
        `).join('');
      } else {
        apptHtml += '<span style="font-size:13px;color:var(--text-muted);">Sin turnos</span>';
      }

      let saleHtml = '<h4 style="font-size:13px;font-weight:600;margin-bottom:8px;color:var(--text-secondary);margin-top:12px;">Ventas</h4>';
      if (c.sales && c.sales.length > 0) {
        saleHtml += c.sales.map(s => `
          <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border);font-size:13px;">
            <span>${escapeHtml(formatDate(s.date))} - ${escapeHtml(s.service_name || 'Venta directa')}</span>
            <span style="font-weight:600;">${escapeHtml(formatCurrency(s.amount))}</span>
          </div>
        `).join('');
      } else {
        saleHtml += '<span style="font-size:13px;color:var(--text-muted);">Sin ventas</span>';
      }

      document.getElementById('customer-appts').innerHTML = apptHtml;
      document.getElementById('customer-sales').innerHTML = saleHtml;
    } catch (err) {
      toast(err.message, 'error');
      return;
    }
  } else {
    document.getElementById('modal-customer-title').textContent = 'Nuevo Cliente';
  }
  openModal('modal-customer');
}

function setLoading(btn, loading, text) {
  if (!btn) return;
  btn.disabled = loading;
  btn.textContent = loading ? (text || 'Guardando...') : (text || 'Guardar');
}

async function saveCustomer() {
  const data = {
    name: document.getElementById('c-name').value.trim(),
    phone: document.getElementById('c-phone').value.trim(),
    email: document.getElementById('c-email').value.trim(),
    notes: document.getElementById('c-notes').value.trim()
  };
  if (!data.name) { toast('El nombre es obligatorio', 'error'); return; }
  const btn = document.querySelector('#modal-customer .btn-primary');
  setLoading(btn, true, 'Guardando...');
  try {
    if (state.editingId) {
      await api(`/api/customers/${state.editingId}`, { method: 'PUT', body: JSON.stringify(data) });
      toast('Cliente actualizado', 'success');
    } else {
      await api('/api/customers', { method: 'POST', body: JSON.stringify(data) });
      toast('Cliente creado', 'success');
    }
    closeModal('modal-customer');
    renderCustomers();
  } catch (err) { toast(err.message, 'error'); }
  finally { setLoading(btn, false); }
}

async function deleteCustomer(id) {
  if (!confirm('¿Eliminar este cliente? Se borrará todo su historial.')) return;
  try {
    await api(`/api/customers/${id}`, { method: 'DELETE' });
    toast('Cliente eliminado', 'success');
    renderCustomers();
  } catch (err) { toast(err.message, 'error'); }
}

// ==================== APPOINTMENTS ====================

async function renderAppointments() {
  document.getElementById('header-actions').innerHTML = `<button class="btn btn-primary" onclick="openAppointmentModal()">+ Nuevo Turno</button>`;
  await loadAppointments();
}

async function loadAppointments() {
  const el = document.getElementById('main-content');
  try {
    const appts = await api(`/api/appointments?date=${state.currentDate}`);
    state.appointments = appts;
    renderAppointmentsList(el);
  } catch (err) {
    el.innerHTML = `<div class="empty-state"><p>Error: ${err.message}</p></div>`;
  }
}

function renderAppointmentsList(el) {
  const data = state.appointments;
  const today = todayStr();
  const isToday = state.currentDate === today;

  // Count pending
  const pendingCount = data.filter(a => a.status === 'pending' || a.status === 'confirmed').length;
  const badge = document.getElementById('appt-badge');
  if (pendingCount > 0) { badge.textContent = pendingCount; badge.style.display = ''; }
  else badge.style.display = 'none';

  let cards;
  if (data.length === 0) {
    cards = `<div class="empty-state"><div class="empty-icon">📅</div><h3>Sin turnos</h3><p>No hay turnos para ${escapeHtml(formatDate(state.currentDate))}</p></div>`;
  } else {
    cards = data.map(a => `
      <div class="appt-card">
        <div class="appt-time">${escapeHtml(formatTime(a.time))}</div>
        <div class="appt-info">
          <div class="appt-customer">${escapeHtml(a.customer_name)}</div>
          <div class="appt-detail">
            ${escapeHtml(a.service_name || '')}
            ${a.employee_name ? 'con ' + escapeHtml(a.employee_name) : ''}
            ${a.notes ? '· ' + escapeHtml(a.notes) : ''}
            ${a.sale_id ? '<span style="color:var(--success);">· 💰 Venta registrada</span>' : ''}
          </div>
        </div>
        <div>
          <select class="status-select" data-appt-id="${a.id}" onchange="changeApptStatus(${a.id}, this.value)">
            <option value="pending" ${a.status === 'pending' ? 'selected' : ''}>Pendiente</option>
            <option value="confirmed" ${a.status === 'confirmed' ? 'selected' : ''}>Confirmado</option>
            <option value="in_progress" ${a.status === 'in_progress' ? 'selected' : ''}>En curso</option>
            <option value="completed" ${a.status === 'completed' ? 'selected' : ''}>Completado</option>
            <option value="cancelled" ${a.status === 'cancelled' ? 'selected' : ''}>Cancelado</option>
          </select>
        </div>
        <div class="appt-actions">
          <button class="btn btn-sm btn-secondary" onclick="openAppointmentModal(${a.id})" title="Editar">✏️</button>
          <button class="btn btn-sm btn-danger" onclick="deleteAppointment(${a.id})" title="Eliminar">🗑️</button>
        </div>
      </div>
    `).join('');
  }

  el.innerHTML = `
    <div class="date-nav">
      <button class="date-nav-btn" onclick="changeDate(-1)">◀</button>
      <h3>${isToday ? 'Hoy' : formatDate(state.currentDate)}</h3>
      <button class="date-nav-btn" onclick="changeDate(1)">▶</button>
      ${!isToday ? `<button class="date-today-btn" onclick="goToday()">Hoy</button>` : ''}
    </div>
    <div class="appts-list">${cards}</div>
  `;
}

function changeDate(delta) {
  const d = new Date(state.currentDate);
  d.setDate(d.getDate() + delta);
  state.currentDate = d.toISOString().split('T')[0];
  loadAppointments();
}

function goToday() {
  state.currentDate = todayStr();
  loadAppointments();
}

async function changeApptStatus(id, status) {
  try {
    const r = await api(`/api/appointments/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) });
    let msg = `Turno ${statusLabels[status] || status}`;
    if (r.saleCreated) msg += ` · Venta de ${formatCurrency(r.amount)} generada ✅`;
    if (r.saleRemoved) msg += ` · Venta eliminada`;
    if (r.saleCreated === false) msg += ` · ⚠️ ${r.message}`;
    toast(msg, 'success');
    loadAppointments();
  } catch (err) { toast(err.message, 'error'); }
}

async function openAppointmentModal(id) {
  state.editingId = id || null;
  document.getElementById('form-appointment').reset();
  document.getElementById('appt-id').value = '';

  // Load customers, services, employees for selects
  try {
    const [customers, services, employees] = await Promise.all([
      api('/api/customers'),
      api('/api/services'),
      api('/api/employees')
    ]);

    const custSelect = document.getElementById('a-customer');
    custSelect.innerHTML = '<option value="">Seleccionar cliente...</option>' +
      customers.map(c => `<option value="${c.id}">${escapeHtml(c.name)} ${c.phone ? '- ' + escapeHtml(c.phone) : ''}</option>`).join('');

    const servSelect = document.getElementById('a-service');
    servSelect.innerHTML = '<option value="">Sin servicio</option>' +
      services.map(s => `<option value="${s.id}">${escapeHtml(s.name)} - ${escapeHtml(formatCurrency(s.price))}</option>`).join('');

    const empSelect = document.getElementById('a-employee');
    empSelect.innerHTML = '<option value="">Sin empleado</option>' +
      employees.map(e => `<option value="${e.id}">${escapeHtml(e.name)}</option>`).join('');

    if (id) {
      document.getElementById('modal-appt-title').textContent = 'Editar Turno';
      const a = await api(`/api/appointments/${id}`);
      document.getElementById('appt-id').value = a.id;
      document.getElementById('a-customer').value = a.customer_id || '';
      document.getElementById('a-service').value = a.service_id || '';
      document.getElementById('a-employee').value = a.employee_id || '';
      document.getElementById('a-date').value = a.date || state.currentDate;
      document.getElementById('a-time').value = a.time || '';
      document.getElementById('a-status').value = a.status || 'pending';
      document.getElementById('a-notes').value = a.notes || '';
    } else {
      document.getElementById('modal-appt-title').textContent = 'Nuevo Turno';
      document.getElementById('a-date').value = state.currentDate;
      document.getElementById('a-time').value = '';
      document.getElementById('a-status').value = 'pending';
    }
    openModal('modal-appointment');
  } catch (err) { toast(err.message, 'error'); }
}

async function saveAppointment() {
  const data = {
    customer_id: parseInt(document.getElementById('a-customer').value) || null,
    service_id: parseInt(document.getElementById('a-service').value) || null,
    employee_id: parseInt(document.getElementById('a-employee').value) || null,
    date: document.getElementById('a-date').value,
    time: document.getElementById('a-time').value,
    status: document.getElementById('a-status').value,
    notes: document.getElementById('a-notes').value.trim()
  };
  if (!data.customer_id || !data.date || !data.time) {
    toast('Cliente, fecha y hora son obligatorios', 'error'); return;
  }
  const btn = document.querySelector('#modal-appointment .btn-primary');
  setLoading(btn, true, 'Guardando...');
  try {
    if (state.editingId) {
      await api(`/api/appointments/${state.editingId}`, { method: 'PUT', body: JSON.stringify(data) });
      toast('Turno actualizado', 'success');
    } else {
      const r = await api('/api/appointments', { method: 'POST', body: JSON.stringify(data) });
      toast('Turno creado', 'success');
    }
    closeModal('modal-appointment');
    loadAppointments();
  } catch (err) { toast(err.message, 'error'); }
  finally { setLoading(btn, false); }
}

async function deleteAppointment(id) {
  if (!confirm('¿Eliminar este turno?')) return;
  try {
    await api(`/api/appointments/${id}`, { method: 'DELETE' });
    toast('Turno eliminado', 'success');
    loadAppointments();
  } catch (err) { toast(err.message, 'error'); }
}

async function quickAddCustomer() {
  const name = prompt('Nombre del nuevo cliente:');
  if (!name) return;
  try {
    const r = await api('/api/customers', { method: 'POST', body: JSON.stringify({ name, phone: '', email: '', notes: '' }) });
    toast('Cliente creado', 'success');
    // Reload customers in select
    const customers = await api('/api/customers');
    const select = document.getElementById('a-customer');
    select.innerHTML = '<option value="">Seleccionar cliente...</option>' +
      customers.map(c => `<option value="${c.id}">${escapeHtml(c.name)} ${c.phone ? '- ' + escapeHtml(c.phone) : ''}</option>`).join('');
    select.value = r.id;
  } catch (err) { toast(err.message, 'error'); }
}

// ==================== SALES ====================

let salesDate = todayStr();

async function renderSales() {
  const el = document.getElementById('main-content');
  document.getElementById('header-actions').innerHTML = `<button class="btn btn-primary" onclick="openSaleModal()">+ Nueva Venta</button>`;
  try {
    const sales = await api(`/api/sales?date=${salesDate}`);
    state.sales = sales;
    renderSalesList(el);
  } catch (err) {
    el.innerHTML = `<div class="empty-state"><p>Error: ${escapeHtml(err.message)}</p></div>`;
  }
}

function renderSalesList(el) {
  const data = state.sales;
  const total = data.reduce((sum, s) => sum + s.amount, 0);
  const isToday = salesDate === todayStr();

  const rows = data.map(s => `
    <tr>
      <td>${escapeHtml(s.customer_name || '—')}</td>
      <td>${escapeHtml(s.service_name || '—')}</td>
      <td><span style="font-weight:600;">${escapeHtml(formatCurrency(s.amount))}</span></td>
      <td><span style="text-transform:capitalize;">${escapeHtml(s.payment_method || 'cash')}</span></td>
      <td>${escapeHtml(s.notes || '—')}</td>
      <td>
        <button class="btn btn-sm btn-danger" onclick="deleteSale(${s.id})" title="Eliminar">🗑️</button>
      </td>
    </tr>
  `).join('');

  el.innerHTML = `
    <div class="date-nav">
      <button class="date-nav-btn" onclick="changeSalesDate(-1)">◀</button>
      <h3>${isToday ? 'Hoy' : escapeHtml(formatDate(salesDate))}</h3>
      <button class="date-nav-btn" onclick="changeSalesDate(1)">▶</button>
      ${!isToday ? `<button class="date-today-btn" onclick="goSalesToday()">Hoy</button>` : ''}
    </div>
    <div class="stat-card" style="margin-bottom:16px;">
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <div>
          <div class="stat-label">Total de ventas</div>
          <div class="stat-value" style="font-size:24px;">${escapeHtml(formatCurrency(total))}</div>
        </div>
        <div style="font-size:36px; opacity:0.3;">💰</div>
      </div>
    </div>
    <div class="table-container">
      <table>
        <thead>
          <tr>
            <th>Cliente</th>
            <th>Servicio</th>
            <th>Monto</th>
            <th>Pago</th>
            <th>Notas</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${rows || '<tr><td colspan="6"><div class="empty-state"><p>Sin ventas este día</p></div></td></tr>'}
        </tbody>
      </table>
    </div>
  `;
}

function changeSalesDate(delta) {
  const d = new Date(salesDate);
  d.setDate(d.getDate() + delta);
  salesDate = d.toISOString().split('T')[0];
  renderSales();
}

function goSalesToday() {
  salesDate = todayStr();
  renderSales();
}

async function openSaleModal() {
  document.getElementById('form-sale').reset();
  document.getElementById('s-date').value = salesDate;

  try {
    const [customers, services] = await Promise.all([
      api('/api/customers'),
      api('/api/services')
    ]);

    const custSelect = document.getElementById('s-customer');
    custSelect.innerHTML = '<option value="">Sin cliente (venta directa)</option>' +
      customers.map(c => `<option value="${c.id}">${escapeHtml(c.name)} ${c.phone ? '- ' + escapeHtml(c.phone) : ''}</option>`).join('');

    const servSelect = document.getElementById('s-service');
    servSelect.innerHTML = '<option value="">Seleccionar servicio...</option>' +
      services.map(s => `<option value="${s.id}">${escapeHtml(s.name)} - ${escapeHtml(formatCurrency(s.price))}</option>`).join('');

    // Fill amount when service selected
    servSelect.onchange = () => {
      const selected = services.find(s => s.id === parseInt(servSelect.value));
      if (selected) document.getElementById('s-amount').value = selected.price;
    };

    openModal('modal-sale');
  } catch (err) { toast(err.message, 'error'); }
}

async function saveSale() {
  const data = {
    customer_id: parseInt(document.getElementById('s-customer').value) || null,
    service_id: parseInt(document.getElementById('s-service').value) || null,
    amount: parseFloat(document.getElementById('s-amount').value) || 0,
    payment_method: document.getElementById('s-payment').value,
    date: document.getElementById('s-date').value,
    notes: document.getElementById('s-notes').value.trim()
  };
  if (data.amount <= 0) { toast('Ingresa un monto válido', 'error'); return; }
  const btn = document.querySelector('#modal-sale .btn-primary');
  setLoading(btn, true, 'Guardando...');
  try {
    await api('/api/sales', { method: 'POST', body: JSON.stringify(data) });
    toast('Venta registrada', 'success');
    closeModal('modal-sale');
    renderSales();
  } catch (err) { toast(err.message, 'error'); }
  finally { setLoading(btn, false); }
}

async function deleteSale(id) {
  if (!confirm('¿Eliminar esta venta?')) return;
  try {
    await api(`/api/sales/${id}`, { method: 'DELETE' });
    toast('Venta eliminada', 'success');
    renderSales();
  } catch (err) { toast(err.message, 'error'); }
}

// ==================== WHATSAPP ====================

let waPollTimer = null;
let waSelectedConv = null;

async function renderWhatsApp() {
  const el = document.getElementById('main-content');
  document.getElementById('header-actions').innerHTML = '';
  el.innerHTML = '<div class="spinner"></div>';
  if (waPollTimer) clearInterval(waPollTimer);
  try {
    const status = await api('/api/whatsapp/status');
    if (status.status === 'connected') {
      await renderWAConnected(el);
      waPollTimer = setInterval(() => pollWA(el), 3000);
    } else {
      renderWADisconnected(el, status);
      waPollTimer = setInterval(() => pollWA(el), 2000);
    }
  } catch (err) {
    el.innerHTML = `<div class="empty-state"><p>Error: ${escapeHtml(err.message)}</p></div>`;
  }
}

async function pollWA(el) {
  try {
    const status = await api('/api/whatsapp/status');
    const hasChat = document.getElementById('wa-chat-area');
    if (status.status === 'connected' && !hasChat) {
      await renderWAConnected(el);
    } else if (status.status !== 'connected' && hasChat) {
      renderWADisconnected(el, status);
    } else if (!hasChat) {
      renderWADisconnected(el, status);
    }
    // Actualizar lista de conversaciones si estamos conectados
    if (status.status === 'connected') {
      const convList = document.getElementById('wa-conv-items');
      if (convList) {
        const convs = await api('/api/whatsapp/conversations');
        convList.innerHTML = convs.length === 0 ? '<div style="padding:20px;text-align:center;font-size:13px;color:var(--text-muted);">Sin conversaciones aún</div>' :
          convs.map(c => `
            <div class="wa-conv-item ${waSelectedConv == c.id ? 'active' : ''}" data-conv-id="${c.id}" onclick="selectWAConv(${c.id})">
              <div style="display:flex;justify-content:space-between;align-items:start;">
                <strong style="font-size:13px;">${escapeHtml(c.name || c.phone)}</strong>
                <span style="font-size:10px;color:var(--text-muted);">${c.mode === 'AI' ? '🤖' : '👤'}</span>
              </div>
              <div style="font-size:11px;color:var(--text-muted);margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                ${c.last_message ? escapeHtml(c.last_message.slice(0, 40)) : 'Sin mensajes'}
              </div>
            </div>
          `).join('');
      }
    }
    if (waSelectedConv) {
      const conv = await api(`/api/whatsapp/conversations/${waSelectedConv}`);
      const msgsDiv = document.getElementById('wa-messages');
      if (msgsDiv) {
        msgsDiv.innerHTML = conv.messages.map(m => `
          <div class="wa-msg wa-msg-${escapeHtml(m.role)}">
            <div class="wa-msg-text">${escapeHtml(m.content)}</div>
            <div class="wa-msg-time">${new Date(m.created_at).toLocaleTimeString('es-AR', {hour:'2-digit',minute:'2-digit'})}</div>
          </div>
        `).join('');
        msgsDiv.scrollTop = msgsDiv.scrollHeight;
      }
    }
  } catch (e) { console.error('[pollWA]', e); }
}

function renderWADisconnected(el, status) {
  const pairingCode = status.status === 'pairing' ? status.qr_string : '';
  el.innerHTML = `
    <div style="max-width:480px;margin:40px auto;text-align:center;">
      <div style="font-size:64px;margin-bottom:20px;">💬</div>
      <h2 style="font-size:18px;font-weight:600;margin-bottom:8px;">WhatsApp</h2>
      ${status.status === 'qr' ? `
        <p style="font-size:13px;color:var(--text-muted);margin-bottom:16px;">Escaneá el QR con WhatsApp para conectar tu número</p>
        <div id="wa-qr-container" style="background:#fff;display:inline-block;padding:16px;border-radius:12px;">
          <img src="https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(status.qr_string)}" style="width:280px;height:280px;image-rendering:pixelated;">
        </div>
        <div style="margin-top:16px;font-size:13px;color:var(--text-muted);">⏳ Esperando escaneo...</div>
        <div style="margin-top:24px;padding-top:20px;border-top:1px solid var(--border);">
          <p style="font-size:12px;color:var(--text-muted);margin-bottom:12px;">¿No podés escanear QR? Usá el código de vinculación:</p>
          <button class="btn btn-secondary" onclick="showPairingModal()">Conectar con código</button>
        </div>
      ` : status.status === 'pairing_wait' ? `
        <p style="font-size:13px;color:var(--text-muted);margin-bottom:16px;">Generando código de vinculación...</p>
        <div class="spinner"></div>
      ` : status.status === 'pairing' ? `
        <p style="font-size:13px;color:var(--text-muted);margin-bottom:8px;">Ingresá este código en WhatsApp:</p>
        <p style="font-size:12px;color:var(--text-muted);margin-bottom:20px;">
          WhatsApp > Dispositivos vinculados > Vincular con número de teléfono
        </p>
        <div style="background:var(--bg-card);border:2px dashed var(--accent);border-radius:16px;padding:24px 32px;display:inline-block;margin-bottom:16px;">
          <span style="font-size:42px;font-weight:700;letter-spacing:8px;color:var(--accent);font-family:monospace;">${escapeHtml(pairingCode)}</span>
        </div>
        <div style="margin-top:16px;font-size:13px;color:var(--text-muted);">⏳ Esperando vinculación...</div>
      ` : status.status === 'pairing_error' ? `
        <p style="font-size:13px;color:var(--danger);margin-bottom:16px;">Error: ${escapeHtml(status.qr_string || '')}</p>
        <p style="font-size:13px;color:var(--text-muted);margin-bottom:20px;">Conectá tu número de WhatsApp para que tus clientes puedan sacar turnos automáticamente.</p>
        <button class="btn btn-primary" onclick="connectWA()">Conectar con QR</button>
        <button class="btn btn-secondary" onclick="showPairingModal()" style="margin-left:8px;">Conectar con código</button>
      ` : status.status === 'connecting' ? `
        <p style="font-size:13px;color:var(--text-muted);margin-bottom:16px;">Conectando...</p>
        <div class="spinner"></div>
      ` : `
        <p style="font-size:13px;color:var(--text-muted);margin-bottom:20px;">Conectá tu número de WhatsApp para que tus clientes puedan sacar turnos automáticamente.</p>
        <button class="btn btn-primary" onclick="connectWA()">Conectar con QR</button>
        <div style="margin-top:24px;padding-top:20px;border-top:1px solid var(--border);">
          <p style="font-size:12px;color:var(--text-muted);margin-bottom:12px;">¿No podés escanear QR? Usá el código de vinculación:</p>
          <button class="btn btn-secondary" onclick="showPairingModal()">Conectar con código</button>
        </div>
      `}
    </div>
  `;
}

async function renderWAConnected(el) {
  const convs = await api('/api/whatsapp/conversations');
  const activeConv = waSelectedConv ? convs.find(c => c.id == waSelectedConv) : null;

  const badge = document.getElementById('wa-badge');
  const aiCount = convs.filter(c => c.mode === 'AI').length;
  if (aiCount > 0) { badge.textContent = 'IA'; badge.style.display = ''; } else badge.style.display = 'none';

  el.innerHTML = `
    <div id="wa-layout" style="display:flex;gap:0;height:calc(100vh - 120px);">
      <div id="wa-conv-list" style="width:300px;min-width:300px;background:var(--bg-card);border-radius:12px;display:flex;flex-direction:column;overflow:hidden;">
        <div style="padding:14px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;">
          <strong style="font-size:14px;">Conversaciones</strong>
          <button class="btn btn-sm btn-danger" onclick="disconnectWA()" title="Desconectar" style="font-size:11px;">Desconectar</button>
        </div>
        <div id="wa-conv-items" style="flex:1;overflow-y:auto;">
          ${convs.length === 0 ? '<div style="padding:20px;text-align:center;font-size:13px;color:var(--text-muted);">Sin conversaciones aún</div>' :
            convs.map(c => `
              <div class="wa-conv-item ${activeConv && activeConv.id == c.id ? 'active' : ''}" data-conv-id="${c.id}" onclick="selectWAConv(${c.id})">
                <div style="display:flex;justify-content:space-between;align-items:start;">
                  <strong style="font-size:13px;">${c.name || c.phone}</strong>
                  <span style="font-size:10px;color:var(--text-muted);">${c.mode === 'AI' ? '🤖' : '👤'}</span>
                </div>
                <div style="font-size:11px;color:var(--text-muted);margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                  ${c.last_message ? c.last_message.slice(0, 40) : 'Sin mensajes'}
                </div>
              </div>
            `).join('')}
        </div>
      </div>
      <div id="wa-chat-area" style="flex:1;margin-left:12px;background:var(--bg-card);border-radius:12px;display:flex;flex-direction:column;overflow:hidden;">
        ${activeConv ? `
          <div style="padding:14px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;">
            <div>
              <strong style="font-size:14px;">${activeConv.name || activeConv.phone}</strong>
              <span style="font-size:11px;color:var(--text-muted);margin-left:8px;">${activeConv.phone}</span>
            </div>
            <div style="display:flex;gap:6px;align-items:center;">
              <span id="wa-mode-label" style="font-size:11px;padding:3px 8px;border-radius:6px;font-weight:500;background:${activeConv.mode === 'AI' ? 'rgba(48,209,88,0.15)' : 'rgba(255,214,10,0.15)'};color:${activeConv.mode === 'AI' ? '#30d158' : '#ffd60a'};">
                ${activeConv.mode === 'AI' ? '🤖 IA' : '👤 Humano'}
              </span>
              <button class="btn btn-sm ${activeConv.mode === 'AI' ? 'btn-secondary' : 'btn-primary'}" onclick="toggleWAMode(${activeConv.id})" style="font-size:11px;">
                Cambiar a ${activeConv.mode === 'AI' ? 'Humano' : 'IA'}
              </button>
              <button class="btn btn-sm btn-danger" onclick="deleteWAConv(${activeConv.id})" style="font-size:11px;">🗑️</button>
            </div>
          </div>
          <div id="wa-messages" style="flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:8px;">
            ${activeConv.messages ? activeConv.messages.map(m => `
              <div class="wa-msg wa-msg-${m.role}">
                <div class="wa-msg-text">${m.content}</div>
                <div class="wa-msg-time">${new Date(m.created_at).toLocaleTimeString('es-AR', {hour:'2-digit',minute:'2-digit'})}</div>
              </div>
            `).join('') : ''}
          </div>
          <div style="padding:12px 14px;border-top:1px solid var(--border);display:flex;gap:8px;">
            <input type="text" id="wa-msg-input" placeholder="${activeConv.mode === 'AI' ? '🤖 El bot responde automáticamente' : 'Escribí un mensaje...'}" style="flex:1;padding:10px 14px;background:var(--bg-input);border:1px solid var(--border);border-radius:8px;color:var(--text-primary);font-size:13px;outline:none;" ${activeConv.mode === 'AI' ? 'disabled' : ''}>
            <button class="btn btn-primary" id="wa-send-btn" onclick="sendWAMessage(${activeConv.id})" ${activeConv.mode === 'AI' ? 'disabled' : ''}>Enviar</button>
          </div>
        ` : `
          <div style="flex:1;display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:14px;">
            Seleccioná una conversación
          </div>
        `}
      </div>
    </div>
  `;
}

function showPairingModal() {
  const phone = prompt('Ingresá tu número de WhatsApp (ej: 2644701979, sin 0 ni 15):');
  if (!phone) return;
  const cleaned = phone.replace(/[^0-9]/g, '');
  if (cleaned.length < 10) {
    toast('Número inválido. Incluí código de área sin 0 ni 15', 'error');
    return;
  }
  pairWA(cleaned);
}

async function pairWA(phone) {
  try {
    await api('/api/whatsapp/pair', { method: 'POST', body: JSON.stringify({ phone }) });
    renderWhatsApp();
  } catch (err) { toast(err.message, 'error'); }
}

async function connectWA() {
  const btns = document.querySelectorAll('.btn-primary, #wa-layout .btn');
  for (const b of btns) {
    if (b.textContent.includes('Conectar')) {
      b.disabled = true; b.textContent = 'Conectando...'; break;
    }
  }
  try {
    await api('/api/whatsapp/connect', { method: 'POST' });
  } catch (err) { toast(err.message, 'error'); }
}

async function disconnectWA() {
  if (!confirm('¿Desconectar WhatsApp?')) return;
  try {
    await api('/api/whatsapp/disconnect', { method: 'POST' });
    waSelectedConv = null;
    renderWhatsApp();
  } catch (err) { toast(err.message, 'error'); }
}

async function selectWAConv(id) {
  waSelectedConv = id;
  document.querySelectorAll('.wa-conv-item').forEach(el => el.classList.toggle('active', el.dataset.convId == id));
  const chatArea = document.getElementById('wa-chat-area');
  if (chatArea) chatArea.innerHTML = '<div class="spinner"></div>';
  try {
    const conv = await api(`/api/whatsapp/conversations/${id}`);
    renderWAChatDetail(conv);
  } catch (err) {
    if (chatArea) chatArea.innerHTML = '<div style="flex:1;display:flex;align-items:center;justify-content:center;color:var(--text-muted);">Error al cargar. Click en otra conversación.</div>';
  }
}

function renderWAChatDetail(conv) {
  const chatArea = document.getElementById('wa-chat-area');
  if (!chatArea) return;
  chatArea.innerHTML = `
    <div style="padding:14px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;">
      <div>
        <strong style="font-size:14px;">${escapeHtml(conv.name || conv.phone)}</strong>
        <span style="font-size:11px;color:var(--text-muted);margin-left:8px;">${escapeHtml(conv.phone)}</span>
      </div>
      <div style="display:flex;gap:6px;align-items:center;">
        <span id="wa-mode-label" style="font-size:11px;padding:3px 8px;border-radius:6px;font-weight:500;background:${conv.mode === 'AI' ? 'rgba(48,209,88,0.15)' : 'rgba(255,214,10,0.15)'};color:${conv.mode === 'AI' ? '#30d158' : '#ffd60a'};">
          ${conv.mode === 'AI' ? '🤖 IA' : '👤 Humano'}
        </span>
        <button class="btn btn-sm ${conv.mode === 'AI' ? 'btn-secondary' : 'btn-primary'}" onclick="toggleWAMode(${conv.id})" style="font-size:11px;">
          Cambiar a ${conv.mode === 'AI' ? 'Humano' : 'IA'}
        </button>
        <button class="btn btn-sm btn-danger" onclick="deleteWAConv(${conv.id})" style="font-size:11px;">🗑️</button>
      </div>
    </div>
    <div id="wa-messages" style="flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:8px;">
      ${conv.messages ? conv.messages.map(m => `
        <div class="wa-msg wa-msg-${escapeHtml(m.role)}">
          <div class="wa-msg-text">${escapeHtml(m.content)}</div>
          <div class="wa-msg-time">${new Date(m.created_at).toLocaleTimeString('es-AR', {hour:'2-digit',minute:'2-digit'})}</div>
        </div>
      `).join('') : ''}
    </div>
    <div style="padding:12px 14px;border-top:1px solid var(--border);display:flex;gap:8px;">
      <input type="text" id="wa-msg-input" placeholder="${conv.mode === 'AI' ? '🤖 El bot responde automáticamente' : 'Escribí un mensaje...'}" style="flex:1;padding:10px 14px;background:var(--bg-input);border:1px solid var(--border);border-radius:8px;color:var(--text-primary);font-size:13px;outline:none;" ${conv.mode === 'AI' ? 'disabled' : ''}>
      <button class="btn btn-primary" id="wa-send-btn" onclick="sendWAMessage(${conv.id})" ${conv.mode === 'AI' ? 'disabled' : ''}>Enviar</button>
    </div>
  `;
  const msgsDiv = document.getElementById('wa-messages');
  if (msgsDiv) msgsDiv.scrollTop = msgsDiv.scrollHeight;
}

async function toggleWAMode(id) {
  const conv = await api(`/api/whatsapp/conversations/${id}`);
  const newMode = conv.mode === 'AI' ? 'HUMAN' : 'AI';
  try {
    await api(`/api/whatsapp/conversations/${id}/mode`, { method: 'POST', body: JSON.stringify({ mode: newMode }) });
    waSelectedConv = id;
    const updated = await api(`/api/whatsapp/conversations/${id}`);
    renderWAChatDetail(updated);
  } catch (err) { toast(err.message, 'error'); }
}

async function sendWAMessage(id) {
  const input = document.getElementById('wa-msg-input');
  const content = input.value.trim();
  if (!content) return;
  input.value = '';
  input.disabled = true;
  try {
    await api(`/api/whatsapp/conversations/${id}/messages`, { method: 'POST', body: JSON.stringify({ content }) });
    waSelectedConv = id;
    const conv = await api(`/api/whatsapp/conversations/${id}`);
    renderWAChatDetail(conv);
  } catch (err) { toast(err.message, 'error'); }
  input.disabled = false;
  input.focus();
}

async function deleteWAConv(id) {
  if (!confirm('¿Eliminar esta conversación?')) return;
  try {
    await api(`/api/whatsapp/conversations/${id}`, { method: 'DELETE' });
    waSelectedConv = null;
    renderWhatsApp();
  } catch (err) { toast(err.message, 'error'); }
}

// ==================== SETTINGS ====================

async function renderSettings() {
  const el = document.getElementById('main-content');
  try {
    const [allEmployees, allServices] = await Promise.all([
      fetch('/api/employees?all=1').then(r => r.json()),
      fetch('/api/services?all=1').then(r => r.json())
    ]);

    el.innerHTML = `
      <div class="settings-section">
        <h3>👤 Empleados</h3>
        <div id="employees-list">
          ${allEmployees.map(e => `
            <div class="settings-item">
              <div class="item-info">
                ${escapeHtml(e.name)}
                ${e.phone ? `<span>${escapeHtml(e.phone)}</span>` : ''}
                ${!e.active ? `<span style="color:var(--text-muted);">(inactivo)</span>` : ''}
              </div>
              <div class="item-actions">
                <button class="btn btn-sm btn-secondary" onclick='editEmployee(${e.id}, "${escapeHtml(e.name)}", "${escapeHtml(e.phone || '')}")'>✏️</button>
                <button class="btn btn-sm btn-danger" onclick="deleteEmployee(${e.id})">🗑️</button>
              </div>
            </div>
          `).join('') || '<div class="empty-state"><p>Sin empleados</p></div>'}
        </div>
        <div class="add-bar">
          <input type="text" id="new-emp-name" placeholder="Nombre del empleado" style="flex:1;">
          <input type="text" id="new-emp-phone" placeholder="Teléfono">
          <button class="btn btn-sm btn-primary" onclick="addEmployee()">Agregar</button>
        </div>
      </div>

      <div class="settings-section">
        <h3>💇 Servicios</h3>
        <div id="services-list">
          ${allServices.map(s => `
            <div class="settings-item">
              <div class="item-info">
                ${escapeHtml(s.name)}
                <span>${escapeHtml(formatCurrency(s.price))} · ${escapeHtml(s.duration)} min</span>
                ${!s.active ? `<span style="color:var(--text-muted);">(inactivo)</span>` : ''}
              </div>
              <div class="item-actions">
                <button class="btn btn-sm btn-secondary" onclick='editService(${s.id}, "${escapeHtml(s.name)}", ${s.price}, ${s.duration})'>✏️</button>
                <button class="btn btn-sm btn-danger" onclick="deleteService(${s.id})">🗑️</button>
              </div>
            </div>
          `).join('') || '<div class="empty-state"><p>Sin servicios</p></div>'}
        </div>
        <div class="add-bar">
          <input type="text" id="new-srv-name" placeholder="Nombre del servicio" style="flex:1;">
          <input type="number" id="new-srv-price" placeholder="Precio $" style="width:120px;">
          <input type="number" id="new-srv-duration" placeholder="Min" style="width:80px;" value="30">
          <button class="btn btn-sm btn-primary" onclick="addService()">Agregar</button>
        </div>
      </div>
    `;
  } catch (err) {
    el.innerHTML = `<div class="empty-state"><p>Error: ${escapeHtml(err.message)}</p></div>`;
  }
}

async function addEmployee() {
  const name = document.getElementById('new-emp-name').value.trim();
  if (!name) { toast('Nombre requerido', 'error'); return; }
  const phone = document.getElementById('new-emp-phone').value.trim();
  try {
    await api('/api/employees', { method: 'POST', body: JSON.stringify({ name, phone }) });
    toast('Empleado agregado', 'success');
    renderSettings();
  } catch (err) { toast(err.message, 'error'); }
}

async function editEmployee(id, currentName, currentPhone) {
  const name = prompt('Nombre del empleado:', currentName);
  if (!name) return;
  const phone = prompt('Teléfono:', currentPhone) || '';
  try {
    await api(`/api/employees/${id}`, { method: 'PUT', body: JSON.stringify({ name, phone }) });
    toast('Empleado actualizado', 'success');
    renderSettings();
  } catch (err) { toast(err.message, 'error'); }
}

async function deleteEmployee(id) {
  if (!confirm('¿Eliminar este empleado?')) return;
  try {
    await api(`/api/employees/${id}`, { method: 'DELETE' });
    toast('Empleado eliminado', 'success');
    renderSettings();
  } catch (err) { toast(err.message, 'error'); }
}

async function addService() {
  const name = document.getElementById('new-srv-name').value.trim();
  if (!name) { toast('Nombre requerido', 'error'); return; }
  const price = parseFloat(document.getElementById('new-srv-price').value) || 0;
  const duration = parseInt(document.getElementById('new-srv-duration').value) || 30;
  try {
    await api('/api/services', { method: 'POST', body: JSON.stringify({ name, price, duration }) });
    toast('Servicio agregado', 'success');
    renderSettings();
  } catch (err) { toast(err.message, 'error'); }
}

async function editService(id, currentName, currentPrice, currentDuration) {
  const name = prompt('Nombre del servicio:', currentName);
  if (!name) return;
  const price = parseFloat(prompt('Precio $:', currentPrice)) || 0;
  const duration = parseInt(prompt('Duración (min):', currentDuration)) || 30;
  try {
    await api(`/api/services/${id}`, { method: 'PUT', body: JSON.stringify({ name, price, duration }) });
    toast('Servicio actualizado', 'success');
    renderSettings();
  } catch (err) { toast(err.message, 'error'); }
}

async function deleteService(id) {
  if (!confirm('¿Desactivar este servicio?')) return;
  try {
    await api(`/api/services/${id}`, { method: 'DELETE' });
    toast('Servicio desactivado', 'success');
    renderSettings();
  } catch (err) { toast(err.message, 'error'); }
}

// ==================== INIT ====================

document.addEventListener('DOMContentLoaded', () => {
  checkSession();
  ['form-customer', 'form-appointment', 'form-sale'].forEach(id => {
    const f = document.getElementById(id);
    if (f) f.addEventListener('submit', e => e.preventDefault());
  });
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-overlay.open').forEach(m => m.classList.remove('open'));
  }
});
