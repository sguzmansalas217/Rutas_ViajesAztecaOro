<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { api } from '../api.js';

const hoy = new Date().toISOString().slice(0, 10);
const fecha = ref(hoy);
const turno = ref('');
const resumen = ref(null);
const asignaciones = ref([]);
const error = ref('');
let temporizador = null;

const TURNOS = ['MANANA', 'TARDE', 'NOCHE', 'ENTRADA_TA', 'ENTRADA_TB'];

// Un filtro por cada marcaje: el índice es el número de marcaje menos uno.
// Van separados a propósito. "Quién no contestó el despertador" y "quién no
// avisó que salió" son dos preguntas distintas y se atienden distinto.
const filtros = ref(['', '', '', '']);

// Por omisión lo rojo va arriba. Es lo único del tablero sobre lo que hay que
// hacer algo; el resto es lectura. El orden por hora queda a un clic para
// cuando se quiere seguir el día como viene en el Excel.
const orden = ref('rojo');

const SEMAFOROS = [
  { v: 'rojo', t: 'Rojo' },
  { v: 'amarillo', t: 'Amarillo' },
  { v: 'verde', t: 'Verde' },
  { v: 'pendiente', t: 'Pendiente' },
  { v: 'ninguno', t: 'Sin marcaje' },
];

// El símbolo va además del color: quien no distingue rojo de verde tiene que
// poder leer el tablero igual.
const SIMBOLO = { rojo: '✕', amarillo: '!', verde: '✓', pendiente: '·', ninguno: '' };

function marcaje(a, n) {
  return (a.marcajes || []).find((m) => m.numero === n) ?? null;
}
function color(a, n) {
  return marcaje(a, n)?.semaforo ?? 'ninguno';
}
function colores(a) {
  return [1, 2, 3, 4].map((n) => color(a, n));
}

function titulo(a, n) {
  const m = marcaje(a, n);
  if (!m) return `Marcaje ${n}: no programado`;
  const p = `programado ${hora(m.programado)}`;
  return m.respondido
    ? `Marcaje ${n}: contestó ${hora(m.respondido)} · ${p}`
    : `Marcaje ${n}: sin respuesta · ${p}`;
}

// Rojo primero, después amarillo, después el resto. El servidor ya entrega la
// lista por hora y ruta, y sort es estable, así que dentro de cada grupo el
// orden del día se conserva solo: no hace falta volver a comparar la hora.
function rango(a) {
  const c = colores(a);
  if (c.includes('rojo')) return 0;
  if (c.includes('amarillo')) return 1;
  return 2;
}

const visibles = computed(() => {
  const lista = asignaciones.value.filter(
    (a) => filtros.value.every((f, i) => !f || color(a, i + 1) === f),
  );
  return orden.value === 'rojo' ? [...lista].sort((x, y) => rango(x) - rango(y)) : lista;
});

const hayFiltro = computed(() => filtros.value.some(Boolean));
function limpiarFiltros() {
  filtros.value = ['', '', '', ''];
}

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
    <select v-model="orden">
      <option value="rojo">Rojos arriba</option>
      <option value="hora">Por hora</option>
    </select>
    <button class="tenue" @click="cargar">Actualizar</button>
    <button v-if="hayFiltro" class="tenue" @click="limpiarFiltros">
      Quitar filtros · {{ visibles.length }} de {{ asignaciones.length }}
    </button>
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
        <th v-for="n in 4" :key="n" class="col-faro">
          <div class="cab-faro">
            <span>{{ n }}</span>
            <select
              v-model="filtros[n - 1]"
              :class="{ activo: filtros[n - 1] }"
              :title="`Ver sólo un color en el marcaje ${n}`"
            >
              <option value="">Todos</option>
              <option v-for="s in SEMAFOROS" :key="s.v" :value="s.v">{{ s.t }}</option>
            </select>
          </div>
        </th>
        <th>Encargado</th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="a in visibles" :key="a.id" :class="{ 'tiene-rojo': colores(a).includes('rojo') }">
        <td>{{ String(a.hora_monitoreo).slice(0, 5) }}</td>
        <td>{{ a.ruta }}</td>
        <td class="tenue-txt">{{ a.turno.replace('_', ' ') }}</td>
        <td><strong>{{ a.unidad ?? '—' }}</strong></td>
        <td>
          {{ a.conductor ?? a.texto_origen }}
          <span v-if="!a.telefono_e164" class="chip rojo">sin tel.</span>
        </td>
        <td v-for="n in 4" :key="n" class="col-faro">
          <span class="faro" :class="color(a, n)" :title="titulo(a, n)">{{ SIMBOLO[color(a, n)] }}</span>
        </td>
        <td class="tenue-txt">{{ a.encargado ?? '—' }}</td>
      </tr>
      <tr v-if="!visibles.length">
        <td colspan="10" class="tenue-txt">
          <template v-if="hayFiltro">Ningún marcaje coincide con el filtro.</template>
          <template v-else>Sin asignaciones para esta fecha. Carga el Excel de la semana.</template>
        </td>
      </tr>
    </tbody>
  </table>
</template>
