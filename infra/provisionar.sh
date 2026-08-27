#!/usr/bin/env bash
# ============================================================================
#  PROVISIÓN DEL DROPLET — se corre UNA SOLA VEZ, dentro del servidor.
#
#  Ubuntu 24.04 limpio en DigitalOcean (2 GB para empezar).
#
#  Uso, como root en el droplet recién creado:
#     curl -fsSL https://raw.githubusercontent.com/<usuario>/monitoreo-rutas/main/infra/provisionar.sh | bash -s -- monitoreo.tudominio.com tu@correo.com
#
#  Deja el servidor listo para que ./desplegar.sh haga todo lo demás.
# ============================================================================
set -euo pipefail

DOMINIO="${1:-}"
CORREO="${2:-}"
RUTA="/opt/monitoreo-rutas"
USUARIO="despliegue"

[ -z "$DOMINIO" ] && { echo "Uso: provisionar.sh <dominio> <correo>"; exit 1; }

echo "▶ Actualizando el sistema…"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get upgrade -y -qq
apt-get install -y -qq ca-certificates curl git ufw fail2ban unattended-upgrades openssl

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

echo "▶ Carpeta de la aplicación…"
mkdir -p "$RUTA"
chown -R $USUARIO:$USUARIO "$RUTA"

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
(crontab -l 2>/dev/null | grep -v renovar-certificado; echo "17 3 * * 1 /usr/local/bin/renovar-certificado >> /var/log/certbot.log 2>&1") | crontab -

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
(crontab -l 2>/dev/null | grep -v respaldar-monitoreo; echo "23 2 * * * /usr/local/bin/respaldar-monitoreo >> /var/log/respaldo-monitoreo.log 2>&1") | crontab -

cat <<FIN

════════════════════════════════════════════════════════════════════
  Droplet listo.

  Falta:
   1. Apuntar el DNS de $DOMINIO a la IP de este droplet.
   2. Clonar el repo:
        su - $USUARIO
        git clone git@github.com:<usuario>/monitoreo-rutas.git $RUTA
   3. Crear el .env real en $RUTA/.env (usa .env.example de guía).
        openssl rand -hex 48   → JWT_SECRETO
        openssl rand -hex 24   → POSTGRES_PASSWORD
   4. Desde tu máquina:  ./desplegar.sh
   5. Ya con DNS arriba: /usr/local/bin/renovar-certificado
════════════════════════════════════════════════════════════════════
FIN
