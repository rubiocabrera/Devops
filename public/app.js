// Utilidades compartidas del frontend (sesión con JWT en localStorage).
const TOKEN_KEY = 'webapp_token';
const USER_KEY = 'webapp_user';

const session = {
  get token() { return localStorage.getItem(TOKEN_KEY); },
  get user() {
    try { return JSON.parse(localStorage.getItem(USER_KEY)); } catch (e) { return null; }
  },
  save({ token, user }) {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  },
  clear() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  },
};

async function apiFetch(url, { method = 'GET', body, auth = true } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth && session.token) headers.Authorization = `Bearer ${session.token}`;
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({ statusCode: res.status, data: 'Respuesta inválida' }));
  if (res.status === 401 && auth) {
    session.clear();
    window.location.href = '/index.html';
  }
  return { ok: res.ok, status: res.status, data: json.data };
}

function showAlert(el, message, type = 'error') {
  el.textContent = message;
  el.className = `alert show ${type}`;
}

function escapeHtml(s) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(s).replace(/[&<>"']/g, (c) => map[c]);
}
