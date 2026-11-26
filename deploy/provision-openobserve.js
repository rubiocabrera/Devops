#!/usr/bin/env node
// Crea (o recrea) en OpenObserve los dashboards y las alertas del proyecto.
// Es idempotente: borra los dashboards con el mismo título y los vuelve a crear.
//
// Uso:  O2_URL=http://IP:5080 O2_USER=... O2_PASSWORD=... node deploy/provision-openobserve.js
const O2_URL = (process.env.O2_URL || 'http://localhost:5080').replace(/\/$/, '');
const ORG = process.env.O2_ORG || 'default';
const AUTH = 'Basic ' + Buffer.from(`${process.env.O2_USER}:${process.env.O2_PASSWORD}`).toString('base64');

async function o2(method, path, body) {
  const res = await fetch(`${O2_URL}${path}`, {
    method,
    headers: { Authorization: AUTH, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch (e) { json = text; }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return json;
}

// --------------------------------------------------------------------------
// Constructores de paneles (formato de dashboard v5 de OpenObserve)
// --------------------------------------------------------------------------
let panelSeq = 0;
const axis = (alias, label, aggregationFunction = null) => ({
  label, alias, column: alias, color: null, aggregationFunction, sortBy: null, isDerived: false,
});

function panel({ type = 'line', title, description = '', sql, stream, streamType = 'logs', x = [], y = [], breakdown = [], unit = null, layout, decimals = 2 }) {
  panelSeq += 1;
  return {
    id: `panel_${panelSeq}`,
    type,
    title,
    description,
    config: {
      show_legends: true, legends_position: null, unit, unit_custom: null, decimals,
      axis_border_show: false, connect_nulls: true, no_value_replacement: '',
      wrap_table_cells: false, table_transpose: false, table_dynamic_columns: false,
    },
    queryType: 'sql',
    queries: [{
      query: sql,
      vrlFunctionQuery: '',
      customQuery: true,
      fields: {
        stream, stream_type: streamType,
        x, y, z: [], breakdown,
        filter: { filterType: 'group', logicalOperator: 'AND', conditions: [] },
      },
      config: { promql_legend: '', layer_type: 'scatter', weight_fixed: 1, limit: 0, min: 0, max: 100, time_shift: [] },
    }],
    layout: { ...layout, i: panelSeq },
    htmlContent: '',
    markdownContent: '',
  };
}

// Serie temporal: x = histogram(_timestamp), y = valor, breakdown opcional.
const timeseries = ({ title, description, stream, streamType, select, breakdownCol, where = '', unit, layout, type = 'line', interval = '1 minute' }) => {
  const bd = breakdownCol ? `, ${breakdownCol} AS breakdown_1` : '';
  const groupBd = breakdownCol ? ', breakdown_1' : '';
  return panel({
    type, title, description, stream, streamType, unit, layout,
    sql: `SELECT histogram(_timestamp, '${interval}') AS x_axis_1${bd}, ${select} AS y_axis_1 FROM "${stream}" ${where} GROUP BY x_axis_1${groupBd} ORDER BY x_axis_1 ASC`,
    x: [axis('x_axis_1', 'Tiempo', 'histogram')],
    y: [axis('y_axis_1', title)],
    breakdown: breakdownCol ? [axis('breakdown_1', breakdownCol)] : [],
  });
};

const metricValue = ({ title, sql, stream, streamType = 'logs', unit, layout, decimals = 1 }) => panel({
  type: 'metric', title, stream, streamType, unit, layout, decimals, sql,
  x: [], y: [axis('y_axis_1', title)],
});

const table = ({ title, sql, stream, streamType = 'logs', columns, layout }) => panel({
  type: 'table', title, stream, streamType, layout, sql,
  x: columns.map((c) => axis(c, c)), y: [],
});

const L = (x, y, w, h) => ({ x, y, w, h });
const HTTP = `WHERE body = 'http_request'`;
// Ancho de banda de la interfaz física (ens5 en EC2): delta del contador
// acumulado por interfaz en cada minuto, sumado por dirección (rx/tx).
const bandwidth = ({ title, layout }) => panel({
  type: 'area', title, stream: 'system_network_io', streamType: 'metrics', unit: 'bytes', layout,
  sql: `SELECT x_axis_1, breakdown_1, sum(d) / 60.0 AS y_axis_1 FROM (SELECT histogram(_timestamp, '1 minute') AS x_axis_1, direction AS breakdown_1, device, max(value) - min(value) AS d FROM "system_network_io" WHERE device LIKE 'eth%' OR device LIKE 'ens%' OR device LIKE 'enp%' GROUP BY x_axis_1, breakdown_1, device) GROUP BY x_axis_1, breakdown_1 ORDER BY x_axis_1 ASC`,
  x: [axis('x_axis_1', 'Tiempo', 'histogram')],
  y: [axis('y_axis_1', title)],
  breakdown: [axis('breakdown_1', 'direction')],
});

// --------------------------------------------------------------------------
// Temperatura: si el host expone sensores, el stream tiene el campo "celsius" y
// se grafica. Si no (caso habitual en EC2), se muestra el estado del sensor y el
// motivo, sin inventar valores.
// --------------------------------------------------------------------------
let hasCelsius = false;
const temperatureTile = (layout) => hasCelsius
  ? metricValue({ title: 'Temperatura máx. (°C)', stream: 'host_temperature', layout,
      sql: `SELECT max(celsius) AS y_axis_1 FROM "host_temperature" WHERE available = true` })
  : table({ title: 'Temperatura (°C)', stream: 'host_temperature', layout,
      columns: ['sensor', 'available', 'reason'],
      sql: `SELECT sensor, available, reason FROM "host_temperature" ORDER BY _timestamp DESC LIMIT 1` });
const temperatureChart = (layout) => hasCelsius
  ? timeseries({ title: 'Temperatura del host (°C)', stream: 'host_temperature', layout,
      select: 'max(celsius)', breakdownCol: 'sensor', where: 'WHERE available = true' })
  : timeseries({ title: 'Lecturas del sensor de temperatura (sin sensor disponible)', stream: 'host_temperature', layout,
      select: 'count(*)', breakdownCol: 'available', type: 'bar', interval: '5 minutes' });
const temperatureTable = (layout) => table({ title: 'Estado del sensor de temperatura', stream: 'host_temperature', layout,
  columns: hasCelsius ? ['timestamp', 'host', 'sensor', 'available', 'celsius'] : ['timestamp', 'host', 'sensor', 'available', 'reason'],
  sql: `SELECT to_timestamp_micros(_timestamp) AS timestamp, host, sensor, available, ${hasCelsius ? 'celsius' : 'reason'} FROM "host_temperature" ORDER BY _timestamp DESC LIMIT 20` });

// --------------------------------------------------------------------------
// Dashboards
// --------------------------------------------------------------------------
function appDashboard() {
  return [
    metricValue({ title: 'Peticiones (rango)', stream: 'default', layout: L(0, 0, 12, 6), decimals: 0,
      sql: `SELECT count(*) AS y_axis_1 FROM "default" ${HTTP}` }),
    metricValue({ title: 'Latencia p95 (ms)', stream: 'default', layout: L(12, 0, 12, 6),
      sql: `SELECT approx_percentile_cont(duration_ms, 0.95) AS y_axis_1 FROM "default" ${HTTP}` }),
    metricValue({ title: 'Tasa de error HTTP (%)', stream: 'default', layout: L(24, 0, 12, 6),
      sql: `SELECT sum(CASE WHEN http_status_code >= 400 THEN 1 ELSE 0 END) * 100.0 / count(*) AS y_axis_1 FROM "default" ${HTTP}` }),
    metricValue({ title: 'Errores 5xx', stream: 'default', layout: L(36, 0, 12, 6), decimals: 0,
      sql: `SELECT count(*) AS y_axis_1 FROM "default" ${HTTP} AND http_status_code >= 500` }),
    timeseries({ title: 'Peticiones por segundo por endpoint', stream: 'default', layout: L(0, 6, 24, 10),
      select: 'count(*) / 60.0', breakdownCol: 'http_route', where: HTTP }),
    timeseries({ title: 'Latencia promedio por endpoint (ms)', stream: 'default', layout: L(24, 6, 24, 10),
      select: 'avg(duration_ms)', breakdownCol: 'http_route', where: HTTP }),
    timeseries({ title: 'Tasa de error por endpoint (%)', stream: 'default', layout: L(0, 16, 24, 10),
      select: 'sum(CASE WHEN http_status_code >= 400 THEN 1 ELSE 0 END) * 100.0 / count(*)', breakdownCol: 'http_route', where: HTTP }),
    timeseries({ title: 'Peticiones por statusCode', stream: 'default', layout: L(24, 16, 24, 10), type: 'bar',
      select: 'count(*)', breakdownCol: 'http_status_code', where: HTTP }),
    table({ title: 'Resumen por endpoint', stream: 'default', layout: L(0, 26, 48, 10),
      columns: ['endpoint', 'metodo', 'peticiones', 'latencia_avg_ms', 'latencia_p95_ms', 'errores'],
      sql: `SELECT http_route AS endpoint, http_method AS metodo, count(*) AS peticiones, round(avg(duration_ms), 2) AS latencia_avg_ms, round(approx_percentile_cont(duration_ms, 0.95), 2) AS latencia_p95_ms, sum(CASE WHEN http_status_code >= 400 THEN 1 ELSE 0 END) AS errores FROM "default" ${HTTP} GROUP BY endpoint, metodo ORDER BY peticiones DESC` }),
    table({ title: 'Últimas peticiones (log estructurado)', stream: 'default', layout: L(0, 36, 48, 10),
      columns: ['timestamp', 'http_method', 'http_route', 'http_status_code', 'duration_ms', 'trace_id'],
      sql: `SELECT to_timestamp_micros(_timestamp) AS timestamp, http_method, http_route, http_status_code, duration_ms, trace_id FROM "default" ${HTTP} ORDER BY _timestamp DESC LIMIT 50` }),
    table({ title: 'Eventos y excepciones (warn / error)', stream: 'default', layout: L(0, 46, 48, 9),
      columns: ['timestamp', 'severity', 'body', 'http_route', 'http_status_code', 'error'],
      sql: `SELECT to_timestamp_micros(_timestamp) AS timestamp, severity, body, http_route, http_status_code, error FROM "default" WHERE severity IN ('WARN', 'ERROR') ORDER BY _timestamp DESC LIMIT 50` }),
    table({ title: 'Trazas: spans más lentos (HTTP y SQLite)', stream: 'default', streamType: 'traces', layout: L(0, 55, 48, 10),
      columns: ['timestamp', 'operation_name', 'duracion_ms', 'span_kind', 'trace_id'],
      sql: `SELECT to_timestamp_micros(_timestamp) AS timestamp, operation_name, round(duration / 1000.0, 2) AS duracion_ms, span_kind, trace_id FROM "default" ORDER BY duration DESC LIMIT 30` }),
  ];
}

function infraDashboard() {
  return [
    metricValue({ title: 'CPU promedio (%)', stream: 'system_cpu_utilization', streamType: 'metrics', layout: L(0, 0, 12, 6),
      sql: `SELECT (1 - avg(value)) * 100 AS y_axis_1 FROM "system_cpu_utilization" WHERE state = 'idle'` }),
    metricValue({ title: 'RAM usada máx. (%)', stream: 'system_memory_utilization', streamType: 'metrics', layout: L(12, 0, 12, 6),
      sql: `SELECT max(value) * 100 AS y_axis_1 FROM "system_memory_utilization" WHERE state = 'used'` }),
    metricValue({ title: 'Load average máx. (1m)', stream: 'system_cpu_load_average_1m', streamType: 'metrics', layout: L(24, 0, 12, 6), decimals: 2,
      sql: `SELECT max(value) AS y_axis_1 FROM "system_cpu_load_average_1m"` }),
    temperatureTile(L(36, 0, 12, 6)),
    timeseries({ title: 'Consumo de CPU (%)', stream: 'system_cpu_utilization', streamType: 'metrics', layout: L(0, 6, 24, 10),
      select: '(1 - avg(value)) * 100', where: `WHERE state = 'idle'`, interval: '30 seconds' }),
    timeseries({ title: 'Memoria RAM usada (%)', stream: 'system_memory_utilization', streamType: 'metrics', layout: L(24, 6, 24, 10),
      select: 'max(value) * 100', where: `WHERE state = 'used'`, interval: '30 seconds' }),
    bandwidth({ title: 'Ancho de banda (bytes/s, rx/tx)', layout: L(0, 16, 24, 10) }),
    timeseries({ title: 'Memoria RAM por estado (MB)', stream: 'system_memory_usage', streamType: 'metrics', layout: L(24, 16, 24, 10),
      select: 'max(value) / 1048576', breakdownCol: 'state', interval: '30 seconds' }),
    temperatureChart(L(0, 26, 24, 10)),
    temperatureTable(L(24, 26, 24, 10)),
    timeseries({ title: 'Uso de disco (%)', stream: 'system_filesystem_utilization', streamType: 'metrics', layout: L(0, 36, 24, 9),
      select: 'max(value) * 100', breakdownCol: 'mountpoint', interval: '30 seconds' }),
    timeseries({ title: 'Load average', stream: 'system_cpu_load_average_1m', streamType: 'metrics', layout: L(24, 36, 24, 9),
      select: 'max(value)', interval: '30 seconds' }),
  ];
}

function cicdDashboard() {
  return [
    metricValue({ title: 'Ejecuciones de pruebas', stream: 'cicd_pipeline', layout: L(0, 0, 12, 6), decimals: 0,
      sql: `SELECT count(*) AS y_axis_1 FROM "cicd_pipeline" WHERE event = 'tests'` }),
    metricValue({ title: 'Pruebas fallidas (ejecuciones)', stream: 'cicd_pipeline', layout: L(12, 0, 12, 6), decimals: 0,
      sql: `SELECT count(*) AS y_axis_1 FROM "cicd_pipeline" WHERE event = 'tests' AND status = 'failure'` }),
    metricValue({ title: 'Despliegues exitosos', stream: 'cicd_pipeline', layout: L(24, 0, 12, 6), decimals: 0,
      sql: `SELECT count(*) AS y_axis_1 FROM "cicd_pipeline" WHERE event = 'deploy' AND status = 'success'` }),
    metricValue({ title: 'Despliegues bloqueados', stream: 'cicd_pipeline', layout: L(36, 0, 12, 6), decimals: 0,
      sql: `SELECT count(*) AS y_axis_1 FROM "cicd_pipeline" WHERE event = 'deploy' AND status = 'blocked'` }),
    timeseries({ title: 'Ejecuciones por resultado', stream: 'cicd_pipeline', layout: L(0, 6, 48, 9), type: 'bar',
      select: 'count(*)', breakdownCol: "concat(event, ' - ', status)", interval: '10 minutes' }),
    table({ title: 'Historial del pipeline (commit, rama, usuario)', stream: 'cicd_pipeline', layout: L(0, 15, 48, 14),
      columns: ['timestamp', 'event', 'status', 'commit', 'branch', 'actor', 'tests_passed', 'tests_failed', 'run_url'],
      sql: `SELECT to_timestamp_micros(_timestamp) AS timestamp, event, status, commit, branch, actor, tests_passed, tests_failed, run_url FROM "cicd_pipeline" ORDER BY _timestamp DESC LIMIT 100` }),
  ];
}

// Vista combinada para el criterio de aceptación 3: pipeline + trazas + recursos.
function overviewDashboard() {
  return [
    table({ title: 'Registros de ejecución del pipeline', stream: 'cicd_pipeline', layout: L(0, 0, 48, 9),
      columns: ['timestamp', 'event', 'status', 'commit', 'branch', 'actor'],
      sql: `SELECT to_timestamp_micros(_timestamp) AS timestamp, event, status, commit, branch, actor FROM "cicd_pipeline" ORDER BY _timestamp DESC LIMIT 20` }),
    table({ title: 'Trazas de peticiones HTTP recibidas', stream: 'default', streamType: 'traces', layout: L(0, 9, 48, 10),
      columns: ['timestamp', 'operation_name', 'duracion_ms', 'status_code', 'trace_id'],
      sql: `SELECT to_timestamp_micros(_timestamp) AS timestamp, operation_name, round(duration / 1000.0, 2) AS duracion_ms, status_code, trace_id FROM "default" WHERE span_kind = '2' OR operation_name LIKE 'GET %' OR operation_name LIKE 'POST %' OR operation_name LIKE 'PUT %' OR operation_name LIKE 'DELETE %' ORDER BY _timestamp DESC LIMIT 30` }),
    timeseries({ title: 'CPU (%)', stream: 'system_cpu_utilization', streamType: 'metrics', layout: L(0, 19, 12, 9),
      select: '(1 - avg(value)) * 100', where: `WHERE state = 'idle'`, interval: '30 seconds' }),
    timeseries({ title: 'RAM (%)', stream: 'system_memory_utilization', streamType: 'metrics', layout: L(12, 19, 12, 9),
      select: 'max(value) * 100', where: `WHERE state = 'used'`, interval: '30 seconds' }),
    bandwidth({ title: 'Ancho de banda (bytes/s)', layout: L(24, 19, 12, 9) }),
    temperatureTable(L(36, 19, 12, 9)),
  ];
}

const DASHBOARDS = [
  { title: '0. Resumen general (Pipeline + Trazas + EC2)', description: 'Vista simultánea del pipeline, trazas HTTP y recursos del servidor', panels: overviewDashboard },
  { title: '1. Aplicación - Endpoints (latencia, RPS, errores)', description: 'Métricas, logs y trazas de la API instrumentada con OpenTelemetry', panels: appDashboard },
  { title: '2. Infraestructura EC2 (CPU, RAM, red, temperatura)', description: 'Recursos del servidor recolectados por el OTel Collector (hostmetrics)', panels: infraDashboard },
  { title: '3. CI/CD - GitHub Actions', description: 'Resultados de pruebas y despliegues enviados por el pipeline', panels: cicdDashboard },
];

// --------------------------------------------------------------------------
// Alertas (programadas, evaluadas con SQL cada minuto)
// OpenObserve dispara cuando la consulta devuelve más filas que `threshold`.
// Un count(*) siempre devuelve una fila, así que la condición real va en HAVING
// y threshold queda en 0 (dispara solo si la consulta devuelve alguna fila).
// --------------------------------------------------------------------------
const ALERTS = [
  {
    name: 'api_tasa_errores_5xx', stream: 'default', streamType: 'logs',
    sql: `SELECT count(*) AS errores FROM "default" WHERE body = 'http_request' AND http_status_code >= 500 HAVING count(*) > 3`,
    threshold: 0, period: 5, description: 'Más de 3 respuestas 5xx en 5 minutos',
  },
  {
    name: 'api_latencia_alta', stream: 'default', streamType: 'logs',
    sql: `SELECT count(*) AS lentas FROM "default" WHERE body = 'http_request' AND duration_ms > 1000 HAVING count(*) > 5`,
    threshold: 0, period: 5, description: 'Más de 5 peticiones con latencia > 1 s en 5 minutos',
  },
  {
    name: 'ec2_cpu_alta', stream: 'system_cpu_utilization', streamType: 'metrics',
    sql: `SELECT avg(value) AS idle FROM "system_cpu_utilization" WHERE state = 'idle' HAVING avg(value) < 0.2`,
    threshold: 0, period: 5, description: 'CPU por encima del 80% en los últimos 5 minutos',
  },
  {
    name: 'ec2_ram_alta', stream: 'system_memory_utilization', streamType: 'metrics',
    sql: `SELECT max(value) AS usada FROM "system_memory_utilization" WHERE state = 'used' HAVING max(value) > 0.9`,
    threshold: 0, period: 5, description: 'Memoria RAM por encima del 90%',
  },
  {
    name: 'cicd_pruebas_fallidas', stream: 'cicd_pipeline', streamType: 'logs',
    sql: `SELECT count(*) AS fallos FROM "cicd_pipeline" WHERE event = 'tests' AND status = 'failure' HAVING count(*) > 0`,
    threshold: 0, period: 10, description: 'El pipeline reportó pruebas fallidas (despliegue bloqueado)',
  },
];

async function ensureDestination() {
  // Destino de tipo HTTP hacia el propio stream "alertas_disparadas" de OpenObserve,
  // así cada alerta disparada queda registrada y visible sin servicios externos.
  const templateName = 'plantilla_alerta_json';
  const destName = 'registro_alertas';
  const templateBody = JSON.stringify([{
    alerta: '{alert_name}', stream: '{stream_name}', tipo: '{alert_type}',
    periodo_min: '{alert_period}', conteo: '{alert_count}', disparada: '{timestamp}',
  }]);
  try { await o2('DELETE', `/api/${ORG}/alerts/destinations/${destName}`); } catch (e) { /* no existía */ }
  try { await o2('DELETE', `/api/${ORG}/alerts/templates/${templateName}`); } catch (e) { /* no existía */ }
  await o2('POST', `/api/${ORG}/alerts/templates`, { name: templateName, body: templateBody, type: 'http', isDefault: false });
  // Se usa la URL pública (O2_URL) porque OpenObserve bloquea IPs privadas (guard anti-SSRF).
  const url = process.env.O2_ALERT_WEBHOOK_URL || `${O2_URL}/api/${ORG}/alertas_disparadas/_json`;
  const headers = { 'Content-Type': 'application/json' };
  // Las credenciales solo se envían si el destino es el propio OpenObserve.
  if (url.startsWith(O2_URL)) headers.Authorization = AUTH;
  await o2('POST', `/api/${ORG}/alerts/destinations`, {
    name: destName, type: 'http', method: 'post', skip_tls_verify: true, template: templateName, url, headers,
  });
  return destName;
}

async function provisionAlerts() {
  // Primero se borran las alertas previas (dependen del destino y la plantilla).
  const existing = await o2('GET', `/api/v2/${ORG}/alerts`).catch(() => ({ list: [] }));
  for (const a of existing.list || []) {
    if (ALERTS.some((x) => x.name === a.name)) {
      await o2('DELETE', `/api/v2/${ORG}/alerts/${a.alert_id || a.id}`).catch((e) => console.log(`  [aviso] ${e.message}`));
    }
  }
  const dest = await ensureDestination();
  for (const a of ALERTS) {
    await o2('POST', `/api/v2/${ORG}/alerts`, {
      name: a.name,
      stream_type: a.streamType,
      stream_name: a.stream,
      is_real_time: false,
      query_condition: { type: 'sql', sql: a.sql, conditions: null, promql: null, aggregation: null },
      trigger_condition: { period: a.period, operator: '>', threshold: a.threshold, frequency: 1, frequency_type: 'minutes', silence: 10 },
      destinations: [dest],
      context_attributes: {},
      description: a.description,
      enabled: true,
    });
    console.log(`  alerta: ${a.name}`);
  }
}

async function provisionDashboards() {
  const list = await o2('GET', `/api/${ORG}/dashboards`);
  const titles = DASHBOARDS.map((d) => d.title);
  for (const d of list.dashboards || []) {
    if (titles.includes(d.title)) await o2('DELETE', `/api/${ORG}/dashboards/${d.dashboard_id}`);
  }
  for (const d of DASHBOARDS) {
    panelSeq = 0;
    await o2('POST', `/api/${ORG}/dashboards`, {
      version: 5,
      title: d.title,
      description: d.description,
      tabs: [{ tabId: 'default', name: 'Default', panels: d.panels() }],
      variables: { list: [], showDynamicFilters: false },
      defaultDatetimeDuration: { type: 'relative', relativeTimePeriod: '1h', startTime: 0, endTime: 0 },
    });
    console.log(`  dashboard: ${d.title}`);
  }
}

// Crea los streams con un registro inicial para que dashboards/alertas no fallen
// antes de que llegue el primer dato real.
async function ensureStreams() {
  const now = new Date().toISOString();
  const seed = { _timestamp: now, event: 'provision', status: 'info', commit: '', branch: '', actor: 'provision-script' };
  await o2('POST', `/api/${ORG}/cicd_pipeline/_json`, [seed]);
}

async function streamFields(name, type) {
  try {
    const s = await o2('GET', `/api/${ORG}/streams/${name}/schema?type=${type}`);
    return (s.schema || []).map((f) => f.name);
  } catch (e) {
    return null;
  }
}

// Espera (hasta ~2 min) a que existan los streams que usan las alertas.
async function waitForStreams() {
  const needed = [['default', 'logs'], ['system_cpu_utilization', 'metrics'], ['system_memory_utilization', 'metrics']];
  for (let i = 0; i < 24; i += 1) {
    const missing = [];
    for (const [name, type] of needed) if (!(await streamFields(name, type))) missing.push(name);
    if (!missing.length) return;
    console.log(`  esperando streams: ${missing.join(', ')}`);
    await new Promise((r) => setTimeout(r, 5000));
  }
}

(async () => {
  console.log(`Aprovisionando OpenObserve en ${O2_URL} (org: ${ORG})`);
  await ensureStreams();
  await waitForStreams();
  hasCelsius = ((await streamFields('host_temperature', 'logs')) || []).includes('celsius');
  console.log(`  sensor de temperatura con datos: ${hasCelsius ? 'sí' : 'no'}`);
  await provisionDashboards();
  try {
    await provisionAlerts();
  } catch (e) {
    console.error(`  [aviso] No se pudieron crear las alertas: ${e.message}`);
    process.exitCode = 1;
  }
  console.log('Listo.');
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
