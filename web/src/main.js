import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { createRouter, createWebHashHistory } from 'vue-router';

import App from './App.vue';
import { hayToken } from './api.js';
import './estilos.css';

const rutas = [
  { path: '/login', component: () => import('./vistas/Login.vue'), meta: { publica: true } },
  { path: '/', component: () => import('./vistas/Tablero.vue') },
  { path: '/por-resolver', component: () => import('./vistas/PorResolver.vue') },
  { path: '/conductores', component: () => import('./vistas/Conductores.vue') },
  { path: '/unidades', component: () => import('./vistas/Unidades.vue') },
  { path: '/carga', component: () => import('./vistas/Carga.vue') },
  { path: '/cobro', component: () => import('./vistas/Cobro.vue') },
  // No va en el menú: se llega desde el bloque del usuario, abajo del lateral.
  { path: '/cuenta', component: () => import('./vistas/Cuenta.vue') },
  { path: '/:resto(.*)', redirect: '/' },
];

const router = createRouter({ history: createWebHashHistory(), routes: rutas });

router.beforeEach((a) => {
  if (!a.meta.publica && !hayToken()) return '/login';
  return true;
});

createApp(App).use(createPinia()).use(router).mount('#app');
