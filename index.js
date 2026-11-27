// La telemetría debe cargarse ANTES que express/http para poder instrumentarlos.
const telemetry = require('./telemetry');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');
const net = require('net');

const app = express();
app.use(express.json());
app.use(telemetry.httpMetricsMiddleware);
app.use(express.static(path.join(__dirname, 'public')));

const DB_PATH = process.env.DB_PATH || './database.db';
const db = telemetry.instrumentDb(new sqlite3.Database(DB_PATH));
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-cambiar-en-produccion';
const USER_COLUMNS = 'id, nombre, email';

// Inicializar BD Normalizada (Relación 1 a Muchos)
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS usuarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT
  )`);

  // Migración para bases existentes creadas antes de agregar autenticación.
  db.all('PRAGMA table_info(usuarios)', [], (err, cols) => {
    if (!err && cols && !cols.some((c) => c.name === 'password_hash')) {
      db.run('ALTER TABLE usuarios ADD COLUMN password_hash TEXT');
    }
  });

  db.run(`CREATE TABLE IF NOT EXISTS publicaciones (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario_id INTEGER,
    titulo TEXT NOT NULL,
    FOREIGN KEY(usuario_id) REFERENCES usuarios(id)
  )`);
});

const formatResp = (res, statusCode, data) => res.status(statusCode).json({ statusCode, data });

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const signToken = (user) =>
  jwt.sign({ sub: user.id, email: user.email, nombre: user.nombre }, JWT_SECRET, { expiresIn: '8h' });

// Middleware: exige "Authorization: Bearer <token>" válido.
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return formatResp(res, 401, 'Token de autenticación requerido');
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    return formatResp(res, 401, 'Token inválido o expirado');
  }
}

// ==========================================================================
// AUTENTICACIÓN: Register / Login / Me
// ==========================================================================
app.post('/api/auth/register', async (req, res) => {
  const { nombre, email, password } = req.body || {};
  if (!nombre || !email || !password) {
    return formatResp(res, 400, 'Se requieren nombre, email y password');
  }
  if (!EMAIL_RE.test(email)) return formatResp(res, 400, 'Email con formato inválido');
  if (String(password).length < 6) {
    return formatResp(res, 400, 'La contraseña debe tener al menos 6 caracteres');
  }
  const hash = await bcrypt.hash(String(password), 10);
  db.run(
    'INSERT INTO usuarios (nombre, email, password_hash) VALUES (?, ?, ?)',
    [nombre, email, hash],
    function (err) {
      if (err) {
        const msg = /UNIQUE/.test(err.message) ? 'El email ya está registrado' : err.message;
        telemetry.log('warn', 'auth_register_failed', { email, reason: msg });
        return formatResp(res, 409, msg);
      }
      const user = { id: this.lastID, nombre, email };
      telemetry.log('info', 'auth_register_ok', { user_id: user.id, email });
      formatResp(res, 201, { user, token: signToken(user) });
    }
  );
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return formatResp(res, 400, 'Se requieren email y password');
  db.get('SELECT * FROM usuarios WHERE email = ?', [email], async (err, row) => {
    if (err) return formatResp(res, 500, err.message);
    const ok = row && row.password_hash && (await bcrypt.compare(String(password), row.password_hash));
    if (!ok) {
      telemetry.log('warn', 'auth_login_failed', { email });
      return formatResp(res, 401, 'Credenciales inválidas');
    }
    const user = { id: row.id, nombre: row.nombre, email: row.email };
    telemetry.log('info', 'auth_login_ok', { user_id: user.id, email });
    formatResp(res, 200, { user, token: signToken(user) });
  });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  formatResp(res, 200, { id: req.user.sub, nombre: req.user.nombre, email: req.user.email });
});

// El CRUD de usuarios requiere sesión iniciada.
app.use('/api/usuarios', requireAuth);

// 1. GET - Obtener todos los usuarios
app.get('/api/usuarios', (req, res) => {
  db.all(`SELECT ${USER_COLUMNS} FROM usuarios`, [], (err, rows) => {
    if (err) return formatResp(res, 500, err.message);
    formatResp(res, 200, rows);
  });
});

// 2. GET - Obtener usuario por ID
app.get('/api/usuarios/:id', (req, res) => {
  db.get(`SELECT ${USER_COLUMNS} FROM usuarios WHERE id = ?`, [req.params.id], (err, row) => {
    if (err) return formatResp(res, 500, err.message);
    formatResp(res, 200, row || null);
  });
});

// 3. POST - Crear usuario
app.post('/api/usuarios', async (req, res) => {
  const { nombre, email, password } = req.body;
  const hash = password ? await bcrypt.hash(String(password), 10) : null;
  db.run('INSERT INTO usuarios (nombre, email, password_hash) VALUES (?, ?, ?)', [nombre, email, hash], function(err) {
    if (err) return formatResp(res, 400, err.message);
    formatResp(res, 200, { id: this.lastID, nombre, email });
  });
});

// PUT - Actualizar usuario
app.put('/api/usuarios/:id', (req, res) => {
  const { nombre, email } = req.body;
  if (!nombre && !email) {
    return formatResp(res, 400, 'Se requiere al menos nombre o email para actualizar');
  }
  const fields = [];
  const values = [];
  if (nombre) { fields.push('nombre = ?'); values.push(nombre); }
  if (email) { fields.push('email = ?'); values.push(email); }
  values.push(req.params.id);
  db.run(`UPDATE usuarios SET ${fields.join(', ')} WHERE id = ?`, values, function (err) {
    if (err) return formatResp(res, 400, err.message);
    formatResp(res, 200, { updatedRows: this.changes });
  });
});

// 4. DELETE - Eliminar usuario
app.delete('/api/usuarios/:id', (req, res) => {
  db.run('DELETE FROM usuarios WHERE id = ?', [req.params.id], function(err) {
    if (err) return formatResp(res, 500, err.message);
    formatResp(res, 200, { deletedRows: this.changes });
  });
});

// 5. GET - Obtener publicaciones
app.get('/api/publicaciones', (req, res) => {
  db.all('SELECT * FROM publicaciones', [], (err, rows) => {
    if (err) return formatResp(res, 500, err.message);
    formatResp(res, 200, rows);
  });
});

// 6. POST - Crear publicación
app.post('/api/publicaciones', (req, res) => {
  const { usuario_id, titulo } = req.body;
  db.run('INSERT INTO publicaciones (usuario_id, titulo) VALUES (?, ?)', [usuario_id, titulo], function(err) {
    if (err) return formatResp(res, 400, err.message);
    formatResp(res, 200, { id: this.lastID, usuario_id, titulo });
  });
});

// PUT - Actualizar publicación
app.put('/api/publicaciones/:id', (req, res) => {
  const { titulo } = req.body;
  if (!titulo) {
    return formatResp(res, 400, 'Se requiere el campo titulo para actualizar');
  }
  db.run('UPDATE publicaciones SET titulo = ? WHERE id = ?', [titulo, req.params.id], function (err) {
    if (err) return formatResp(res, 400, err.message);
    formatResp(res, 200, { updatedRows: this.changes });
  });
});

// 7. DELETE - Eliminar publicación
app.delete('/api/publicaciones/:id', (req, res) => {
  db.run('DELETE FROM publicaciones WHERE id = ?', [req.params.id], function(err) {
    if (err) return formatResp(res, 500, err.message);
    formatResp(res, 200, { deletedRows: this.changes });
  });
});

// 8. GET - Estado del Servidor
app.get('/api/status', (req, res) => {
  formatResp(res, 200, { status: 'Caido', mensaje: 'Pruebas aqui en la UTEQ', timestamp: new Date() });
});

// 9. POST - Backup de la Base de Datos
app.post('/api/admin/backup', (req, res) => {
  const backupPath = `./backup-${Date.now()}.db`;
  fs.copyFile(DB_PATH, backupPath, (err) => {
    if (err) return formatResp(res, 500, 'Error al crear backup');
    formatResp(res, 200, { message: 'Backup creado con éxito', file: backupPath });
  });
});

// 10. POST - Vaciar la Base de Datos
app.post('/api/admin/clear', (req, res) => {
  db.serialize(() => {
    db.run('DELETE FROM publicaciones');
    db.run('DELETE FROM usuarios', [], (err) => {
      if (err) return formatResp(res, 500, err.message);
      formatResp(res, 200, { message: 'Base de datos vaciada' });
    });
  });
});

// Manejador global de errores: registra la excepción (log + span) y responde 500.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  telemetry.log('error', 'unhandled_exception', {
    error: err.message,
    stack: err.stack,
    'http.method': req.method,
    'http.path': req.path,
  });
  formatResp(res, err.status || 500, err.expose ? err.message : 'Error interno del servidor');
});

// Usuario administrador inicial (solo si se definen las variables de entorno).
function seedAdmin() {
  const { ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) return;
  const hash = bcrypt.hashSync(ADMIN_PASSWORD, 10);
  db.run(
    'INSERT OR IGNORE INTO usuarios (nombre, email, password_hash) VALUES (?, ?, ?)',
    [process.env.ADMIN_NAME || 'Administrador', ADMIN_EMAIL, hash]
  );
}

const PORT = process.env.PORT || 80;
if (require.main === module) {
  db.serialize(seedAdmin);
  app.listen(PORT, () => telemetry.log('info', 'server_started', { port: Number(PORT) }));
}

// ==========================================================================
// Servidor TCP crudo (protocolo de texto propio) sobre la tabla `usuarios`
// Formato de comandos, uno por línea, terminado en '\n':
//   {insert:<element>}   <element> = mismo body JSON usado en POST /api/usuarios
//   {get:<element>}      <element> = id numérico del usuario a consultar
// Responde una línea JSON por comando con el mismo schema {statusCode, data}
// ==========================================================================

const TCP_PORT = process.env.TCP_PORT || 6061;

function parseTcpCommand(raw) {
  const match = raw.trim().match(/^\{(insert|get):([\s\S]*)\}$/);
  if (!match) return null;
  return { action: match[1], payload: match[2] };
}

function tcpInsert(payload, respond) {
  let body;
  try {
    body = JSON.parse(payload);
  } catch (e) {
    return respond({ statusCode: 400, data: 'JSON inválido en insert' });
  }
  const { nombre, email } = body;
  if (!nombre || !email) {
    return respond({ statusCode: 400, data: 'Se requieren los campos nombre y email' });
  }
  db.run('INSERT INTO usuarios (nombre, email) VALUES (?, ?)', [nombre, email], function (err) {
    if (err) return respond({ statusCode: 400, data: err.message });
    respond({ statusCode: 200, data: { id: this.lastID, nombre, email } });
  });
}

function tcpGet(payload, respond) {
  const id = Number(payload.trim());
  if (!Number.isInteger(id)) {
    return respond({ statusCode: 400, data: 'id inválido en get' });
  }
  db.get('SELECT * FROM usuarios WHERE id = ?', [id], (err, row) => {
    if (err) return respond({ statusCode: 500, data: err.message });
    respond({ statusCode: 200, data: row || null });
  });
}

const tcpServer = net.createServer((socket) => {
  socket.setEncoding('utf8');
  let buffer = '';

  socket.on('data', (chunk) => {
    buffer += chunk;
    let newlineIndex;
    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (!line.trim()) continue;

      const respond = (result) => socket.write(JSON.stringify(result) + '\n');
      const command = parseTcpCommand(line);
      if (!command) {
        respond({ statusCode: 400, data: 'Comando no reconocido. Usa {insert:<json>} o {get:<id>}' });
        continue;
      }
      if (command.action === 'insert') tcpInsert(command.payload, respond);
      else if (command.action === 'get') tcpGet(command.payload, respond);
    }
  });

  socket.on('error', () => {});
});

if (require.main === module) {
  tcpServer.listen(TCP_PORT, () => console.log(`Servidor TCP escuchando en puerto ${TCP_PORT}`));
}

module.exports = { app, db, tcpServer };