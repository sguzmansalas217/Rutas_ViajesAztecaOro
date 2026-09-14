<script setup>
// Qué pasó hoy, en orden, con las ubicaciones a la mano.
//
// No repite el Tablero. Aquél está de cara a la ruta —una fila por ruta, los
// cuatro cuadritos— y contesta "¿cómo va". Éste está de cara al tiempo y
// contesta "¿qué pasó": la pregunta que llega tres días después, cuando el
// cliente reclama y hay que reconstruir la mañana renglón por renglón.
//
// Un evento por renglón y nada más. Cualquier cosa que crezca hacia abajo
// —tarjetas, bloques, detalles desplegados— hace que quepan seis eventos en la
// pantalla, y un día son doscientos.
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { api } from '../api.js';
import { hoyLocal } from '../fechas.js';

const fecha = ref(hoyLocal());
const filtro = ref('');
const eventos = ref([]);
const error = ref('');
let temporizador = null;

const MARCAJES = {
  1: { icono: '☀️', nombre: 'Despertar' },
  2: { icono: '🔧', nombre: 'Revisión' },
  3: { icono: '📍', nombre: 'Filtro' },
  4: { icono: '🛣️', nombre: 'Salida' },
};

const SIMBOLO = { rojo: '✕', amarillo: '!', verde: '✓', pendiente: '·' };

// El teléfono separa "contestó tarde" de "hubo que hablarle", igual que en el
// Tablero. Son el mismo amarillo y dos historias distintas.
const simbolo = (e) => (e.fuente === 'manual' ? '☎' : SIMBOLO[e.semaforo] ?? '·');

function hora(t) {
  return t ? new Date(t).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' }) : '—';
}

// La hora del renglón es la del hecho: cuándo contestó, o —si no contestó— a
// qué hora se le preguntó. Ordenar por la programada mentiría: el renglón
// aparecería donde debió pasar, no donde pasó.
const cuando = (e) => e.respondido_en ?? e.enviado_en;

function quePaso(e) {
  if (e.fuente === 'manual') return e.nota || 'registrado a mano, sin nota';
  if (e.respondido_en) {
    if (e.numero === 3 && e.latitud == null) return 'contestó, pero no mandó la ubicación';
    if (e.numero === 4 && e.latitud == null) return 'salió, pero falta la ubicación de salida';
    if (e.dentro_geocerca === true) return `en el filtro${e.geocerca ? ` ${e.geocerca}` : ''}`;
    if (e.dentro_geocerca === false) {
      return `fuera del filtro${e.geocerca ? ` ${e.geocerca}` : ''}, a ${metros(e.distancia_m)}`;
    }
    return e.respuesta || 'contestó';
  }
  if (e.semaforo === 'rojo') return 'no contestó';
  return 'esperando respuesta';
}

function metros(m) {
  const n = Number(m);
  if (!Number.isFinite(n)) return '—';
  return n >= 1000 ? `${(n / 1000).toFixed(1)} km` : `${Math.round(n)} m`;
}

// Se abre en Google Maps en otra pestaña. No se dibuja un mapa aquí: pediría un
// proveedor de mosaicos, o sea una llamada a internet desde una pantalla que
// hoy funciona sin salir del servidor.
const mapa = (e) => `https://www.google.com/maps?q=${e.latitud},${e.longitud}`;

const visibles = computed(() => {
  if (filtro.value === 'problemas') return eventos.value.filter((e) => e.semaforo !== 'verde');
  if (filtro.value === 'ubicacion') return eventos.value.filter((e) => e.latitud != null);
  if (filtro.value === 'manual') return eventos.value.filter((e) => e.fuente === 'manual');
  return eventos.value;
});

const cuenta = computed(() => ({
  total: eventos.value.length,
  problemas: eventos.value.filter((e) => e.semaforo === 'rojo').length,
  llamadas: eventos.value.filter((e) => e.fuente === 'manual').length,
  ubicaciones: eventos.value.filter((e) => e.latitud != null).length,
}));

async function cargar() {
  try {
    error.value = '';
    eventos.value = await api.get(`/operacion/historial?fecha=${fecha.value}`);
  } catch (e) {
    error.value = e.message;
  }
}

onMounted(() => {
  cargar();
  temporizador = setInterval(cargar, 60_000);
});
onUnmounted(() => clearInterval(temporizador));
</script>

<template>
  <h2>Historial</h2>
  <p class="sub">
    Todo lo que pasó en el día, del más reciente al más viejo: qué se preguntó, qué
    contestó cada conductor y desde dónde. Se actualiza solo cada minuto.
  </p>

  <div v-if="error" class="error">{{ error }}</div>

  <div class="barra">
    <input v-model="fecha" type="date" @change="cargar" />
    <select v-model="filtro">
      <option value="">Todo · {{ cuenta.total }}</option>
      <option value="problemas">Sin contestar o con retraso</option>
      <option value="ubicacion">Con ubicación · {{ cuenta.ubicaciones }}</option>
      <option value="manual">Resueltos por teléfono · {{ cuenta.llamadas }}</option>
    </select>
    <button class="tenue" @click="cargar">Actualizar</button>
    <span v-if="cuenta.problemas" class="chip rojo">{{ cuenta.problemas }} sin respuesta</span>
  </div>

  <table class="bitacora">
    <thead>
      <tr>
        <th class="col-hora">Hora</th>
        <th class="col-faro"></th>
        <th>Marcaje</th>
        <th>Ruta</th>
        <th>Unidad</th>
        <th>Conductor</th>
        <th>Qué pasó</th>
        <th>Ubicación</th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="e in visibles" :key="e.id">
        <td class="col-hora">{{ hora(cuando(e)) }}</td>
        <td class="col-faro"><span class="faro" :class="e.semaforo">{{ simbolo(e) }}</span></td>
        <td class="nowrap"><i class="ic">{{ MARCAJES[e.numero]?.icono }}</i>{{ MARCAJES[e.numero]?.nombre }}</td>
        <td>{{ e.ruta }}</td>
        <td><strong>{{ e.unidad ?? '—' }}</strong></td>
        <td>{{ e.conductor ?? '—' }}</td>
        <td class="paso">{{ quePaso(e) }}</td>
        <td>
          <a
            v-if="e.latitud != null"
            class="punto-mapa"
            :href="mapa(e)"
            target="_blank"
            rel="noopener"
            :title="`${e.latitud}, ${e.longitud} — se abre en Google Maps`"
          >📍 Ver</a>
          <span v-else class="tenue-txt">—</span>
        </td>
      </tr>
      <tr v-if="!visibles.length">
        <td colspan="8" class="tenue-txt">
          <template v-if="eventos.length">Nada coincide con el filtro.</template>
          <template v-else>Todavía no pasa nada en esta fecha.</template>
        </td>
      </tr>
    </tbody>
  </table>
</template>
