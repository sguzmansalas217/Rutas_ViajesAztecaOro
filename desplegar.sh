#!/usr/bin/env bash
# ============================================================================
#  DESPLIEGUE — EL COMANDO ÚNICO
#
#      ./desplegar.sh
#
#  Entra por SSH al droplet, baja lo último de GitHub, reconstruye los
#  contenedores, aplica migraciones y verifica que quedó arriba.
#  Si algo falla, aborta antes de tocar los contenedores en marcha.
#
#  Configuración: variables DESPLIEGUE_* en el .env local (ver .env.example).
#      DESPLIEGUE_HOST=despliegue@159.xx.xx.xx
#      DESPLIEGUE_RUTA=/opt/monitoreo-rutas
#      DESPLIEGUE_RAMA=main
# ============================================================================
set -euo pipefail

AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "$AQUI/.env" ] && set -a && . "$AQUI/.env" && set +a

HOST="${DESPLIEGUE_HOST:-}"
RUTA="${DESPLIEGUE_RUTA:-/opt/monitoreo-rutas}"
RAMA="${DESPLIEGUE_RAMA:-main}"

rojo()  { printf '\033[31m%s\033[0m\n' "$*"; }
verde() { printf '\033[32m%s\033[0m\n' "$*"; }
paso()  { printf '\n\033[1;34m▶ %s\033[0m\n' "$*"; }

if [ -z "$HOST" ]; then
  rojo "Falta DESPLIEGUE_HOST en el .env (ej. despliegue@159.65.1.2)"
  exit 1
fi

# ── Comprobaciones locales antes de tocar nada ──────────────────────────────
paso "Revisando el repositorio local"
if [ -n "$(git -C "$AQUI" status --porcelain)" ]; then
  rojo "Hay cambios sin commitear. Súbelos a GitHub antes de desplegar:"
  git -C "$AQUI" status --short
  exit 1
fi

LOCAL="$(git -C "$AQUI" rev-parse HEAD)"
git -C "$AQUI" fetch origin "$RAMA" --quiet
REMOTO="$(git -C "$AQUI" rev-parse "origin/$RAMA")"
if [ "$LOCAL" != "$REMOTO" ]; then
  rojo "Tu rama local y origin/$RAMA no coinciden. Haz git push (o git pull) primero."
  exit 1
fi
verde "  commit $(git -C "$AQUI" rev-parse --short HEAD) — $(git -C "$AQUI" log -1 --pretty=%s)"

paso "Desplegando en $HOST:$RUTA (rama $RAMA)"

ssh -o StrictHostKeyChecking=accept-new "$HOST" bash -euo pipefail <<REMOTO_FIN
cd "$RUTA"

if [ ! -f .env ]; then
  echo "✗ No existe $RUTA/.env en el servidor. Créalo antes de desplegar."
  exit 1
fi

echo "▶ Bajando el código…"
git fetch origin "$RAMA" --quiet
git reset --hard "origin/$RAMA" --quiet
echo "  commit \$(git rev-parse --short HEAD) — \$(git log -1 --pretty=%s)"

echo "▶ Respaldo previo de la base…"
mkdir -p respaldos
if docker compose ps db --status running -q 2>/dev/null | grep -q .; then
  docker compose exec -T db pg_dump -U "\${POSTGRES_USER:-monitoreo}" "\${POSTGRES_DB:-monitoreo}" \
    | gzip > "respaldos/pre-despliegue-\$(date +%Y%m%d-%H%M%S).sql.gz"
  echo "  respaldo hecho"
else
  echo "  (primera vez: aún no hay base)"
fi

echo "▶ Construyendo imágenes…"
docker compose -f docker-compose.yml -f docker-compose.prod.yml build

echo "▶ Levantando…"
# El API aplica las migraciones al arrancar; por eso no hay paso aparte.
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --remove-orphans

echo "▶ Esperando a que el API responda…"
for i in \$(seq 1 30); do
  if docker compose exec -T api curl -fsS http://localhost:3000/salud >/dev/null 2>&1; then
    echo "  API arriba (\$i s)"
    ok=1
    break
  fi
  sleep 1
done

if [ "\${ok:-0}" != "1" ]; then
  echo "✗ El API no respondió. Últimas líneas del log:"
  docker compose logs --tail 40 api
  exit 1
fi

echo "▶ Limpiando imágenes viejas…"
docker image prune -f >/dev/null

docker compose ps
REMOTO_FIN

paso "Verificando desde fuera"
DOMINIO="${URL_PUBLICA:-}"
if [ -n "$DOMINIO" ] && curl -fsS -m 10 -k "$DOMINIO/salud" >/dev/null 2>&1; then
  verde "  $DOMINIO/salud responde"
else
  echo "  (sin verificación externa: revisa URL_PUBLICA o el DNS)"
fi

verde "
✓ Desplegado."
