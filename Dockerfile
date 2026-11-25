# ---------- Etapa 1: compilar dependencias ----------
# sqlite3 necesita compilarse contra la glibc de esta imagen (el binario
# precompilado falla con "GLIBC_x.xx not found"), por eso se instalan
# herramientas de compilación SOLO en esta etapa.
FROM node:20-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci --omit=dev --build-from-source && npm cache clean --force

# ---------- Etapa 2: imagen final ligera ----------
# Sin compiladores ni dependencias de desarrollo (jest, playwright).
FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY package*.json index.js telemetry.js ./
COPY public ./public

EXPOSE 80
EXPOSE 6061

CMD ["node", "index.js"]
