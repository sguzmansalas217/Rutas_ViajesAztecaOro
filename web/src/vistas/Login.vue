<script setup>
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { api, fijarToken } from '../api.js';

const router = useRouter();
const correo = ref('');
const clave = ref('');
const error = ref('');
const cargando = ref(false);

async function entrar() {
  error.value = '';
  cargando.value = true;
  try {
    const r = await api.post('/auth/login', { correo: correo.value, clave: clave.value });
    fijarToken(r.token);
    router.push('/');
  } catch (e) {
    error.value = e.message;
  } finally {
    cargando.value = false;
  }
}
</script>

<template>
  <div class="login">
    <form @submit.prevent="entrar">
      <h1>Monitoreo de Rutas</h1>
      <p>Nexori System · Viajes Azteca Oro</p>
      <div v-if="error" class="error">{{ error }}</div>
      <input v-model="correo" type="email" placeholder="Correo" autocomplete="username" required />
      <input v-model="clave" type="password" placeholder="Contraseña" autocomplete="current-password" required />
      <button :disabled="cargando">{{ cargando ? 'Entrando…' : 'Entrar' }}</button>
    </form>
  </div>
</template>
