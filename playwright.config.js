// Suite E2E con Playwright:
//   - proyecto "api": pruebas de backend (endpoints REST) con el fixture `request`
//   - proyecto "ui":  pruebas de frontend (Login, Register, CRUD) en Chromium
// Playwright levanta la app real (node index.js) con una BD SQLite en memoria.
const { defineConfig, devices } = require('@playwright/test');

const PORT = Number(process.env.E2E_PORT || 3100);
const BASE_URL = process.env.E2E_BASE_URL || `http://127.0.0.1:${PORT}`;

module.exports = defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'playwright-report' }],
    ['json', { outputFile: 'playwright-report/results.json' }],
  ],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'api', testMatch: /api\/.*\.spec\.js/ },
    { name: 'ui', testMatch: /ui\/.*\.spec\.js/, use: { ...devices['Desktop Chrome'] } },
  ],
  // Si E2E_BASE_URL apunta a un servidor ya desplegado, no se levanta uno local.
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: 'node index.js',
        url: `${BASE_URL}/api/status`,
        reuseExistingServer: !process.env.CI,
        timeout: 60_000,
        env: {
          PORT: String(PORT),
          TCP_PORT: String(PORT + 1),
          DB_PATH: ':memory:',
          JWT_SECRET: 'e2e-secret',
        },
      },
});
