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

// El plan: cuántas unidades cubre el contrato y cuánto se paga al mes por
// ellas. El total viene hecho del API —la fórmula que lo produce es del
// proveedor— y aquí sólo se pinta.
const plan = ref(null);
const mxn = (n) => Number(n ?? 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });

// El super administrador es el único que mueve el número de unidades: es lo
// que se acordó con el cliente y mueve el importe de la factura.
const esProveedor = computed(() => usuario.value?.proveedor === true);
const unidades = ref('');
const guardandoPlan = ref(false);
const errorPlan = ref('');
const listoPlan = ref('');

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
  await cargarPlan();
});

async function cargarPlan() {
  try {
    plan.value = await api.get('/cobro/mi-plan');
    unidades.value = String(plan.value.unidadesContratadas);
  } catch { plan.value = null; }
}

async function guardarUnidades() {
  errorPlan.value = ''; listoPlan.value = '';
  const n = Number(unidades.value);
  if (!Number.isInteger(n) || n < 1) { errorPlan.value = 'Escribe un número entero de unidades'; return; }
  guardandoPlan.value = true;
  try {
    await api.put('/catalogos/parametros/limite.vehiculos', { valor: String(n) });
    await cargarPlan();
    listoPlan.value = 'Listo. El contrato ahora cubre ' + n + ' unidades.';
  } catch (e) {
    errorPlan.value = e.message;
  } finally {
    guardandoPlan.value = false;
  }
}

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
    <p class="sub">Tu plan, los datos de tu usuario y el cambio de contraseña.</p>

    <div class="cuenta">
      <section v-if="plan" class="caja">
        <h3>Tu plan</h3>
        <dl>
          <dt>Unidades contratadas</dt><dd>{{ plan.unidadesContratadas }}</dd>
          <dt>Pago mensual</dt><dd class="importe">{{ mxn(plan.total) }}</dd>
        </dl>
        <p class="tenue-txt">Importe mensual con IVA incluido, por las unidades del contrato.</p>

        <!-- Sólo el super administrador. El API vuelve a revisarlo: esto no es
             la barrera, nada más evita enseñar un campo que daría 403. -->
        <form v-if="esProveedor" class="setear" @submit.prevent="guardarUnidades">
          <div v-if="errorPlan" class="error">{{ errorPlan }}</div>
          <div v-if="listoPlan" class="ok">{{ listoPlan }}</div>
          <label for="u">Unidades contratadas</label>
          <input id="u" v-model="unidades" type="number" min="1" step="1" />
          <button :disabled="guardandoPlan">{{ guardandoPlan ? 'Guardando…' : 'Guardar' }}</button>
        </form>
      </section>

      <section class="caja">
        <h3>Usuario</h3>
        <dl>
          <dt>Nombre</dt><dd>{{ usuario?.nombre ?? '—' }}</dd>
          <dt>Correo</dt><dd>{{ usuario?.correo ?? '—' }}</dd>
          <dt>Rol</dt>
          <dd class="rol">{{ esProveedor ? 'Super administrador' : (usuario?.rol ?? '—') }}</dd>
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
