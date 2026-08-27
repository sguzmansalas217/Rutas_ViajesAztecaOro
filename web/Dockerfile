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
COPY --from=compilacion /web/dist /usr/share/nginx/html
EXPOSE 80 443
