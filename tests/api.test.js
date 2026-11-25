const fs = require('fs');
const path = require('path');

const TEST_DB_PATH = path.join(__dirname, 'test-database.db');
if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
process.env.DB_PATH = TEST_DB_PATH;

const request = require('supertest');
const { app, db } = require('../index');
const api = require('./helpers/authedRequest')(app);

// Espera a que las tablas (creadas de forma asíncrona en index.js) existan antes de correr las pruebas.
beforeAll((done) => {
  db.serialize(() => {
    db.run(
      `CREATE TABLE IF NOT EXISTS usuarios (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nombre TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL
      )`,
      () => {
        db.run(
          `CREATE TABLE IF NOT EXISTS publicaciones (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            usuario_id INTEGER,
            titulo TEXT NOT NULL,
            FOREIGN KEY(usuario_id) REFERENCES usuarios(id)
          )`,
          done
        );
      }
    );
  });
});

afterAll((done) => {
  db.close(() => {
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
    fs.readdirSync(process.cwd())
      .filter((f) => f.startsWith('backup-') && f.endsWith('.db'))
      .forEach((f) => fs.unlinkSync(f));
    done();
  });
});

const expectSchema = (body) => {
  expect(body).toHaveProperty('statusCode');
  expect(body).toHaveProperty('data');
};

// ==========================================================================
// 1. GET /api/status
// ==========================================================================
describe('GET /api/status', () => {
  test('caso de éxito: responde 200 con el estado del servidor', async () => {
    const res = await api.get('/api/status');
    expect(res.status).toBe(200);
    expectSchema(res.body);
    expect(res.body.data.status).toBe('Online');
  });
});

// ==========================================================================
// 2. POST /api/usuarios
// ==========================================================================
describe('POST /api/usuarios', () => {
  let usuarioId;

  test('caso de éxito: crea un usuario nuevo', async () => {
    const res = await api
      .post('/api/usuarios')
      .send({ nombre: 'Ana Test', email: 'ana.test@example.com' });
    expect(res.status).toBe(200);
    expectSchema(res.body);
    expect(res.body.data).toHaveProperty('id');
    usuarioId = res.body.data.id;
  });

  test('escenario de fallo: email duplicado (usuario repite un registro existente)', async () => {
    const res = await api
      .post('/api/usuarios')
      .send({ nombre: 'Otra Ana', email: 'ana.test@example.com' });
    expect(res.status).toBe(400);
    expectSchema(res.body);
    expect(res.body.data).toMatch(/UNIQUE/);
  });

  test('escenario de fallo: usuario olvida enviar el campo email', async () => {
    const res = await api.post('/api/usuarios').send({ nombre: 'Sin Email' });
    expect(res.status).toBe(400);
    expectSchema(res.body);
  });

  test('escenario de fallo: usuario envía el body completamente vacío', async () => {
    const res = await api.post('/api/usuarios').send({});
    expect(res.status).toBe(400);
    expectSchema(res.body);
  });
});

// ==========================================================================
// 3. GET /api/usuarios
// ==========================================================================
describe('GET /api/usuarios', () => {
  test('caso de éxito: devuelve un arreglo con los usuarios existentes', async () => {
    const res = await api.get('/api/usuarios');
    expect(res.status).toBe(200);
    expectSchema(res.body);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThan(0);
  });
});

// ==========================================================================
// 4. GET /api/usuarios/:id
// ==========================================================================
describe('GET /api/usuarios/:id', () => {
  let usuarioId;

  beforeAll(async () => {
    const res = await api
      .post('/api/usuarios')
      .send({ nombre: 'Bruno Get', email: 'bruno.get@example.com' });
    usuarioId = res.body.data.id;
  });

  test('caso de éxito: devuelve el usuario correspondiente al id', async () => {
    const res = await api.get(`/api/usuarios/${usuarioId}`);
    expect(res.status).toBe(200);
    expectSchema(res.body);
    expect(res.body.data.email).toBe('bruno.get@example.com');
  });

  test('escenario de fallo: usuario consulta un id que no existe', async () => {
    const res = await api.get('/api/usuarios/999999');
    expect(res.status).toBe(200);
    expect(res.body.data).toBeNull();
  });

  test('escenario de fallo: usuario consulta con un id no numérico', async () => {
    const res = await api.get('/api/usuarios/abc');
    expect(res.status).toBe(200);
    expect(res.body.data).toBeNull();
  });
});

// ==========================================================================
// 5. PUT /api/usuarios/:id
// ==========================================================================
describe('PUT /api/usuarios/:id', () => {
  let usuarioId;

  beforeAll(async () => {
    const res = await api
      .post('/api/usuarios')
      .send({ nombre: 'Carla Put', email: 'carla.put@example.com' });
    usuarioId = res.body.data.id;
  });

  test('caso de éxito: actualiza el nombre del usuario', async () => {
    const res = await api
      .put(`/api/usuarios/${usuarioId}`)
      .send({ nombre: 'Carla Actualizada' });
    expect(res.status).toBe(200);
    expectSchema(res.body);
    expect(res.body.data.updatedRows).toBe(1);

    const verify = await api.get(`/api/usuarios/${usuarioId}`);
    expect(verify.body.data.nombre).toBe('Carla Actualizada');
  });

  test('escenario de fallo: usuario envía el body vacío (nada que actualizar)', async () => {
    const res = await api.put(`/api/usuarios/${usuarioId}`).send({});
    expect(res.status).toBe(400);
    expectSchema(res.body);
  });

  test('escenario de fallo: usuario intenta actualizar un id que no existe', async () => {
    const res = await api
      .put('/api/usuarios/999999')
      .send({ nombre: 'Fantasma' });
    expect(res.status).toBe(200);
    expect(res.body.data.updatedRows).toBe(0);
  });

  test('escenario de fallo: usuario intenta dejar el email en uno ya usado por otro usuario', async () => {
    const res = await api
      .put(`/api/usuarios/${usuarioId}`)
      .send({ email: 'ana.test@example.com' });
    expect(res.status).toBe(400);
    expectSchema(res.body);
  });
});

// ==========================================================================
// 6. DELETE /api/usuarios/:id
// ==========================================================================
describe('DELETE /api/usuarios/:id', () => {
  let usuarioId;

  beforeAll(async () => {
    const res = await api
      .post('/api/usuarios')
      .send({ nombre: 'Diego Delete', email: 'diego.delete@example.com' });
    usuarioId = res.body.data.id;
  });

  test('caso de éxito: elimina el usuario creado', async () => {
    const res = await api.delete(`/api/usuarios/${usuarioId}`);
    expect(res.status).toBe(200);
    expectSchema(res.body);
    expect(res.body.data.deletedRows).toBe(1);
  });

  test('escenario de fallo: usuario intenta borrar el mismo id dos veces', async () => {
    const res = await api.delete(`/api/usuarios/${usuarioId}`);
    expect(res.status).toBe(200);
    expect(res.body.data.deletedRows).toBe(0);
  });
});

// ==========================================================================
// 7. POST /api/publicaciones
// ==========================================================================
describe('POST /api/publicaciones', () => {
  let usuarioId;
  let publicacionId;

  beforeAll(async () => {
    const res = await api
      .post('/api/usuarios')
      .send({ nombre: 'Elena Post', email: 'elena.post@example.com' });
    usuarioId = res.body.data.id;
  });

  test('caso de éxito: crea una publicación asociada a un usuario', async () => {
    const res = await api
      .post('/api/publicaciones')
      .send({ usuario_id: usuarioId, titulo: 'Mi primera publicación' });
    expect(res.status).toBe(200);
    expectSchema(res.body);
    expect(res.body.data).toHaveProperty('id');
    publicacionId = res.body.data.id;
  });

  test('escenario de fallo: usuario olvida enviar el título', async () => {
    const res = await api
      .post('/api/publicaciones')
      .send({ usuario_id: usuarioId });
    expect(res.status).toBe(400);
    expectSchema(res.body);
  });

  test('escenario de fallo: usuario_id no corresponde a ningún usuario', async () => {
    // El esquema no impone la restricción FK a nivel de motor, por lo que la
    // inserción se acepta; se documenta como comportamiento actual y se
    // recomienda validación adicional a futuro.
    const res = await api
      .post('/api/publicaciones')
      .send({ usuario_id: 999999, titulo: 'Publicación huérfana' });
    expect(res.status).toBe(200);
    expectSchema(res.body);
  });
});

// ==========================================================================
// 8. GET /api/publicaciones
// ==========================================================================
describe('GET /api/publicaciones', () => {
  test('caso de éxito: devuelve un arreglo con las publicaciones existentes', async () => {
    const res = await api.get('/api/publicaciones');
    expect(res.status).toBe(200);
    expectSchema(res.body);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThan(0);
  });
});

// ==========================================================================
// 9. PUT /api/publicaciones/:id
// ==========================================================================
describe('PUT /api/publicaciones/:id', () => {
  let publicacionId;

  beforeAll(async () => {
    const usuario = await api
      .post('/api/usuarios')
      .send({ nombre: 'Fabian Put', email: 'fabian.put@example.com' });
    const publicacion = await api
      .post('/api/publicaciones')
      .send({ usuario_id: usuario.body.data.id, titulo: 'Título original' });
    publicacionId = publicacion.body.data.id;
  });

  test('caso de éxito: actualiza el título de la publicación', async () => {
    const res = await api
      .put(`/api/publicaciones/${publicacionId}`)
      .send({ titulo: 'Título actualizado' });
    expect(res.status).toBe(200);
    expectSchema(res.body);
    expect(res.body.data.updatedRows).toBe(1);
  });

  test('escenario de fallo: usuario envía el body vacío (sin título)', async () => {
    const res = await api.put(`/api/publicaciones/${publicacionId}`).send({});
    expect(res.status).toBe(400);
    expectSchema(res.body);
  });

  test('escenario de fallo: usuario intenta actualizar un id que no existe', async () => {
    const res = await api
      .put('/api/publicaciones/999999')
      .send({ titulo: 'No existe' });
    expect(res.status).toBe(200);
    expect(res.body.data.updatedRows).toBe(0);
  });
});

// ==========================================================================
// 10. DELETE /api/publicaciones/:id
// ==========================================================================
describe('DELETE /api/publicaciones/:id', () => {
  let publicacionId;

  beforeAll(async () => {
    const usuario = await api
      .post('/api/usuarios')
      .send({ nombre: 'Gina Delete', email: 'gina.delete@example.com' });
    const publicacion = await api
      .post('/api/publicaciones')
      .send({ usuario_id: usuario.body.data.id, titulo: 'Publicación a borrar' });
    publicacionId = publicacion.body.data.id;
  });

  test('caso de éxito: elimina la publicación creada', async () => {
    const res = await api.delete(`/api/publicaciones/${publicacionId}`);
    expect(res.status).toBe(200);
    expectSchema(res.body);
    expect(res.body.data.deletedRows).toBe(1);
  });

  test('escenario de fallo: usuario intenta borrar un id que no existe', async () => {
    const res = await api.delete('/api/publicaciones/999999');
    expect(res.status).toBe(200);
    expect(res.body.data.deletedRows).toBe(0);
  });
});

// ==========================================================================
// 11. POST /api/admin/backup
// ==========================================================================
describe('POST /api/admin/backup', () => {
  test('caso de éxito: crea un archivo de respaldo de la base de datos', async () => {
    const res = await api.post('/api/admin/backup');
    expect(res.status).toBe(200);
    expectSchema(res.body);
    expect(fs.existsSync(res.body.data.file)).toBe(true);
  });
});

// ==========================================================================
// 12. POST /api/admin/clear
// ==========================================================================
describe('POST /api/admin/clear', () => {
  test('caso de éxito: vacía la base de datos por completo', async () => {
    await api
      .post('/api/usuarios')
      .send({ nombre: 'Temporal', email: 'temporal.clear@example.com' });

    const res = await api.post('/api/admin/clear');
    expect(res.status).toBe(200);
    expectSchema(res.body);

    const usuarios = await api.get('/api/usuarios');
    expect(usuarios.body.data.length).toBe(0);

    const publicaciones = await api.get('/api/publicaciones');
    expect(publicaciones.body.data.length).toBe(0);
  });

  test('escenario de fallo: llamar clear dos veces seguidas no genera error', async () => {
    const res = await api.post('/api/admin/clear');
    expect(res.status).toBe(200);
    expectSchema(res.body);
  });
});
