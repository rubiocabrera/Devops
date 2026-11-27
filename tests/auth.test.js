// Pruebas de integración de autenticación: Register, Login, /me y la
// protección del CRUD de usuarios con JWT.
const fs = require('fs');
const path = require('path');

const AUTH_DB_PATH = path.join(__dirname, 'test-database-auth.db');
if (fs.existsSync(AUTH_DB_PATH)) fs.unlinkSync(AUTH_DB_PATH);
process.env.DB_PATH = AUTH_DB_PATH;

const request = require('supertest');
const { app, db } = require('../index');

afterAll((done) => {
  db.close(() => {
    if (fs.existsSync(AUTH_DB_PATH)) fs.unlinkSync(AUTH_DB_PATH);
    done();
  });
});

const nuevo = { nombre: 'Ana Auth', email: 'ana.auth@uteq.edu.mx', password: 'secreto123' };
let token;

describe('POST /api/auth/register', () => {
  test('registra un usuario y devuelve token (201)', async () => {
    const res = await request(app).post('/api/auth/register').send(nuevo);
    expect(res.status).toBe(201);
    expect(res.body.data.user).toMatchObject({ nombre: nuevo.nombre, email: nuevo.email });
    expect(res.body.data.user).not.toHaveProperty('password_hash');
    expect(typeof res.body.data.token).toBe('string');
  });

  test('rechaza email duplicado (409)', async () => {
    const res = await request(app).post('/api/auth/register').send(nuevo);
    expect(res.status).toBe(409);
    expect(res.body.data).toMatch(/ya está registrado/);
  });

  test('rechaza campos faltantes (400)', async () => {
    const res = await request(app).post('/api/auth/register').send({ email: 'x@y.com' });
    expect(res.status).toBe(400);
  });

  test('rechaza email inválido (400)', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ nombre: 'X', email: 'no-es-email', password: 'secreto123' });
    expect(res.status).toBe(400);
  });

  test('rechaza contraseña corta (400)', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ nombre: 'X', email: 'corta@uteq.edu.mx', password: '123' });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/auth/login', () => {
  test('inicia sesión con credenciales correctas (200)', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: nuevo.email, password: nuevo.password });
    expect(res.status).toBe(200);
    expect(res.body.data.user.email).toBe(nuevo.email);
    token = res.body.data.token;
  });

  test('rechaza contraseña incorrecta (401)', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: nuevo.email, password: 'incorrecta' });
    expect(res.status).toBe(401);
  });

  test('rechaza usuario inexistente (401)', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nadie@uteq.edu.mx', password: 'loquesea' });
    expect(res.status).toBe(401);
  });

  test('rechaza body vacío (400)', async () => {
    const res = await request(app).post('/api/auth/login').send({});
    expect(res.status).toBe(400);
  });
});

describe('Protección con JWT', () => {
  test('GET /api/auth/me devuelve el usuario del token', async () => {
    const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.email).toBe(nuevo.email);
  });

  test('GET /api/usuarios sin token responde 401', async () => {
    const res = await request(app).get('/api/usuarios');
    expect(res.status).toBe(401);
  });

  test('GET /api/usuarios con token inválido responde 401', async () => {
    const res = await request(app).get('/api/usuarios').set('Authorization', 'Bearer basura');
    expect(res.status).toBe(401);
  });

  test('GET /api/usuarios con token válido no expone password_hash', async () => {
    const res = await request(app).get('/api/usuarios').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    res.body.data.forEach((u) => expect(u).not.toHaveProperty('password_hash'));
  });

  test('POST /api/usuarios con password permite luego hacer login', async () => {
    const creado = await request(app)
      .post('/api/usuarios')
      .set('Authorization', `Bearer ${token}`)
      .send({ nombre: 'Creado CRUD', email: 'crud@uteq.edu.mx', password: 'clave1234' });
    expect(creado.status).toBe(200);
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'crud@uteq.edu.mx', password: 'clave1234' });
    expect(login.status).toBe(200);
  });
});

describe('Manejo global de excepciones', () => {
  test('un JSON malformado lo atrapa el manejador de errores y responde 400', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"email": "roto@uteq.edu.mx", "password": ');
    expect(res.status).toBe(400);
    expect(res.body.statusCode).toBe(400);
  });
});
