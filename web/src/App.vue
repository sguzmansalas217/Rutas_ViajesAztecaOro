<script setup>
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api, fijarToken, hayToken } from './api.js';

const ruta = useRoute();
const router = useRouter();
const conSesion = computed(() => hayToken() && ruta.path !== '/login');

async function salir() {
  try { await api.post('/auth/salir'); } catch { /* da igual */ }
  fijarToken(null);
  router.push('/login');
}
</script>

<template>
  <div class="app">
    <nav v-if="conSesion" class="lateral">
      <h1>Monitoreo de Rutas</h1>
      <p class="marca">Nexori System</p>
      <router-link to="/">Tablero</router-link>
      <router-link to="/por-resolver">Por resolver</router-link>
      <router-link to="/conductores">Conductores</router-link>
      <router-link to="/unidades">Unidades</router-link>
      <router-link to="/carga">Cargar Excel</router-link>
      <router-link to="/cobro">Cobro</router-link>
      <div class="pie">
        <button class="tenue" style="width:100%" @click="salir">Salir</button>
      </div>
    </nav>
    <main :class="conSesion ? 'principal' : ''">
      <router-view />
    </main>
  </div>
</template>
