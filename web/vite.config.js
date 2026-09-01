import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// El sistema no vive en la raíz del dominio sino en viajesaztecadeoro.com/monitoreo,
// para dejar la raíz libre para la página de la agencia.
//
// Este valor es el que manda: Vite lo expone como import.meta.env.BASE_URL y de
// ahí lo toma api.js para armar las llamadas. Si algún día se cambia por un
// subdominio, aquí se pone '/' y lo único que hay que tocar aparte son los
// bloques location de infra/nginx/default.conf y el COPY del web/Dockerfile
// —los tres llevan comentario cruzado apuntándose entre sí—.
const BASE = '/monitoreo/';

export default defineConfig({
  base: BASE,
  plugins: [vue()],
  server: {
    port: 5173,
    // En desarrollo el API vive en el contenedor 'api'; en local, en 3000.
    // El navegador pide /monitoreo/api/... y el API sigue escuchando en /api,
    // así que aquí se quita el prefijo antes de reenviar. En producción hace
    // lo mismo Nginx con el proxy_pass.
    proxy: {
      [`${BASE}api`]: {
        target: process.env.API_URL ?? 'http://localhost:3000',
        changeOrigin: true,
        rewrite: (ruta) => ruta.replace(BASE, '/'),
      },
    },
  },
  build: { outDir: 'dist', sourcemap: false },
});
