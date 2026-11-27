// ==========================================================================
// Instrumentación OpenTelemetry (OTLP) -> OTel Collector -> OpenObserve
//
// Se activa SOLO si existe la variable OTEL_EXPORTER_OTLP_ENDPOINT
// (p. ej. http://otel-collector:4318). En pruebas locales/CI no se define,
// así que la app funciona igual sin enviar telemetría.
//
// Emite las tres señales:
//   - Trazas:   HTTP entrante (auto-instrumentación http/express) + un span
//               por cada consulta a SQLite (instrumentDb).
//   - Métricas: contador de peticiones y histograma de latencia por endpoint,
//               método y statusCode (httpMetricsMiddleware) + métricas de
//               runtime de Node.
//   - Logs:     eventos estructurados de operación y excepciones (log()).
// ==========================================================================
const api = require('@opentelemetry/api');
const { logs: logsApi, SeverityNumber } = require('@opentelemetry/api-logs');

const enabled = Boolean(process.env.OTEL_EXPORTER_OTLP_ENDPOINT);
let sdk = null;

if (enabled) {
  const { NodeSDK } = require('@opentelemetry/sdk-node');
  const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
  const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
  const { OTLPMetricExporter } = require('@opentelemetry/exporter-metrics-otlp-http');
  const { OTLPLogExporter } = require('@opentelemetry/exporter-logs-otlp-http');
  const { PeriodicExportingMetricReader } = require('@opentelemetry/sdk-metrics');
  const { BatchLogRecordProcessor } = require('@opentelemetry/sdk-logs');
  const { resourceFromAttributes } = require('@opentelemetry/resources');

  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      'service.name': process.env.OTEL_SERVICE_NAME || 'webapp-api',
      'service.version': process.env.APP_VERSION || 'dev',
      'deployment.environment': process.env.NODE_ENV || 'production',
    }),
    traceExporter: new OTLPTraceExporter(),
    metricReaders: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter(),
        exportIntervalMillis: 15000,
      }),
    ],
    logRecordProcessors: [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter() })],
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-dns': { enabled: false },
        '@opentelemetry/instrumentation-net': { enabled: false },
        // Solo spans de los handlers de cada ruta, no de cada middleware.
        '@opentelemetry/instrumentation-express': { ignoreLayersType: ['middleware'] },
      }),
    ],
  });
  sdk.start();

  const shutdown = () => sdk.shutdown().finally(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

const tracer = api.trace.getTracer('webapp-api');
const meter = api.metrics.getMeter('webapp-api');
const otelLogger = logsApi.getLogger('webapp-api');

const requestCounter = meter.createCounter('http_requests_total', {
  description: 'Total de peticiones HTTP por endpoint, método y statusCode',
});
const errorCounter = meter.createCounter('http_errors_total', {
  description: 'Total de respuestas HTTP con statusCode >= 400',
});
const latencyHistogram = meter.createHistogram('http_request_duration_ms', {
  description: 'Latencia de las peticiones HTTP en milisegundos',
  unit: 'ms',
});

const SEVERITY = {
  debug: SeverityNumber.DEBUG,
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
};

// Log estructurado: siempre a stdout en JSON y, si OTel está activo, a OpenObserve.
function log(level, message, attributes = {}) {
  if (process.env.NODE_ENV === 'test' && !enabled) return;
  const record = { timestamp: new Date().toISOString(), level, message, ...attributes };
  const line = JSON.stringify(record);
  if (level === 'error') console.error(line);
  else console.log(line);
  if (enabled) {
    otelLogger.emit({
      severityNumber: SEVERITY[level] || SeverityNumber.INFO,
      severityText: level.toUpperCase(),
      body: message,
      attributes,
    });
  }
}

// Ruta "plantilla" (/api/usuarios/:id) para no crear una serie por cada id.
function routeOf(req) {
  if (req.route && req.route.path) return (req.baseUrl || '') + req.route.path;
  if (req.baseUrl) return req.baseUrl;
  if (req.path.startsWith('/api/')) return 'unmatched';
  return 'static';
}

function httpMetricsMiddleware(req, res, next) {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    const attrs = {
      'http.route': routeOf(req),
      'http.method': req.method,
      'http.status_code': res.statusCode,
    };
    requestCounter.add(1, attrs);
    latencyHistogram.record(durationMs, attrs);
    if (res.statusCode >= 400) errorCounter.add(1, attrs);
    if (attrs['http.route'] !== 'static') {
      const ms = Math.round(durationMs * 100) / 100;
      const path = (req.originalUrl || req.url || '').split('?')[0];
      log(res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info', 'http_request', {
        ...attrs,
        'http.target': path,
        duration_ms: ms,
        // Resumen legible de la petición para la vista de Logs de OpenObserve.
        resumen: `${req.method} ${path} -> ${res.statusCode} (${ms} ms)`,
      });
    }
  });
  next();
}

// Envuelve run/get/all de sqlite3 para crear un span hijo por consulta.
function instrumentDb(db) {
  if (!enabled) return db;
  for (const method of ['run', 'get', 'all']) {
    const original = db[method].bind(db);
    db[method] = (sql, ...args) => {
      const operation = String(sql).trim().split(/\s+/)[0].toUpperCase();
      const span = tracer.startSpan(`sqlite ${operation}`, {
        kind: api.SpanKind.CLIENT,
        attributes: {
          'db.system': 'sqlite',
          'db.operation': operation,
          'db.statement': String(sql).replace(/\s+/g, ' ').trim(),
        },
      });
      const cbIndex = args.findIndex((a) => typeof a === 'function');
      if (cbIndex === -1) {
        span.end();
        return original(sql, ...args);
      }
      const cb = args[cbIndex];
      args[cbIndex] = function (err, ...rest) {
        if (err) {
          span.recordException(err);
          span.setStatus({ code: api.SpanStatusCode.ERROR, message: err.message });
        }
        span.end();
        return cb.call(this, err, ...rest);
      };
      return original(sql, ...args);
    };
  }
  return db;
}

// Marca el span activo de la petición con la excepción (aparece en la traza).
function recordException(err) {
  const span = api.trace.getActiveSpan();
  if (!span) return;
  span.recordException(err);
  span.setStatus({ code: api.SpanStatusCode.ERROR, message: err.message });
}

module.exports = { enabled, log, httpMetricsMiddleware, instrumentDb, recordException };
