// Pruebas E2E de FRONTEND: pantallas de Login y Register.
const { test, expect } = require('@playwright/test');
const { uniqueUser, registerViaApi } = require('../helpers');

test.describe('UI - Register', () => {
  test('un usuario nuevo se registra y entra al panel de usuarios', async ({ page }) => {
    const user = uniqueUser('uireg');
    await page.goto('/register.html');
    await expect(page.getByRole('heading', { name: 'Crear cuenta' })).toBeVisible();

    await page.getByTestId('register-nombre').fill(user.nombre);
    await page.getByTestId('register-email').fill(user.email);
    await page.getByTestId('register-password').fill(user.password);
    await page.getByTestId('register-confirm').fill(user.password);
    await page.getByTestId('register-submit').click();

    await expect(page).toHaveURL(/usuarios\.html/);
    await expect(page.getByTestId('whoami')).toContainText(user.email);
  });

  test('muestra error si las contraseñas no coinciden', async ({ page }) => {
    const user = uniqueUser('uimis');
    await page.goto('/register.html');
    await page.getByTestId('register-nombre').fill(user.nombre);
    await page.getByTestId('register-email').fill(user.email);
    await page.getByTestId('register-password').fill(user.password);
    await page.getByTestId('register-confirm').fill('OtraCosa999');
    await page.getByTestId('register-submit').click();

    await expect(page.getByTestId('register-alert')).toHaveText('Las contraseñas no coinciden');
    await expect(page).toHaveURL(/register\.html/);
  });

  test('desde Register se puede navegar a Login', async ({ page }) => {
    await page.goto('/register.html');
    await page.getByTestId('go-login').click();
    await expect(page.getByRole('heading', { name: 'Iniciar sesión' })).toBeVisible();
  });
});

test.describe('UI - Login', () => {
  test('inicia sesión con credenciales válidas', async ({ page, request }) => {
    const { credentials } = await registerViaApi(request);
    await page.goto('/');
    await page.getByTestId('login-email').fill(credentials.email);
    await page.getByTestId('login-password').fill(credentials.password);
    await page.getByTestId('login-submit').click();

    await expect(page).toHaveURL(/usuarios\.html/);
    await expect(page.getByTestId('whoami')).toContainText(credentials.nombre);
  });

  test('muestra "Credenciales inválidas" con contraseña incorrecta', async ({ page, request }) => {
    const { credentials } = await registerViaApi(request);
    await page.goto('/');
    await page.getByTestId('login-email').fill(credentials.email);
    await page.getByTestId('login-password').fill('incorrecta');
    await page.getByTestId('login-submit').click();

    await expect(page.getByTestId('login-alert')).toHaveText('Credenciales inválidas');
    await expect(page).not.toHaveURL(/usuarios\.html/);
  });

  test('el panel de usuarios redirige a Login si no hay sesión', async ({ page }) => {
    await page.goto('/usuarios.html');
    await expect(page).toHaveURL(/index\.html/);
    await expect(page.getByTestId('login-form')).toBeVisible();
  });

  test('cerrar sesión regresa a Login', async ({ page, request }) => {
    const { credentials } = await registerViaApi(request);
    await page.goto('/');
    await page.getByTestId('login-email').fill(credentials.email);
    await page.getByTestId('login-password').fill(credentials.password);
    await page.getByTestId('login-submit').click();
    await expect(page).toHaveURL(/usuarios\.html/);

    await page.getByTestId('logout').click();
    await expect(page).toHaveURL(/index\.html/);
  });
});
