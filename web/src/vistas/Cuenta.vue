<script setup>
import { ref, computed, onMounted } from 'vue';
import { api } from '../api.js';

const usuario = ref(null);
const actual = ref('');
const nueva = ref('');
const repetida = ref('');
const error = ref('');
const listo = ref('');
const guardando = ref(false);

const MINIMO = 10;   // el mismo que exige el API en /auth/clave

// Se valida en la pantalla además de en el API. No es por seguridad —eso lo
// hace el servidor— sino para no gastar un viaje de ida y vuelta en decirle a
// alguien que las dos contraseñas no coinciden.
const problema = computed(() => {
  if (!actual.value || !nueva.value || !repetida.value) return 'Faltan datos';
  if (nueva.value.length < MINIMO) return `La nueva debe tener al menos ${MINIMO} caracteres`;
  if (nueva.value !== repetida.value) return 'Las dos contraseñas nuevas no coinciden';
  if (nueva.value === actual.value) return 'La nueva es igual a la actual';
  return '';
});

onMounted(async () => {
  try { usuario.value = (await api.get('/auth/yo')).usuario; } catch (e) { error.value = e.message; }
});

async function cambiar() {
  error.value = ''; listo.value = '';
  if (problema.value) { error.value = problema.value; return; }
  guardando.value = true;
  try {
    await api.post('/auth/clave', { actual: actual.value, nueva: nueva.value });
    actual.value = nueva.value = repetida.value = '';
    listo.value = 'Contraseña cambiada. Se usa la nueva la próxima vez que entres.';
  } catch (e) {
    error.value = e.message;
  } finally {
    guardando.value = false;
  }
}
</script>

<template>
  <div>
    <h2>Mi cuenta</h2>
    <p class="sub">Datos de tu usuario y cambio de contraseña.</p>

    <div class="cuenta">
      <section class="caja">
        <h3>Usuario</h3>
        <dl>
          <dt>Nombre</dt><dd>{{ usuario?.nombre ?? '—' }}</dd>
          <dt>Correo</dt><dd>{{ usuario?.correo ?? '—' }}</dd>
          <dt>Rol</dt><dd class="rol">{{ usuario?.rol ?? '—' }}</dd>
        </dl>
        <p class="tenue-txt">
          El correo y el rol los cambia un administrador; no se editan desde aquí.
        </p>
      </section>

      <section class="caja">
        <h3>Cambiar contraseña</h3>
        <form @submit.prevent="cambiar">
          <div v-if="error" class="error">{{ error }}</div>
          <div v-if="listo" class="ok">{{ listo }}</div>

          <label for="a">Contraseña actual</label>
          <input id="a" v-model="actual" type="password" autocomplete="current-password" required />

          <label for="n">Nueva contraseña</label>
          <input id="n" v-model="nueva" type="password" autocomplete="new-password" required />
          <p class="tenue-txt">Mínimo {{ MINIMO }} caracteres.</p>

          <label for="r">Repite la nueva</label>
          <input id="r" v-model="repetida" type="password" autocomplete="new-password" required />

          <button :disabled="guardando || Boolean(problema)">
            {{ guardando ? 'Guardando…' : 'Cambiar contraseña' }}
          </button>
        </form>
      </section>
    </div>
  </div>
</template>
