#!/usr/bin/env bash
# ============================================================================
#  PROVISIÓN DEL DROPLET — se corre UNA SOLA VEZ, dentro del servidor.
#
#  Ubuntu 24.04 limpio en DigitalOcean (2 GB para empezar).
#
#  Uso, como root en el droplet recién creado (consola web de DigitalOcean):
#     curl -fsSL https://raw.githubusercontent.com/sguzmansalas217/Rutas_ViajesAztecaOro/main/infra/provisionar.sh | bash -s -- monitoreo.tudominio.com tu@correo.com
#
#  Si todavía no hay dominio, sirve la IP con sslip.io —resuelve a la IP que
#  lleva en el nombre y Let's Encrypt le emite certificado igual, así que el
#  webhook de Meta funciona sin comprar nada:
#     ... | bash -s -- 159-65-1-2.sslip.io tu@correo.com
#
#  Deja el servidor listo y el repositorio clonado. Después: infra/arrancar.sh
# ============================================================================
set -euo pipefail

DOMINIO="${1:-}"
CORREO="${2:-}"
RUTA="/opt/monitoreo-rutas"
USUARIO="despliegue"
REPO="https://github.com/sguzmansalas217/Rutas_ViajesAztecaOro.git"

# Con el repositorio privado hace falta un token de lectura. Se pasa por el
# entorno y no como argumento: los argumentos salen en 'ps' y quedan en el
# historial de la consola, el entorno de este proceso no.
#
#   export GH_TOKEN=github_pat_...
#   curl -fsSL -H "Authorization: Bearer $GH_TOKEN" <raw>/provisionar.sh | bash -s -- dominio correo
#
# El token queda dentro de la URL del remoto en .git/config, que es como
# funcionan los tokens de despliegue. El archivo es del usuario despliegue en
# un servidor al que sólo entras tú; aun así conviene que el token sea de sólo
# lectura y limitado a este repositorio (fine-grained, Contents: Read-only).
GH_TOKEN="${GH_TOKEN:-}"
if [ -n "$GH_TOKEN" ]; then
  REPO="https://x-access-token:$GH_TOKEN@github.com/sguzmansalas217/Rutas_ViajesAztecaOro.git"
fi

[ -z "$DOMINIO" ] && { echo "Uso: provisionar.sh <dominio> <correo>"; exit 1; }

echo "▶ Actualizando el sistema…"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get upgrade -y -qq
apt-get install -y -qq ca-certificates curl git ufw fail2ban unattended-upgrades openssl cron
# Sin cron no hay renovación del certificado ni respaldo diario. Viene en la
# imagen de DigitalOcean, pero se pide explícito: si algún día falta, el
# sistema seguiría funcionando y el certificado caducaría a los tres meses.
systemctl enable --now cron

echo "▶ Instalando Docker…"
if ! command -v docker >/dev/null; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
systemctl enable --now docker

echo "▶ Usuario de despliegue…"
id -u "$USUARIO" >/dev/null 2>&1 || adduser --disabled-password --gecos "" "$USUARIO"
usermod -aG docker "$USUARIO"
mkdir -p /home/$USUARIO/.ssh
[ -f /root/.ssh/authorized_keys ] && cp /root/.ssh/authorized_keys /home/$USUARIO/.ssh/
chown -R $USUARIO:$USUARIO /home/$USUARIO/.ssh
chmod 700 /home/$USUARIO/.ssh
chmod 600 /home/$USUARIO/.ssh/authorized_keys 2>/dev/null || true

echo "▶ Firewall…"
ufw --force reset >/dev/null
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

echo "▶ Endureciendo SSH…"
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/'  /etc/ssh/sshd_config
systemctl restart ssh || systemctl restart sshd

echo "▶ fail2ban y parches automáticos…"
systemctl enable --now fail2ban
dpkg-reconfigure -f noninteractive unattended-upgrades

echo "▶ Swap de 2 GB (evita que el build se quede sin memoria)…"
if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "▶ Clonando el repositorio…"
mkdir -p "$RUTA"
chown -R $USUARIO:$USUARIO "$RUTA"
if [ -d "$RUTA/.git" ]; then
  su - $USUARIO -c "cd $RUTA && git fetch origin main -q && git reset --hard origin/main -q"
  echo "  ya estaba, actualizado"
else
  # Se clona a una carpeta temporal y se copia el contenido, no directamente
  # sobre $RUTA: git se niega a clonar sobre un directorio que ya existe.
  #
  # La temporal va en el HOME del usuario y no junto a $RUTA. /opt es de root
  # y despliegue no puede crear nada ahí; sólo se le dio $RUTA. En su casa sí.
  su - $USUARIO -c "
    rm -rf ~/.clon-tmp
    git clone -q '$REPO' ~/.clon-tmp
    cp -a ~/.clon-tmp/. '$RUTA/'
    rm -rf ~/.clon-tmp
  "
fi
# Cinturón y tirantes: el bit va puesto en el índice de git, pero si alguna vez
# se pierde al pasar por Windows, aquí no se nota hasta el "permission denied".
chmod +x "$RUTA"/infra/*.sh "$RUTA/desplegar.sh" 2>/dev/null || true

echo "▶ Archivo .env…"
# Se generan aquí y no a mano. Estas cadenas son las que sostienen toda la
# seguridad del sistema, y teclearlas en una consola web es exactamente como
# se terminan usando contraseñas de ocho letras. Sólo se usan caracteres
# alfanuméricos: el valor viaja por sed, por env_file de Docker y por la URL
# de conexión de Postgres, y en cualquiera de los tres un signo de puntuación
# mal colocado rompe algo lejos de aquí y difícil de rastrear.
if [ ! -f "$RUTA/.env" ]; then
  CLAVE_BD="$(openssl rand -hex 24)"
  SECRETO_JWT="$(openssl rand -hex 48)"
  TOKEN_VERIFY="$(openssl rand -hex 24)"
  CLAVE_ADMIN="$(openssl rand -hex 8)"
  IP_PUBLICA="$(curl -fsS -m 5 https://ifconfig.me || echo IP_DEL_DROPLET)"

  cp "$RUTA/.env.example" "$RUTA/.env"
  sed -i \
    -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$CLAVE_BD|" \
    -e "s|^DATABASE_URL=.*|DATABASE_URL=postgres://monitoreo:$CLAVE_BD@db:5432/monitoreo|" \
    -e "s|^JWT_SECRETO=.*|JWT_SECRETO=$SECRETO_JWT|" \
    -e "s|^WA_VERIFY_TOKEN=.*|WA_VERIFY_TOKEN=$TOKEN_VERIFY|" \
    -e "s|^ADMIN_CLAVE=.*|ADMIN_CLAVE=$CLAVE_ADMIN|" \
    -e "s|^URL_PUBLICA=.*|URL_PUBLICA=https://$DOMINIO|" \
    -e "s|^DESPLIEGUE_HOST=.*|DESPLIEGUE_HOST=$USUARIO@$IP_PUBLICA|" \
    "$RUTA/.env"
  chown $USUARIO:$USUARIO "$RUTA/.env"
  chmod 600 "$RUTA/.env"
  echo "  generado con secretos aleatorios"
else
  echo "  ya existía, no se toca"
fi

echo "▶ Certificado provisional autofirmado…"
# Nginx no arranca sin certificado. Se pone uno autofirmado para que el primer
# despliegue funcione; certbot lo reemplaza en cuanto el DNS apunte al droplet.
mkdir -p "$RUTA/infra/certs" "$RUTA/infra/certbot"
if [ ! -f "$RUTA/infra/certs/fullchain.pem" ]; then
  openssl req -x509 -nodes -newkey rsa:2048 -days 365 \
    -keyout "$RUTA/infra/certs/privkey.pem" \
    -out    "$RUTA/infra/certs/fullchain.pem" \
    -subj "/CN=$DOMINIO" 2>/dev/null
fi
chown -R $USUARIO:$USUARIO "$RUTA/infra"

echo "▶ Renovación automática del certificado…"
cat > /usr/local/bin/renovar-certificado <<EOF
#!/usr/bin/env bash
set -e
docker run --rm \\
  -v $RUTA/infra/certbot:/var/www/certbot \\
  -v /etc/letsencrypt:/etc/letsencrypt \\
  certbot/certbot certonly --webroot -w /var/www/certbot \\
  -d $DOMINIO --email ${CORREO:-admin@$DOMINIO} --agree-tos --no-eff-email -n
cp -L /etc/letsencrypt/live/$DOMINIO/fullchain.pem $RUTA/infra/certs/fullchain.pem
cp -L /etc/letsencrypt/live/$DOMINIO/privkey.pem   $RUTA/infra/certs/privkey.pem
cd $RUTA && docker compose exec -T web nginx -s reload || true
EOF
chmod +x /usr/local/bin/renovar-certificado
# El || true no es adorno. En un droplet recién hecho todavía no hay crontab,
# así que 'crontab -l' falla, el grep se queda sin entrada y sale con 1, y como
# el subshell hereda el set -e se muere ANTES del echo. Con pipefail eso tumba
# el script entero sin imprimir nada —el error iba a /dev/null—. Se veía como
# que el provisionamiento terminaba bien a media faena.
{ crontab -l 2>/dev/null | grep -v renovar-certificado || true
  echo "17 3 * * 1 /usr/local/bin/renovar-certificado >> /var/log/certbot.log 2>&1"; } | crontab -

echo "▶ Respaldo diario de la base…"
cat > /usr/local/bin/respaldar-monitoreo <<EOF
#!/usr/bin/env bash
set -e
cd $RUTA
mkdir -p respaldos
ARCHIVO="respaldos/monitoreo-\$(date +%Y%m%d).sql.gz"
docker compose exec -T db pg_dump -U "\${POSTGRES_USER:-monitoreo}" "\${POSTGRES_DB:-monitoreo}" | gzip > "\$ARCHIVO"
# Se conservan 14 días: suficiente para el ciclo de facturación mensual.
find respaldos -name 'monitoreo-*.sql.gz' -mtime +14 -delete
EOF
chmod +x /usr/local/bin/respaldar-monitoreo
# Mismo caso que arriba: sin el || true esto tumba el script en un droplet nuevo.
{ crontab -l 2>/dev/null | grep -v respaldar-monitoreo || true
  echo "23 2 * * * /usr/local/bin/respaldar-monitoreo >> /var/log/respaldo-monitoreo.log 2>&1"; } | crontab -

cat <<FIN

════════════════════════════════════════════════════════════════════
  Droplet listo. Repositorio en $RUTA y .env generado.

  Sigue, como $USUARIO (su - $USUARIO):

   1. Captura las credenciales de Meta. Sin editor, una por una:
        cd $RUTA
        ./infra/env.sh WA_ID_NUMERO   <id del número>
        ./infra/env.sh WA_TOKEN       <token permanente>
        ./infra/env.sh WA_APP_SECRET  <app secret>
        ./infra/env.sh WA_ID_CUENTA   <id de la cuenta WABA>

   2. Levanta todo:
        ./infra/arrancar.sh

   3. Con el DNS de $DOMINIO ya apuntando a este droplet,
      cambia el certificado autofirmado por uno de verdad. Esto va como
      root: sal de $USUARIO con 'exit' antes de correrlo.
        /usr/local/bin/renovar-certificado

   4. En Meta, webhook:
        URL    https://$DOMINIO/webhook
        Token  el valor de WA_VERIFY_TOKEN en el .env
               (verlo:  grep WA_VERIFY_TOKEN $RUTA/.env)

  El portal NO está en la raíz: cuelga de /monitoreo, para dejar libre la
  raíz del dominio. La raíz redirige allá mientras no haya otra cosa.

        https://$DOMINIO/monitoreo

  Los datos de acceso al portal están en el .env:
        grep -E 'ADMIN_CORREO|ADMIN_CLAVE' $RUTA/.env

  De aquí en adelante, desde tu máquina basta con ./desplegar.sh
════════════════════════════════════════════════════════════════════
FIN
