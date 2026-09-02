import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { createRouter, createWebHashHistory } from 'vue-router';

import App from './App.vue';
import { hayToken } from './api.js';
import { cargarSesion } from './sesion.js';
import './estilos.css';

// 'roles' es la lista de quién puede abrir la pantalla. Las que no lo traen
// las ve cualquiera con sesión —son de mirar—; escribir dentro de ellas ya lo
// filtra cada vista con puedeEditar.
const rutas = [
  { path: '/login', component: () => import('./vistas/Login.vue'), meta: { publica: true } },
  { path: '/', component: () => import('./vistas/Tablero.vue') },
  { path: '/por-resolver', component: () => import('./vistas/PorResolver.vue') },
  { path: '/conductores', component: () => import('./vistas/Conductores.vue') },
  { path: '/unidades', component: () => import('./vistas/Unidades.vue') },
  { path: '/carga', component: () => import('./vistas/Carga.vue'), meta: { roles: ['admin', 'operador'] } },
  { path: '/cobro', component: () => import('./vistas/Cobro.vue'), meta: { roles: ['admin'] } },
  { path: '/usuarios', component: () => import('./vistas/Usuarios.vue'), meta: { roles: ['admin'] } },
  // No va en el menú: se llega desde el bloque del usuario, abajo del lateral.
  { path: '/cuenta', component: () => import('./vistas/Cuenta.vue') },
  { path: '/:resto(.*)', redirect: '/' },
];

const router = createRouter({ history: createWebHashHistory(), routes: rutas });

router.beforeEach(async (a) => {
  if (a.meta.publica) return true;
  if (!hayToken()) return '/login';
  if (!a.meta.roles) return true;

  const u = await cargarSesion();
  // Sin respuesta no se adivina: pasa, y que el API conteste lo que tenga que
  // contestar. Cerrarle el paso por un tropiezo de red sería peor.
  if (u && !a.meta.roles.includes(u.rol)) return '/';
  return true;
});

createApp(App).use(createPinia()).use(router).mount('#app');
