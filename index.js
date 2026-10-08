const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');
const net = require('net');

const app = express();
app.use(express.json());

const DB_PATH = process.env.DB_PATH || './database.db';
const db = new sqlite3.Database(DB_PATH);

// Inicializar BD Normalizada (Relación 1 a Muchos)
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS usuarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS publicaciones (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario_id INTEGER,
    titulo TEXT NOT NULL,
    FOREIGN KEY(usuario_id) REFERENCES usuarios(id)
  )`);
});

const formatResp = (res, statusCode, data) => res.status(statusCode).json({ statusCode, data });

// 1. GET - Obtener todos los usuarios
app.get('/api/usuarios', (req, res) => {
  db.all('SELECT * FROM usuarios', [], (err, rows) => {
    if (err) return formatResp(res, 500, err.message);
    formatResp(res, 200, rows);
  });
});

// 2. GET - Obtener usuario por ID
app.get('/api/usuarios/:id', (req, res) => {
  db.get('SELECT * FROM usuarios WHERE id = ?', [req.params.id], (err, row) => {
    if (err) return formatResp(res, 500, err.message);
    formatResp(res, 200, row || null);
  });
});

// 3. POST - Crear usuario
app.post('/api/usuarios', (req, res) => {
  const { nombre, email } = req.body;
  db.run('INSERT INTO usuarios (nombre, email) VALUES (?, ?)', [nombre, email], function(err) {
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
  formatResp(res, 200, { status: 'Online', mensaje: 'Pruebas aqui en la uni', timestamp: new Date() });
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

const PORT = process.env.PORT || 80;
if (require.main === module) {
  app.listen(PORT, () => console.log(`Servidor HTTP ejecutándose en puerto ${PORT}`));
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