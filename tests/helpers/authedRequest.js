// Devuelve un "cliente" supertest que agrega automáticamente un JWT válido,
// porque el CRUD de /api/usuarios requiere sesión iniciada.
const jwt = require('jsonwebtoken');
const request = require('supertest');

module.exports = function authedRequest(app) {
  const token = jwt.sign(
    { sub: 1, email: 'tester@test.com', nombre: 'Tester' },
    process.env.JWT_SECRET || 'dev-secret-cambiar-en-produccion'
  );
  const header = `Bearer ${token}`;
  return ['get', 'post', 'put', 'delete'].reduce((client, method) => {
    client[method] = (url) => request(app)[method](url).set('Authorization', header);
    return client;
  }, {});
};
