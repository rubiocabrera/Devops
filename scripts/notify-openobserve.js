#!/usr/bin/env node
// Envía un evento del pipeline CI/CD a OpenObserve (stream "cicd_pipeline")
// mediante su API HTTP/JSON.
//
// Uso: node scripts/notify-openobserve.js <event> <status> [mensaje]
//   event:  tests | deploy
//   status: success | failure | blocked | cancelled
// Variables: O2_URL, O2_USER, O2_PASSWORD y las que GitHub Actions define
// (GITHUB_SHA, GITHUB_REF_NAME, GITHUB_ACTOR, GITHUB_RUN_ID, ...).
const fs = require('fs');

const [event = 'tests', status = 'unknown', message = ''] = process.argv.slice(2);
const env = process.env;

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

// Conteo de pruebas de Jest y Playwright si existen sus reportes JSON.
function testCounts() {
  const counts = {};
  const jest = readJson('jest-results.json');
  if (jest) {
    counts.jest_total = jest.numTotalTests;
    counts.jest_passed = jest.numPassedTests;
    counts.jest_failed = jest.numFailedTests;
  }
  const pw = readJson('playwright-report/results.json');
  if (pw && pw.stats) {
    counts.playwright_passed = pw.stats.expected;
    counts.playwright_failed = pw.stats.unexpected;
    counts.playwright_flaky = pw.stats.flaky;
    counts.playwright_skipped = pw.stats.skipped;
    counts.playwright_total = pw.stats.expected + pw.stats.unexpected + pw.stats.flaky + pw.stats.skipped;
  }
  if (Object.keys(counts).length) {
    counts.tests_passed = (counts.jest_passed || 0) + (counts.playwright_passed || 0);
    counts.tests_failed = (counts.jest_failed || 0) + (counts.playwright_failed || 0);
    counts.tests_total = (counts.jest_total || 0) + (counts.playwright_total || 0);
  }
  return counts;
}

const record = {
  _timestamp: new Date().toISOString(),
  event,
  status,
  message,
  commit: env.GITHUB_SHA || '',
  commit_short: (env.GITHUB_SHA || '').slice(0, 7),
  commit_message: (env.COMMIT_MESSAGE || '').split('\n')[0].slice(0, 200),
  branch: env.GITHUB_REF_NAME || '',
  actor: env.GITHUB_ACTOR || '',
  trigger: env.GITHUB_EVENT_NAME || '',
  repository: env.GITHUB_REPOSITORY || '',
  workflow: env.GITHUB_WORKFLOW || '',
  job: env.GITHUB_JOB || '',
  run_id: env.GITHUB_RUN_ID || '',
  run_number: Number(env.GITHUB_RUN_NUMBER || 0),
  run_url: env.GITHUB_RUN_ID
    ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
    : '',
  target_host: env.TARGET_HOST || '',
  ...(event === 'tests' ? testCounts() : {}),
};

(async () => {
  console.log('Evento CI/CD:', JSON.stringify(record, null, 2));
  if (!env.O2_URL || !env.O2_USER || !env.O2_PASSWORD) {
    console.log('::warning::Faltan O2_URL/O2_USER/O2_PASSWORD; no se envió el evento a OpenObserve.');
    return;
  }
  const auth = Buffer.from(`${env.O2_USER}:${env.O2_PASSWORD}`).toString('base64');
  try {
    const res = await fetch(`${env.O2_URL.replace(/\/$/, '')}/api/default/cicd_pipeline/_json`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([record]),
      signal: AbortSignal.timeout(15000),
    });
    console.log(`OpenObserve respondió ${res.status}: ${await res.text()}`);
  } catch (e) {
    // No se hace fallar el pipeline por un problema de observabilidad.
    console.log(`::warning::No se pudo enviar el evento a OpenObserve: ${e.message}`);
  }
})();
