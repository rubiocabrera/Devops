# CI/CD con pruebas automatizadas y observabilidad (GitHub Actions + Playwright + OpenObserve + AWS EC2)

Sistema web con **Login, Register y CRUD de usuarios** (Node.js/Express + SQLite + JWT), desplegado en AWS EC2 con un pipeline de GitHub Actions. El pipeline **solo despliega si pasan todas las pruebas** (Jest + Playwright) y registra cada ejecución en **OpenObserve**. La aplicación está instrumentada con **OpenTelemetry (OTLP)** y envía logs, métricas y trazas. Además, el servidor reporta CPU, RAM, ancho de banda, disco y temperatura.

- **Aplicación**: `http://<EC2_HOST>/`
- **OpenObserve**: `http://<EC2_HOST>:5080/`
- **Pipeline**: https://github.com/rubiocabrera/Devops/actions

## Arquitectura

```
 push a main ─▶ GitHub Actions
                 │
                 ├─ 1. Pruebas ── Jest (backend) + Playwright (UI + API)
                 │        │  └─▶ OpenObserve: evento "tests" (éxito/fallo, commit, rama, usuario)
                 │        └─ si falla ─▶ evento "deploy: blocked" y NO hay conexión SSH a EC2
                 │
                 ├─ 2. Build ──── imagen Docker → Docker Hub (:latest y :sha)
                 │
                 └─ 3. Deploy ─── SSH a EC2 → docker compose up
                          └─▶ OpenObserve: evento "deploy" + aprovisiona dashboards/alertas

 AWS EC2 (Docker Compose)
 ┌──────────────┐ OTLP  ┌────────────────┐  OTLP/HTTP  ┌─────────────┐
 │ webapp :80   │──────▶│ otel-collector │────────────▶│ OpenObserve │
 │ (API + UI)   │       │ + hostmetrics  │             │   :5080     │
 └──────────────┘       └────────────────┘             └─────────────┘
 ┌──────────────┐  JSON (temperatura)                         ▲
 │ temp-exporter│─────────────────────────────────────────────┘
 └──────────────┘
```

## Funcionalidad

| Página | Descripción |
|---|---|
| `/` (index.html) | Login |
| `/register.html` | Registro de usuario |
| `/usuarios.html` | CRUD de usuarios (requiere sesión) |

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| POST | `/api/auth/register` | — | Registro (bcrypt) → devuelve JWT |
| POST | `/api/auth/login` | — | Login → devuelve JWT |
| GET | `/api/auth/me` | JWT | Usuario de la sesión |
| GET/POST | `/api/usuarios` | JWT | Listar / crear usuarios |
| GET/PUT/DELETE | `/api/usuarios/:id` | JWT | Leer / actualizar / eliminar |
| GET | `/api/status` | — | Estado del servidor |
| ... | `/api/publicaciones`, `/api/admin/*` | — | Endpoints heredados |

## Pruebas

```bash
npm install
npm test                 # Jest: 72 pruebas (integración, unitarias con mocks, auth, TCP)
npx playwright install chromium
npm run test:e2e         # Playwright: 21 pruebas (10 API + 11 UI)
```

Playwright levanta la app automáticamente con una BD en memoria. Para probar contra un servidor ya desplegado: `E2E_BASE_URL=http://<host> npx playwright test`.

## Observabilidad (OpenTelemetry → OpenObserve)

- **Trazas**: spans HTTP (auto-instrumentación http/express) + un span por cada consulta SQLite (`sqlite SELECT`, `sqlite INSERT`, ...), con `db.statement`.
- **Métricas**: `http_requests_total`, `http_errors_total` y `http_request_duration_ms` por `http.route`, `http.method` y `http.status_code`, más métricas de runtime de Node.
- **Logs**: eventos estructurados (`http_request`, `auth_login_ok`, `auth_login_failed`, `unhandled_exception`, ...) correlacionados con `trace_id`.
- **Infraestructura**: `hostmetrics` del OTel Collector (CPU, RAM, red, disco, load average) y `temp-exporter` (temperatura desde `/sys/class/thermal` y `hwmon`).
- **CI/CD**: stream `cicd_pipeline` con cada ejecución de pruebas y despliegue.

Dashboards (los crea `deploy/provision-openobserve.js` en cada deploy):
0. Resumen general (pipeline + trazas + recursos de EC2)
1. Aplicación: endpoints (latencia, RPS, errores, logs, trazas)
2. Infraestructura EC2 (CPU, RAM, ancho de banda, temperatura, disco)
3. CI/CD: GitHub Actions

Alertas: `api_tasa_errores_5xx`, `api_latencia_alta`, `ec2_cpu_alta`, `ec2_ram_alta` y `cicd_pruebas_fallidas`.

## Configuración (GitHub Secrets)

| Secret | Descripción |
|---|---|
| `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN` | Docker Hub |
| `EC2_HOST` | IP pública (Elastic IP) de la instancia |
| `EC2_SSH_KEY` | Contenido de la llave `.pem` |
| `O2_USER` / `O2_PASSWORD` | Usuario raíz de OpenObserve (email y contraseña) |
| `JWT_SECRET` | Secreto para firmar los JWT |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | Usuario administrador inicial de la app |

Security Group de EC2: puertos de entrada 22 (SSH), 80 (app) y 5080 (OpenObserve).

## Ejecutar el stack localmente

```bash
docker build -t local/webapp:latest .
cd deploy
# crear .env con DOCKERHUB_USERNAME=local, O2_USER, O2_PASSWORD, O2_AUTH=base64(user:pass), JWT_SECRET...
docker compose up -d
O2_URL=http://localhost:5080 O2_USER=... O2_PASSWORD=... node provision-openobserve.js
```
