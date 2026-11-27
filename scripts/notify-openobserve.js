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

// Nombres de las pruebas que fallaron (Jest y Playwright), para el mensaje.
function failedTests() {
  const names = [];
  const jest = readJson('jest-results.json');
  for (const suite of (jest && jest.testResults) || []) {
    for (const t of suite.assertionResults || []) {
      if (t.status === 'failed') names.push(`Jest: ${t.fullName || t.title}`);
    }
  }
  const walk = (suite, parents) => {
    const path = suite.title && !suite.title.endsWith('.js') ? [...parents, suite.title] : parents;
    for (const spec of suite.specs || []) {
      for (const t of spec.tests || []) {
        if (t.status === 'unexpected') names.push(`Playwright [${t.projectName}]: ${[...path, spec.title].join(' > ')}`);
      }
    }
    for (const child of suite.suites || []) walk(child, path);
  };
  const pw = readJson('playwright-report/results.json');
  for (const suite of (pw && pw.suites) || []) walk(suite, []);
  return names;
}

const sha = (env.GITHUB_SHA || '').slice(0, 7);
const commitMessage = (env.COMMIT_MESSAGE || '').split('\n')[0].slice(0, 200);
const host = env.TARGET_HOST || 'EC2';
const withCounts = event === 'tests' || status === 'blocked';
const counts = withCounts ? testCounts() : {};
const failed = withCounts ? failedTests() : [];

// Mensaje legible y completo del evento (lo que se ve en la columna "message").
function buildMessage() {
  const who = `rama ${env.GITHUB_REF_NAME || '?'}, por ${env.GITHUB_ACTOR || '?'}`;
  const resumen = counts.tests_total !== undefined
    ? `Jest ${counts.jest_passed ?? 0}/${counts.jest_total ?? 0} aprobadas, ` +
      `Playwright ${counts.playwright_passed ?? 0}/${counts.playwright_total ?? 0} aprobadas`
    : '';
  const fallas = failed.length ? ` Fallaron: ${failed.slice(0, 5).join('; ')}.` : '';
  const commit = commitMessage ? ` Commit: "${commitMessage}".` : '';
  let texto;
  if (event === 'tests') {
    texto = status === 'success'
      ? `Pruebas APROBADAS en ${sha} (${who}): ${resumen}.${commit}`
      : `Pruebas FALLIDAS en ${sha} (${who}): ${resumen}.${fallas}${commit}`;
  } else if (status === 'blocked') {
    texto = `Despliegue BLOQUEADO de ${sha} (${who}): las pruebas fallaron (${resumen}), ` +
      `por lo que no se abrió la conexión SSH hacia ${host}.${fallas}${commit}`;
  } else if (status === 'success') {
    texto = `Despliegue EXITOSO de ${sha} en ${host} (${who}): contenedores actualizados con la ` +
      `imagen webapp:${env.GITHUB_SHA || sha} y verificación de salud correcta.${commit}`;
  } else {
    texto = `Despliegue ${status.toUpperCase()} de ${sha} en ${host} (${who}).${commit}`;
  }
  return message ? `${texto} ${message}` : texto;
}

const record = {
  _timestamp: new Date().toISOString(),
  event,
  status,
  message: buildMessage(),
  failed_tests: failed.join(' | '),
  commit: env.GITHUB_SHA || '',
  commit_short: sha,
  commit_message: commitMessage,
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
  ...counts,
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
