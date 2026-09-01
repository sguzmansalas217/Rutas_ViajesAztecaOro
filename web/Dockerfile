# Compila el Vue y lo sirve Nginx. La imagen final no lleva Node ni el código
# fuente: sólo los estáticos.
#
# La configuración de Nginx NO se copia aquí: la monta docker-compose desde
# infra/nginx/, para poder ajustarla en el servidor sin reconstruir la imagen.
FROM node:22-alpine AS compilacion
WORKDIR /web
COPY package.json package-lock.json* ./
RUN npm ci || npm install
COPY . .
RUN npm run build

FROM nginx:1.27-alpine
# Los estáticos van a html/monitoreo/ y no a html/, para que coincidan con el
# 'base' de vite.config.js. Puestos así, el bloque location /monitoreo/ de
# Nginx funciona con un root normal y sin alias —alias con try_files es una
# fuente clásica de 404 que sólo se notan en producción—.
COPY --from=compilacion /web/dist /usr/share/nginx/html/monitoreo
EXPOSE 80 443
