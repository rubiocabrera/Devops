// Pruebas E2E de FRONTEND: CRUD de usuarios desde la interfaz.
const { test, expect } = require('@playwright/test');
const { uniqueUser, registerViaApi } = require('../helpers');

test.describe('UI - CRUD de usuarios', () => {
  test.beforeEach(async ({ page, request }) => {
    const { credentials } = await registerViaApi(request);
    await page.goto('/');
    await page.getByTestId('login-email').fill(credentials.email);
    await page.getByTestId('login-password').fill(credentials.password);
    await page.getByTestId('login-submit').click();
    await expect(page).toHaveURL(/usuarios\.html/);
    await expect(page.getByTestId('users-table')).toBeVisible();
  });

  test('crea un usuario y aparece en la tabla', async ({ page }) => {
    const nuevo = uniqueUser('uicreate');
    await page.getByTestId('user-nombre').fill(nuevo.nombre);
    await page.getByTestId('user-email').fill(nuevo.email);
    await page.getByTestId('user-save').click();

    await expect(page.getByTestId('crud-alert')).toHaveText('Usuario creado');
    const row = page.locator(`tr[data-email="${nuevo.email}"]`);
    await expect(row).toBeVisible();
    await expect(row.getByTestId('user-row-nombre')).toHaveText(nuevo.nombre);
  });

  test('edita el nombre de un usuario', async ({ page }) => {
    const nuevo = uniqueUser('uiedit');
    await page.getByTestId('user-nombre').fill(nuevo.nombre);
    await page.getByTestId('user-email').fill(nuevo.email);
    await page.getByTestId('user-save').click();
    const row = page.locator(`tr[data-email="${nuevo.email}"]`);
    await expect(row).toBeVisible();

    await row.getByTestId('user-edit').click();
    await expect(page.getByTestId('form-title')).toContainText('Editar usuario');
    await page.getByTestId('user-nombre').fill('Nombre Editado UI');
    await page.getByTestId('user-save').click();

    await expect(page.getByTestId('crud-alert')).toHaveText('Usuario actualizado');
    await expect(row.getByTestId('user-row-nombre')).toHaveText('Nombre Editado UI');
  });

  test('elimina un usuario de la tabla', async ({ page }) => {
    const nuevo = uniqueUser('uidel');
    await page.getByTestId('user-nombre').fill(nuevo.nombre);
    await page.getByTestId('user-email').fill(nuevo.email);
    await page.getByTestId('user-save').click();
    const row = page.locator(`tr[data-email="${nuevo.email}"]`);
    await expect(row).toBeVisible();

    page.once('dialog', (dialog) => dialog.accept());
    await row.getByTestId('user-delete').click();

    await expect(page.getByTestId('crud-alert')).toHaveText('Usuario eliminado');
    await expect(row).toHaveCount(0);
  });

  test('valida campos obligatorios', async ({ page }) => {
    await page.getByTestId('user-save').click();
    await expect(page.getByTestId('crud-alert')).toHaveText('Nombre y correo son obligatorios');
  });
});
