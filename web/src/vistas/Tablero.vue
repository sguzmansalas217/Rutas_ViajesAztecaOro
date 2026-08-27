<script setup>
import { ref, onMounted, onUnmounted } from 'vue';
import { api } from '../api.js';

const hoy = new Date().toISOString().slice(0, 10);
const fecha = ref(hoy);
const turno = ref('');
const resumen = ref(null);
const asignaciones = ref([]);
const error = ref('');
let temporizador = null;

const TURNOS = ['MANANA', 'TARDE', 'NOCHE', 'ENTRADA_TA', 'ENTRADA_TB'];

async function cargar() {
  try {
    error.value = '';
    resumen.value = await api.get(`/operacion/tablero?fecha=${fecha.value}`);
    asignaciones.value = await api.get(`/operacion/asignaciones?fecha=${fecha.value}&turno=${turno.value}`);
  } catch (e) {
    error.value = e.message;
  }
}

function hora(t) {
  return t ? new Date(t).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' }) : '—';
}

onMounted(() => {
  cargar();
  temporizador = setInterval(cargar, 60_000);
});
onUnmounted(() => clearInterval(temporizador));
</script>

<template>
  <h2>Tablero</h2>
  <p class="sub">Estado de los marcajes del día. Se actualiza solo cada minuto.</p>

  <div v-if="error" class="error">{{ error }}</div>

  <div class="barra">
    <input v-model="fecha" type="date" @change="cargar" />
    <select v-model="turno" @change="cargar">
      <option value="">Todos los turnos</option>
      <option v-for="t in TURNOS" :key="t" :value="t">{{ t.replace('_', ' ') }}</option>
    </select>
    <button class="tenue" @click="cargar">Actualizar</button>
  </div>

  <div v-if="resumen" class="tarjetas">
    <div class="tarjeta"><div class="n">{{ resumen.unidades }}</div><div class="r">Unidades</div></div>
    <div class="tarjeta"><div class="n">{{ resumen.programadas }}</div><div class="r">Programadas</div></div>
    <div class="tarjeta verde"><div class="n">{{ resumen.marcajes.verde }}</div><div class="r">Verde</div></div>
    <div class="tarjeta amarillo"><div class="n">{{ resumen.marcajes.amarillo }}</div><div class="r">Amarillo</div></div>
    <div class="tarjeta rojo"><div class="n">{{ resumen.marcajes.rojo }}</div><div class="r">Rojo</div></div>
    <div class="tarjeta rojo"><div class="n">{{ resumen.por_resolver }}</div><div class="r">Por resolver</div></div>
    <div class="tarjeta"><div class="n">{{ resumen.ventanasAbiertas }}</div><div class="r">Ventanas 24 h</div></div>
  </div>

  <table>
    <thead>
      <tr>
        <th>Hora</th><th>Ruta</th><th>Turno</th><th>Unidad</th><th>Conductor</th>
        <th>1</th><th>2</th><th>3</th><th>4</th><th>Encargado</th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="a in asignaciones" :key="a.id">
        <td>{{ String(a.hora_monitoreo).slice(0, 5) }}</td>
        <td>{{ a.ruta }}</td>
        <td class="tenue-txt">{{ a.turno.replace('_', ' ') }}</td>
        <td><strong>{{ a.unidad ?? '—' }}</strong></td>
        <td>
          {{ a.conductor ?? a.texto_origen }}
          <span v-if="!a.telefono_e164" class="chip rojo">sin tel.</span>
        </td>
        <td v-for="n in 4" :key="n">
          <span
            class="chip"
            :class="(a.marcajes || []).find(m => m.numero === n)?.semaforo ?? 'gris'"
            :title="hora((a.marcajes || []).find(m => m.numero === n)?.respondido)"
          >{{ ((a.marcajes || []).find(m => m.numero === n)?.semaforo ?? '·').charAt(0).toUpperCase() }}</span>
        </td>
        <td class="tenue-txt">{{ a.encargado ?? '—' }}</td>
      </tr>
      <tr v-if="!asignaciones.length">
        <td colspan="10" class="tenue-txt">Sin asignaciones para esta fecha. Carga el Excel de la semana.</td>
      </tr>
    </tbody>
  </table>
</template>
