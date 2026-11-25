// Datos únicos por prueba para que las pruebas no dependan unas de otras.
let counter = 0;
function uniqueUser(prefix = 'e2e') {
  counter += 1;
  const id = `${Date.now()}${counter}`;
  return {
    nombre: `Usuario ${prefix} ${id}`,
    email: `${prefix}.${id}@uteq.edu.mx`,
    password: 'Secreto123',
  };
}

// Registra un usuario vía API y devuelve { user, token }.
async function registerViaApi(request, user = uniqueUser()) {
  const res = await request.post('/api/auth/register', { data: user });
  if (res.status() !== 201) throw new Error(`Registro falló: ${res.status()} ${await res.text()}`);
  const body = await res.json();
  return { ...body.data, credentials: user };
}

module.exports = { uniqueUser, registerViaApi };
