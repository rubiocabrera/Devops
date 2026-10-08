# Pipeline CI/CD Automatizado para API REST con Docker, GitHub Actions y AWS EC2

API REST en Node.js/Express con base de datos SQLite, contenerizada con Docker y desplegada automáticamente en una instancia de AWS EC2 mediante un pipeline de integración y despliegue continuo construido con GitHub Actions.

- **API pública**: http://100.22.29.28/api/status
- **Imagen en Docker Hub**: https://hub.docker.com/r/skondit01/webapp
- **Pipeline (Actions)**: https://github.com/rubiocabrera/Devops/actions

## Arquitectura

```
┌─────────────┐   push a main   ┌──────────────────┐
│  Repositorio │ ───────────────▶│   GitHub Actions  │
│   (GitHub)   │                 │   (main.yml)       │
└─────────────┘                 └─────────┬─────────┘
                                           │
                        ┌──────────────────┼──────────────────┐
                        ▼                  ▼                  ▼
                 1. Tests y          2. Build y          3. Desplegar
                    cobertura           publicar en          en AWS EC2
                    (Jest/Supertest)    Docker Hub           (SSH)
                                        (:latest, :sha)
                                                                 │
                                                                 ▼
                                                      ┌─────────────────────┐
                                                      │   AWS EC2 (Ubuntu)   │
                                                      │  docker pull + run   │
                                                      │   puerto 80 (HTTP)   │
                                                      └─────────────────────┘
```

El pipeline (`.github/workflows/main.yml`) se activa en cada `push` o `pull_request` a la rama `main` y ejecuta tres jobs en cadena:

1. **Tests y cobertura** — instala dependencias y corre la suite completa de pruebas (Jest + Supertest) con un umbral mínimo de cobertura del 70%.
2. **Build y publicar en Docker Hub** — solo en `push` a `main`; construye la imagen con Docker Buildx (usando caché de capas de GitHub Actions) y la publica con las etiquetas `:latest` y `:${{ github.sha }}`.
3. **Desplegar en AWS EC2** — se conecta por SSH a la instancia, limpia imágenes de Docker no usadas, descarga la imagen más reciente, detiene el contenedor anterior y levanta uno nuevo en el puerto 80.

## Endpoints principales

Todas las respuestas siguen el esquema `{ statusCode, data }`.

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/status` | Estado del servidor |
| GET | `/api/usuarios` | Lista de usuarios |
| GET | `/api/usuarios/:id` | Usuario por id |
| POST | `/api/usuarios` | Crear usuario |
| PUT | `/api/usuarios/:id` | Actualizar usuario |
| DELETE | `/api/usuarios/:id` | Eliminar usuario |
| GET | `/api/publicaciones` | Lista de publicaciones |
| POST | `/api/publicaciones` | Crear publicación |
| PUT | `/api/publicaciones/:id` | Actualizar publicación |
| DELETE | `/api/publicaciones/:id` | Eliminar publicación |
| POST | `/api/admin/backup` | Respaldo de la base de datos |
| POST | `/api/admin/clear` | Vaciar la base de datos |

## Comandos locales

```bash
# Instalar dependencias
npm install

# Correr el servidor localmente (puerto 80 por defecto)
node index.js

# Correr las pruebas
npm test

# Correr las pruebas con reporte de cobertura
npm run test:coverage

# Construir la imagen Docker
docker build -t webapp:latest .

# Correr el contenedor localmente
docker run -d -p 8080:80 --name webapp-container webapp:latest
```

## Configuración del pipeline (GitHub Secrets)

Para que el workflow funcione en un fork o repositorio nuevo, se deben configurar estos *repository secrets* en **Settings → Secrets and variables → Actions**:

| Secret | Descripción |
|---|---|
| `DOCKERHUB_USERNAME` | Usuario de Docker Hub |
| `DOCKERHUB_TOKEN` | Personal Access Token de Docker Hub (permisos Read & Write) |
| `EC2_HOST` | IP pública (o Elastic IP) de la instancia EC2 |
| `EC2_SSH_KEY` | Contenido completo de la llave privada `.pem` usada para conectarse a la EC2 |

Ningún dato sensible se incluye en el código del repositorio; todos se gestionan exclusivamente mediante estos Secrets.

## Infraestructura en AWS EC2

- Ubuntu Server 24.04 LTS, instancia `t3.micro` (Free Tier).
- Docker Engine instalado.
- Security Group con reglas de entrada para el puerto 22 (SSH) y el puerto 80 (HTTP), origen `0.0.0.0/0`.
- IP Elástica asociada para que la dirección pública no cambie entre reinicios.

## Pruebas automatizadas

58 pruebas con Jest y Supertest, distribuidas en tres suites (integración, unitarias con mocks, y protocolo TCP complementario), con 91.5% de cobertura de statements. Ver el reporte del proyecto (PDF) para el detalle completo.
