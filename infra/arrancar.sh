#!/usr/bin/env bash
# ============================================================================
#  Levanta el sistema DENTRO del droplet. Se puede repetir cuantas veces haga
#  falta: baja lo último de GitHub, reconstruye y vuelve a subir.
#
#      cd /opt/monitoreo-rutas && ./infra/arrancar.sh
#
#  Es el equivalente de ./desplegar.sh cuando no se está entrando por SSH sino
#  desde la consola web del droplet. Desde tu máquina usa ./desplegar.sh, que
#  además respalda la base antes de tocar nada.
# ============================================================================
set -euo pipefail

AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$AQUI"

COMPOSE="docker compose -f docker-compose.yml -f docker-compose.prod.yml"

rojo()  { printf '\033[31m%s\033[0m\n' "$*"; }
verde() { printf '\033[32m%s\033[0m\n' "$*"; }
paso()  { printf '\n\033[1;34m▶ %s\033[0m\n' "$*"; }

[ -f .env ] || { rojo "✗ Falta $AQUI/.env — corre primero infra/provisionar.sh"; exit 1; }

valor() { grep -E "^$1=" .env | head -1 | cut -d= -f2- || true; }

paso "Bajando lo último de GitHub"
git fetch origin main --quiet
git reset --hard origin/main --quiet
echo "  commit $(git rev-parse --short HEAD) — $(git log -1 --pretty=%s)"
chmod +x infra/*.sh desplegar.sh 2>/dev/null || true

# El respaldo va antes de construir. Si la migración nueva sale mal, esto es
# lo único que separa un rato de trabajo de una operación completa perdida.
paso "Respaldo de la base"
mkdir -p respaldos
if $COMPOSE ps db --status running -q 2>/dev/null | grep -q .; then
  ARCHIVO="respaldos/pre-arranque-$(date +%Y%m%d-%H%M%S).sql.gz"
  $COMPOSE exec -T db pg_dump -U "$(valor POSTGRES_USER)" "$(valor POSTGRES_DB)" | gzip > "$ARCHIVO"
  echo "  $ARCHIVO"
else
  echo "  (primera vez: todavía no hay base)"
fi

paso "Construyendo"
$COMPOSE build

paso "Levantando"
# El API aplica las migraciones al arrancar; por eso no hay un paso aparte.
$COMPOSE up -d --remove-orphans

paso "Esperando al API"
LISTO=0
for i in $(seq 1 45); do
  if $COMPOSE exec -T api curl -fsS http://localhost:3000/salud >/dev/null 2>&1; then
    LISTO=1
    echo "  arriba ($i s)"
    break
  fi
  sleep 1
done
if [ "$LISTO" != 1 ]; then
  rojo "✗ El API no respondió. Últimas líneas:"
  $COMPOSE logs --tail 40 api
  exit 1
fi

docker image prune -f >/dev/null 2>&1 || true

# ── Qué falta para poder mandar WhatsApp de verdad ──────────────────────────
# Se avisa aquí y no en la primera falla de envío: un token vacío no revienta
# el arranque, revienta el primer marcaje del día, a las cuatro de la mañana.
paso "Revisión de configuración"
FALTAN=""
for v in WA_ID_NUMERO WA_TOKEN WA_APP_SECRET WA_VERIFY_TOKEN; do
  [ -z "$(valor $v)" ] && FALTAN="$FALTAN $v"
done

DOMINIO="$(valor URL_PUBLICA)"
if [ -n "$FALTAN" ]; then
  echo "  Faltan en el .env:$FALTAN"
  echo "     ./infra/env.sh WA_TOKEN <valor>"
elif [ "$(valor WA_SIMULADO)" = "1" ]; then
  echo "  Credenciales completas, pero WA_SIMULADO=1: no sale ningún mensaje real."
  echo "     ./infra/env.sh WA_SIMULADO 0   &&   ./infra/arrancar.sh"
else
  verde "  WhatsApp en modo REAL. Los mensajes salen y se cobran."
fi

# Autofirmado = el emisor es el propio sujeto. Se compara así y no buscando
# "Let's Encrypt" en el emisor: el formato que imprime openssl cambia entre
# versiones y un grep frágil aquí haría creer que el certificado está bien.
if [ -f infra/certs/fullchain.pem ]; then
  SUJETO="$(openssl x509 -in infra/certs/fullchain.pem -noout -subject 2>/dev/null | sed 's/^subject=*//')"
  EMISOR="$(openssl x509 -in infra/certs/fullchain.pem -noout -issuer  2>/dev/null | sed 's/^issuer=*//')"
  if [ -n "$SUJETO" ] && [ "$SUJETO" = "$EMISOR" ]; then
    echo "  Certificado autofirmado. Meta rechaza el webhook con este."
    echo "     sudo /usr/local/bin/renovar-certificado"
  fi
fi

$COMPOSE ps
verde "
✓ Arriba
  Portal:             $DOMINIO/monitoreo
  Webhook para Meta:  $DOMINIO/webhook"
