// Pruebas E2E de BACKEND: CRUD de usuarios protegido con JWT.
const { test, expect } = require('@playwright/test');
const { uniqueUser, registerViaApi } = require('../helpers');

test.describe('API - CRUD de usuarios', () => {
  let auth;

  test.beforeEach(async ({ request }) => {
    const { token } = await registerViaApi(request);
    auth = { Authorization: `Bearer ${token}` };
  });

  test('sin token el CRUD responde 401', async ({ request }) => {
    expect((await request.get('/api/usuarios')).status()).toBe(401);
    expect((await request.post('/api/usuarios', { data: uniqueUser() })).status()).toBe(401);
  });

  test('ciclo completo: crear, leer, actualizar y eliminar', async ({ request }) => {
    const nuevo = uniqueUser('crud');

    // CREATE
    const created = await request.post('/api/usuarios', { headers: auth, data: nuevo });
    expect(created.status()).toBe(200);
    const id = (await created.json()).data.id;
    expect(id).toBeGreaterThan(0);

    // READ (lista y por id)
    const list = await request.get('/api/usuarios', { headers: auth });
    expect(list.status()).toBe(200);
    const users = (await list.json()).data;
    expect(users.some((u) => u.email === nuevo.email)).toBe(true);
    users.forEach((u) => expect(u).not.toHaveProperty('password_hash'));

    const one = await request.get(`/api/usuarios/${id}`, { headers: auth });
    expect((await one.json()).data.nombre).toBe(nuevo.nombre);

    // UPDATE
    const updated = await request.put(`/api/usuarios/${id}`, {
      headers: auth,
      data: { nombre: 'Nombre Actualizado' },
    });
    expect((await updated.json()).data.updatedRows).toBe(1);
    const reread = await request.get(`/api/usuarios/${id}`, { headers: auth });
    expect((await reread.json()).data.nombre).toBe('Nombre Actualizado');

    // DELETE
    const deleted = await request.delete(`/api/usuarios/${id}`, { headers: auth });
    expect((await deleted.json()).data.deletedRows).toBe(1);
    const gone = await request.get(`/api/usuarios/${id}`, { headers: auth });
    expect((await gone.json()).data).toBeNull();
  });

  test('no permite crear dos usuarios con el mismo email', async ({ request }) => {
    const nuevo = uniqueUser('dup');
    await request.post('/api/usuarios', { headers: auth, data: nuevo });
    const again = await request.post('/api/usuarios', { headers: auth, data: nuevo });
    expect(again.status()).toBe(400);
  });

  test('actualizar sin campos responde 400', async ({ request }) => {
    const res = await request.put('/api/usuarios/1', { headers: auth, data: {} });
    expect(res.status()).toBe(400);
  });
});
