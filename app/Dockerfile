# Una sola imagen, dos entradas: servidor.js (API) y trabajador.js (scheduler).
FROM node:22-alpine

RUN apk add --no-cache tini curl

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY . .

# Nunca correr como root dentro del contenedor.
RUN chown -R node:node /app
USER node

ENV NODE_ENV=production
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://localhost:3000/salud || exit 1

# tini como PID 1: SIGTERM llega limpio y el cierre elegante funciona.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/servidor.js"]
