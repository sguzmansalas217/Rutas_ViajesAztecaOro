#!/usr/bin/env bash
# ============================================================================
#  Cambia UNA variable del .env sin abrir un editor.
#
#      ./infra/env.sh WA_TOKEN EAAG...
#      ./infra/env.sh WA_SIMULADO 0
#
#  Existe por la consola web del droplet: ahí nano se pelea con el pegado y un
#  token de Meta son doscientos caracteres que nadie va a teclear dos veces.
#
#  El valor NO se imprime nunca. Se confirma la clave y cuántos caracteres
#  entraron, que es lo que hace falta para saber si el pegado se cortó.
# ============================================================================
set -euo pipefail

AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARCHIVO="$AQUI/.env"

CLAVE="${1:-}"
shift || true
VALOR="${*:-}"

if [ -z "$CLAVE" ]; then
  echo "Uso: ./infra/env.sh CLAVE valor"
  echo "Claves que suelen faltar: WA_ID_NUMERO WA_ID_CUENTA WA_TOKEN WA_APP_SECRET WA_APP_ID"
  exit 1
fi
[ -f "$ARCHIVO" ] || { echo "✗ No existe $ARCHIVO"; exit 1; }

# Se reescribe línea por línea en vez de con sed: el valor puede traer /, &, |
# o comillas, y cualquiera de esos rompe una expresión de sed de formas que no
# se notan hasta que el sistema falla al conectarse a Meta.
TEMPORAL="$(mktemp)"
trap 'rm -f "$TEMPORAL"' EXIT
ENCONTRADA=0

while IFS= read -r linea || [ -n "$linea" ]; do
  case "$linea" in
    "$CLAVE="*)
      printf '%s=%s\n' "$CLAVE" "$VALOR" >> "$TEMPORAL"
      ENCONTRADA=1
      ;;
    *) printf '%s\n' "$linea" >> "$TEMPORAL" ;;
  esac
done < "$ARCHIVO"

if [ "$ENCONTRADA" = 0 ]; then
  printf '%s=%s\n' "$CLAVE" "$VALOR" >> "$TEMPORAL"
fi

# cat y no mv: conserva dueño y permisos del .env original. Un mv lo dejaría
# con los del temporal y el archivo con las credenciales acabaría legible.
cat "$TEMPORAL" > "$ARCHIVO"
chmod 600 "$ARCHIVO"

if [ -z "$VALOR" ]; then
  echo "$CLAVE quedó VACÍA."
else
  echo "$CLAVE actualizada · ${#VALOR} caracteres · termina en …${VALOR: -4}"
fi
echo "Para que surta efecto:  ./infra/arrancar.sh"
