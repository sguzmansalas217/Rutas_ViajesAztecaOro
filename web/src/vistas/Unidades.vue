<script setup>
// Aquí se decide el alcance del contrato: qué unidades del Excel entran
// al servicio. Las que quedan fuera se ven, pero no reciben mensajes ni
// se facturan.
import { ref, onMounted, computed } from 'vue';
import { api } from '../api.js';
import { puedeEditar } from '../sesion.js';

const datos = ref(null);
const error = ref('');
const aviso = ref('');
const buscar = ref('');
const soloFuera = ref(false);
const guardando = ref(0);

const lista = computed(() => {
  const v = datos.value?.vehiculos ?? [];
  const q = buscar.value.trim().toUpperCase();
  return v.filter((x) => (!q || x.clave.toUpperCase().includes(q))
    && (!soloFuera.value || !x.contratado));
});

async function cargar() {
  error.value = '';
  try { datos.value = await api.get('/catalogos/contrato'); }
  catch (e) { error.value = e.message; }
}

async function alternar(v) {
  error.value = ''; aviso.value = ''; guardando.value = v.id;
  try {
    await api.post(`/catalogos/contrato/vehiculos/${v.id}`, { contratado: !v.contratado });
    await cargar();
  } catch (e) {
    // El tope lo impone la base: si ya están las 30, esto es lo que llega.
    error.value = e.message;
  } finally { guardando.value = 0; }
}

async function proponer() {
  error.value = ''; aviso.value = '';
  try {
    const r = await api.post('/catalogos/contrato/proponer', {});
    aviso.value = r.agregadas.length
      ? `Se dieron de alta ${r.agregadas.length} unidades: ${r.agregadas.map((a) => a.clave).join(', ')}. Revísalas.`
      : 'No quedan lugares libres en el contrato.';
    await cargar();
  } catch (e) { error.value = e.message; }
}

onMounted(cargar);
</script>

<template>
  <h2>Unidades del contrato</h2>
  <p class="sub">
    El contrato cubre <strong>{{ datos?.limite ?? '…' }}</strong> unidades.
    Sólo estas reciben mensajes de WhatsApp y sólo estas se facturan;
    las demás aparecen en el archivo pero el sistema no las toca.
  </p>

  <div v-if="error" class="error">{{ error }}</div>
  <div v-if="aviso" class="ok">{{ aviso }}</div>

  <div v-if="datos" class="tarjetas">
    <div class="tarjeta" :class="datos.libres === 0 ? 'verde' : 'amarillo'">
      <div class="n">{{ datos.contratadas }} / {{ datos.limite }}</div>
      <div class="r">Dadas de alta</div>
    </div>
    <div class="tarjeta"><div class="n">{{ datos.libres }}</div><div class="r">Lugares libres</div></div>
    <div class="tarjeta"><div class="n">{{ datos.fuera }}</div><div class="r">Fuera del contrato</div></div>
  </div>

  <div v-if="datos && datos.libres > 0" class="aviso amarillo">
    Quedan <strong>{{ datos.libres }}</strong> lugares sin asignar. Mientras estén vacíos
    esas unidades no se monitorean.
    <button v-if="puedeEditar" class="tenue" style="margin-left:8px" @click="proponer">
      Llenar con las que más trabajan
    </button>
  </div>

  <div class="barra">
    <input v-model="buscar" placeholder="Buscar unidad (21, V-40, C-03…)" />
    <label class="tenue-txt" style="display:flex;align-items:center;gap:6px">
      <input type="checkbox" v-model="soloFuera" /> Sólo las de fuera
    </label>
    <button class="tenue" @click="cargar">Actualizar</button>
  </div>

  <table>
    <thead>
      <tr>
        <th>Unidad</th><th>En el contrato</th><th>Asignaciones</th>
        <th>Rutas</th><th>Conductores</th><th>Último día</th><th v-if="puedeEditar"></th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="v in lista" :key="v.id">
        <td><strong>{{ v.clave }}</strong></td>
        <td>
          <span v-if="v.contratado" class="chip verde">Sí</span>
          <span v-else class="chip">No</span>
        </td>
        <td>{{ v.asignaciones }}</td>
        <td>
          {{ v.rutas }}
          <span v-if="v.rutas > 1 && v.contratado" class="chip verde">sin cargo extra</span>
        </td>
        <td>{{ v.conductores }}</td>
        <td class="tenue-txt">{{ v.ultimo_dia ?? '—' }}</td>
        <td v-if="puedeEditar">
          <button class="tenue" :disabled="guardando === v.id" @click="alternar(v)">
            {{ v.contratado ? 'Quitar' : 'Agregar' }}
          </button>
        </td>
      </tr>
      <tr v-if="!lista.length"><td :colspan="puedeEditar ? 7 : 6" class="tenue-txt">Sin resultados.</td></tr>
    </tbody>
  </table>
</template>
