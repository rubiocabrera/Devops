// Pruebas unitarias "puras": la base de datos se simula por completo con
// jest.spyOn (datos mockup), aislando la lógica de cada endpoint sin tocar
// nunca un archivo SQLite real. Complementa a tests/api.test.js, que sí
// ejercita la base de datos real (pruebas de integración).

const fs = require('fs');
const path = require('path');

const UNIT_DB_PATH = path.join(__dirname, 'test-database-unit.db');
if (fs.existsSync(UNIT_DB_PATH)) fs.unlinkSync(UNIT_DB_PATH);
process.env.DB_PATH = UNIT_DB_PATH;

const request = require('supertest');
const { app, db } = require('../index');
const api = require('./helpers/authedRequest')(app);

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll((done) => {
  db.close(() => {
    if (fs.existsSync(UNIT_DB_PATH)) fs.unlinkSync(UNIT_DB_PATH);
    done();
  });
});

const expectSchema = (body) => {
  expect(body).toHaveProperty('statusCode');
  expect(body).toHaveProperty('data');
};

// Mock helpers: simulan la firma real de sqlite3 (callback-based).
const mockRun = (implementation) =>
  jest.spyOn(db, 'run').mockImplementation(implementation);
const mockGet = (implementation) =>
  jest.spyOn(db, 'get').mockImplementation(implementation);
const mockAll = (implementation) =>
  jest.spyOn(db, 'all').mockImplementation(implementation);

// ==========================================================================
// 1. GET /api/status (no toca la base de datos: ya es una prueba unitaria pura)
// ==========================================================================
describe('[UNIT] GET /api/status', () => {
  test('responde 200 sin consultar la base de datos', async () => {
    const res = await api.get('/api/status');
    expect(res.status).toBe(200);
    expectSchema(res.body);
    expect(res.body.data.status).toBe('Online');
  });
});

// ==========================================================================
// 2. POST /api/usuarios
// ==========================================================================
describe('[UNIT] POST /api/usuarios', () => {
  test('caso de éxito con datos mockup: db.run simula una inserción exitosa', async () => {
    mockRun(function (sql, params, cb) {
      cb.call({ lastID: 42 }, null);
    });
    const res = await api
      .post('/api/usuarios')
      .send({ nombre: 'Mock User', email: 'mock@example.com' });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ id: 42, nombre: 'Mock User', email: 'mock@example.com' });
  });

  test('escenario de fallo con datos mockup: db.run simula un email duplicado (UNIQUE)', async () => {
    mockRun(function (sql, params, cb) {
      cb.call({}, new Error('SQLITE_CONSTRAINT: UNIQUE constraint failed: usuarios.email'));
    });
    const res = await api
      .post('/api/usuarios')
      .send({ nombre: 'Mock User', email: 'mock@example.com' });
    expect(res.status).toBe(400);
    expect(res.body.data).toMatch(/UNIQUE/);
  });
});

// ==========================================================================
// 3. GET /api/usuarios
// ==========================================================================
describe('[UNIT] GET /api/usuarios', () => {
  test('caso de éxito con datos mockup: db.all devuelve un arreglo simulado', async () => {
    const usuariosMock = [
      { id: 1, nombre: 'Mock A', email: 'a@mock.com' },
      { id: 2, nombre: 'Mock B', email: 'b@mock.com' },
    ];
    mockAll((sql, params, cb) => cb(null, usuariosMock));
    const res = await api.get('/api/usuarios');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(usuariosMock);
  });

  test('escenario de fallo con datos mockup: db.all simula un error del motor', async () => {
    mockAll((sql, params, cb) => cb(new Error('database is locked')));
    const res = await api.get('/api/usuarios');
    expect(res.status).toBe(500);
    expectSchema(res.body);
  });
});

// ==========================================================================
// 4. GET /api/usuarios/:id
// ==========================================================================
describe('[UNIT] GET /api/usuarios/:id', () => {
  test('caso de éxito con datos mockup: db.get devuelve un usuario simulado', async () => {
    mockGet((sql, params, cb) => cb(null, { id: 7, nombre: 'Mock Get', email: 'get@mock.com' }));
    const res = await api.get('/api/usuarios/7');
    expect(res.status).toBe(200);
    expect(res.body.data.nombre).toBe('Mock Get');
  });

  test('escenario de fallo con datos mockup: db.get simula que el id no existe', async () => {
    mockGet((sql, params, cb) => cb(null, undefined));
    const res = await api.get('/api/usuarios/999999');
    expect(res.status).toBe(200);
    expect(res.body.data).toBeNull();
  });
});

// ==========================================================================
// 5. PUT /api/usuarios/:id
// ==========================================================================
describe('[UNIT] PUT /api/usuarios/:id', () => {
  test('caso de éxito con datos mockup: db.run simula 1 fila actualizada', async () => {
    mockRun(function (sql, params, cb) {
      cb.call({ changes: 1 }, null);
    });
    const res = await api.put('/api/usuarios/7').send({ nombre: 'Actualizado Mock' });
    expect(res.status).toBe(200);
    expect(res.body.data.updatedRows).toBe(1);
  });

  test('escenario de fallo: usuario no manda ningún campo (no llega a tocar la BD)', async () => {
    const res = await api.put('/api/usuarios/7').send({});
    expect(res.status).toBe(400);
    expectSchema(res.body);
  });

  test('escenario de fallo con datos mockup: db.run simula que el id no existe (0 filas)', async () => {
    mockRun(function (sql, params, cb) {
      cb.call({ changes: 0 }, null);
    });
    const res = await api.put('/api/usuarios/999999').send({ nombre: 'Fantasma' });
    expect(res.status).toBe(200);
    expect(res.body.data.updatedRows).toBe(0);
  });
});

// ==========================================================================
// 6. DELETE /api/usuarios/:id
// ==========================================================================
describe('[UNIT] DELETE /api/usuarios/:id', () => {
  test('caso de éxito con datos mockup: db.run simula 1 fila eliminada', async () => {
    mockRun(function (sql, params, cb) {
      cb.call({ changes: 1 }, null);
    });
    const res = await api.delete('/api/usuarios/7');
    expect(res.status).toBe(200);
    expect(res.body.data.deletedRows).toBe(1);
  });

  test('escenario de fallo con datos mockup: db.run simula que ya no existía (0 filas)', async () => {
    mockRun(function (sql, params, cb) {
      cb.call({ changes: 0 }, null);
    });
    const res = await api.delete('/api/usuarios/7');
    expect(res.status).toBe(200);
    expect(res.body.data.deletedRows).toBe(0);
  });
});

// ==========================================================================
// 7. POST /api/publicaciones
// ==========================================================================
describe('[UNIT] POST /api/publicaciones', () => {
  test('caso de éxito con datos mockup: db.run simula una inserción exitosa', async () => {
    mockRun(function (sql, params, cb) {
      cb.call({ lastID: 100 }, null);
    });
    const res = await api
      .post('/api/publicaciones')
      .send({ usuario_id: 7, titulo: 'Título mockup' });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ id: 100, usuario_id: 7, titulo: 'Título mockup' });
  });

  test('escenario de fallo: usuario no manda título (no llega a tocar la BD)', async () => {
    const res = await api.post('/api/publicaciones').send({ usuario_id: 7 });
    expect(res.status).toBe(400);
    expectSchema(res.body);
  });
});

// ==========================================================================
// 8. GET /api/publicaciones
// ==========================================================================
describe('[UNIT] GET /api/publicaciones', () => {
  test('caso de éxito con datos mockup: db.all devuelve un arreglo simulado', async () => {
    const publicacionesMock = [{ id: 1, usuario_id: 7, titulo: 'Mock Post' }];
    mockAll((sql, params, cb) => cb(null, publicacionesMock));
    const res = await api.get('/api/publicaciones');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(publicacionesMock);
  });
});

// ==========================================================================
// 9. PUT /api/publicaciones/:id
// ==========================================================================
describe('[UNIT] PUT /api/publicaciones/:id', () => {
  test('caso de éxito con datos mockup: db.run simula 1 fila actualizada', async () => {
    mockRun(function (sql, params, cb) {
      cb.call({ changes: 1 }, null);
    });
    const res = await api.put('/api/publicaciones/1').send({ titulo: 'Nuevo título' });
    expect(res.status).toBe(200);
    expect(res.body.data.updatedRows).toBe(1);
  });

  test('escenario de fallo: usuario no manda título (no llega a tocar la BD)', async () => {
    const res = await api.put('/api/publicaciones/1').send({});
    expect(res.status).toBe(400);
    expectSchema(res.body);
  });
});

// ==========================================================================
// 10. DELETE /api/publicaciones/:id
// ==========================================================================
describe('[UNIT] DELETE /api/publicaciones/:id', () => {
  test('caso de éxito con datos mockup: db.run simula 1 fila eliminada', async () => {
    mockRun(function (sql, params, cb) {
      cb.call({ changes: 1 }, null);
    });
    const res = await api.delete('/api/publicaciones/1');
    expect(res.status).toBe(200);
    expect(res.body.data.deletedRows).toBe(1);
  });
});

// ==========================================================================
// 11. POST /api/admin/backup
// ==========================================================================
describe('[UNIT] POST /api/admin/backup', () => {
  test('caso de éxito con datos mockup: fs.copyFile simula un respaldo exitoso', async () => {
    jest.spyOn(fs, 'copyFile').mockImplementation((src, dest, cb) => cb(null));
    const res = await api.post('/api/admin/backup');
    expect(res.status).toBe(200);
    expect(res.body.data.message).toMatch(/éxito/);
  });

  test('escenario de fallo con datos mockup: fs.copyFile simula un error de disco', async () => {
    jest.spyOn(fs, 'copyFile').mockImplementation((src, dest, cb) => cb(new Error('ENOSPC: no space left')));
    const res = await api.post('/api/admin/backup');
    expect(res.status).toBe(500);
    expectSchema(res.body);
  });
});

// ==========================================================================
// 12. POST /api/admin/clear
// ==========================================================================
describe('[UNIT] POST /api/admin/clear', () => {
  test('caso de éxito con datos mockup: db.run simula el vaciado exitoso de ambas tablas', async () => {
    mockRun(function (sql, params, cb) {
      // Normaliza la aridad variable de sqlite3: run(sql), run(sql, cb), run(sql, params, cb).
      if (typeof params === 'function') cb = params;
      if (typeof cb === 'function') cb.call({ changes: 0 }, null);
    });
    const res = await api.post('/api/admin/clear');
    expect(res.status).toBe(200);
    expect(res.body.data.message).toMatch(/vaciada/);
  });
});
