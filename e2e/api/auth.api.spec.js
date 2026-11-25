// Pruebas E2E de BACKEND: autenticación (Register / Login / Me).
const { test, expect } = require('@playwright/test');
const { uniqueUser, registerViaApi } = require('../helpers');

test.describe('API - Estado del servidor', () => {
  test('GET /api/status responde Online con el esquema {statusCode, data}', async ({ request }) => {
    const res = await request.get('/api/status');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.statusCode).toBe(200);
    expect(body.data.status).toBe('Online');
  });
});

test.describe('API - Register', () => {
  test('registra un usuario nuevo y devuelve un token', async ({ request }) => {
    const user = uniqueUser('reg');
    const res = await request.post('/api/auth/register', { data: user });
    expect(res.status()).toBe(201);
    const { data } = await res.json();
    expect(data.user.email).toBe(user.email);
    expect(data.user).not.toHaveProperty('password_hash');
    expect(data.token).toBeTruthy();
  });

  test('rechaza un email ya registrado con 409', async ({ request }) => {
    const { credentials } = await registerViaApi(request);
    const res = await request.post('/api/auth/register', { data: credentials });
    expect(res.status()).toBe(409);
  });

  test('rechaza datos incompletos con 400', async ({ request }) => {
    const res = await request.post('/api/auth/register', { data: { email: 'solo@email.com' } });
    expect(res.status()).toBe(400);
  });
});

test.describe('API - Login', () => {
  test('inicia sesión con credenciales válidas', async ({ request }) => {
    const { credentials } = await registerViaApi(request);
    const res = await request.post('/api/auth/login', {
      data: { email: credentials.email, password: credentials.password },
    });
    expect(res.status()).toBe(200);
    const { data } = await res.json();
    expect(data.token).toBeTruthy();

    const me = await request.get('/api/auth/me', {
      headers: { Authorization: `Bearer ${data.token}` },
    });
    expect(me.status()).toBe(200);
    expect((await me.json()).data.email).toBe(credentials.email);
  });

  test('rechaza una contraseña incorrecta con 401', async ({ request }) => {
    const { credentials } = await registerViaApi(request);
    const res = await request.post('/api/auth/login', {
      data: { email: credentials.email, password: 'contraseña-mala' },
    });
    expect(res.status()).toBe(401);
  });
});
