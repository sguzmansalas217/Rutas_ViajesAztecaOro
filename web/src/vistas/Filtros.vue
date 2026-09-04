<script setup>
// Los puntos de filtro contra los que se valida la ubicación del marcaje 3.
//
// Sin ninguno dado de alta el sistema recibe la ubicación, la guarda y no la
// compara contra nada: el marcaje sale verde por haber contestado a tiempo,
// esté el conductor en el filtro o en su casa. Es la mitad del marcaje 3 que
// faltaba, y no se notaba porque desde fuera se ve igual.
import { ref, computed, onMounted } from 'vue';
import { api } from '../api.js';
import { puedeEditar } from '../sesion.js';

const cercas = ref([]);
const recibidas = ref([]);
const error = ref('');
const aviso = ref('');
const guardando = ref(false);
const alternando = ref(0);

const nombre = ref('');
const punto = ref('');
const radio = ref(300);

// Se acepta pegado tal cual de Google Maps: '22.7709, -102.5832'. Teclear dos
// campos separados invita a cambiarlos de lugar, y una latitud en el campo de
// longitud da un punto en otro continente sin que nada se queje.
const coords = computed(() => {
  const m = String(punto.value).trim().match(/^(-?\d{1,3}(?:\.\d+)?)\s*[, ]\s*(-?\d{1,3}(?:\.\d+)?)$/);
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
});

const valido = computed(() => nombre.value.trim().length >= 2 && coords.value !== null
  && radio.value >= 50 && radio.value <= 5000);

const activas = computed(() => cercas.value.filter((g) => g.activo).length);

async function cargar() {
  error.value = '';
  try {
    const [g, r] = await Promise.all([
      api.get('/catalogos/geocercas'),
      api.get('/catalogos/geocercas/recibidas'),
    ]);
    cercas.value = g;
    recibidas.value = r;
  } catch (e) {
    error.value = e.message;
  }
}

async function guardar() {
  error.value = ''; aviso.value = ''; guardando.value = true;
  try {
    const g = await api.post('/catalogos/geocercas', {
      nombre: nombre.value.trim().toUpperCase(),
      latitud: coords.value.lat,
      longitud: coords.value.lon,
      radioM: Number(radio.value),
    });
    aviso.value = `Guardado «${g.nombre}» con ${g.radio_m} m de radio.`;
    nombre.value = ''; punto.value = '';
    await cargar();
  } catch (e) {
    error.value = e.message;
  } finally {
    guardando.value = false;
  }
}

async function alternar(g) {
  error.value = ''; aviso.value = ''; alternando.value = g.id;
  try {
    await api.put(`/catalogos/geocercas/${g.id}`, { activo: !g.activo });
    await cargar();
  } catch (e) {
    error.value = e.message;
  } finally {
    alternando.value = 0;
  }
}

// Convierte una ubicación que ya mandó un conductor en el formulario de arriba.
// Es la forma buena de dar de alta un filtro: el punto salió del lugar, no de
// un mapa. El nombre se propone con la parada inicial de la ruta.
function usar(u) {
  punto.value = `${u.latitud}, ${u.longitud}`;
  if (!nombre.value.trim()) nombre.value = (u.parada_inicial || u.ruta || '').toUpperCase().slice(0, 60);
  aviso.value = '';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

const hora = (t) => (t ? new Date(t).toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' }) : '—');

onMounted(cargar);
</script>

<template>
  <h2>Filtros</h2>
  <p class="sub">
    Los puntos donde el conductor tiene que estar cuando comparte su ubicación
    en el marcaje 3. Si cae dentro del radio el marcaje sale verde; si cae fuera,
    amarillo.
  </p>

  <div v-if="error" class="error">{{ error }}</div>
  <div v-if="aviso" class="ok">{{ aviso }}</div>

  <div v-if="cercas.length && !activas" class="aviso amarillo">
    Hay filtros dados de alta pero <strong>ninguno activo</strong>. La ubicación
    se guarda y no se compara contra nada.
  </div>
  <div v-else-if="!cercas.length" class="aviso">
    <strong>Todavía no hay ningún filtro.</strong>
    La ubicación del marcaje 3 se recibe y se guarda, pero no se valida: el
    marcaje sale verde por contestar a tiempo, esté donde esté el conductor.
  </div>

  <div v-if="puedeEditar" class="caja">
    <h3>Dar de alta un filtro</h3>

    <label for="nom">Nombre</label>
    <input id="nom" v-model="nombre" placeholder="FILTRO SAN LUIS" autocomplete="off" />
    <p class="tenue-txt">
      Si repites un nombre que ya existe, se actualizan sus coordenadas en vez
      de crear otro.
    </p>

    <label for="pto">Coordenadas</label>
    <input id="pto" v-model="punto" placeholder="22.7709, -102.5832" autocomplete="off" />
    <p class="tenue-txt" :class="{ mal: punto.trim() && !coords }">
      <template v-if="!punto.trim()">
        En Google Maps: clic derecho sobre el punto → la primera línea del menú
        son las coordenadas, se copian de un clic. Pégalas aquí tal cual.
      </template>
      <template v-else-if="coords">
        Latitud <strong>{{ coords.lat }}</strong>, longitud <strong>{{ coords.lon }}</strong>
      </template>
      <template v-else>
        No se entiende. Se esperan dos números separados por coma, así:
        22.7709, -102.5832
      </template>
    </p>

    <label for="rad">Radio en metros</label>
    <input id="rad" v-model.number="radio" type="number" min="50" max="5000" step="50" />
    <p class="tenue-txt">
      Entre 50 y 5000. Con 300 m se cubre el filtro y su estacionamiento.
      Apretarlo más no sirve: el GPS del celular no trae precisión en el mensaje
      y un teléfono en modo «ubicación aproximada» reporta con kilómetros de
      error sin que se pueda distinguir.
    </p>

    <button :disabled="guardando || !valido" @click="guardar">
      {{ guardando ? 'Guardando…' : 'Guardar filtro' }}
    </button>
  </div>

  <h3 style="margin-top:26px;font-size:15px">Filtros dados de alta</h3>
  <table>
    <thead>
      <tr>
        <th>Nombre</th><th>Coordenadas</th><th>Radio</th><th>Activo</th>
        <th>Marcajes validados</th><th v-if="puedeEditar"></th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="g in cercas" :key="g.id">
        <td><strong>{{ g.nombre }}</strong></td>
        <td class="tenue-txt">{{ g.latitud }}, {{ g.longitud }}</td>
        <td>{{ g.radio_m }} m</td>
        <td>
          <span v-if="g.activo" class="chip verde">Sí</span>
          <span v-else class="chip">No</span>
        </td>
        <!-- Un filtro que lleva semanas en cero está mal puesto: nadie pasa por
             ahí. Es lo único que delata unas coordenadas invertidas. -->
        <td>
          <template v-if="g.usos">{{ g.dentro }} de {{ g.usos }} dentro</template>
          <span v-else class="tenue-txt">todavía ninguno</span>
        </td>
        <td v-if="puedeEditar">
          <button class="tenue" :disabled="alternando === g.id" @click="alternar(g)">
            {{ g.activo ? 'Apagar' : 'Encender' }}
          </button>
        </td>
      </tr>
      <tr v-if="!cercas.length">
        <td :colspan="puedeEditar ? 6 : 5" class="tenue-txt">Ninguno todavía.</td>
      </tr>
    </tbody>
  </table>

  <h3 style="margin-top:26px;font-size:15px">Ubicaciones que ya mandaron los conductores</h3>
  <p class="sub">
    Estas salieron del lugar, no de un mapa. Es la forma buena de dar de alta un
    filtro: manda tú una ubicación parado en el punto, o toma la de un conductor
    que ya estuvo ahí.
  </p>
  <table>
    <thead>
      <tr>
        <th>Cuándo</th><th>Conductor</th><th>Ruta</th><th>Coordenadas</th>
        <th>Contra el filtro</th><th v-if="puedeEditar"></th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="u in recibidas" :key="u.id">
        <td class="tenue-txt">{{ hora(u.respondido_en) }}</td>
        <td>{{ u.conductor ?? '—' }}</td>
        <td class="tenue-txt">{{ u.ruta }}</td>
        <td class="tenue-txt">{{ u.latitud }}, {{ u.longitud }}</td>
        <td>
          <span v-if="u.dentro_geocerca === true" class="chip verde">dentro · {{ Math.round(u.distancia_m) }} m</span>
          <span v-else-if="u.dentro_geocerca === false" class="chip amarillo">fuera · {{ Math.round(u.distancia_m) }} m</span>
          <span v-else class="tenue-txt">sin filtro que comparar</span>
        </td>
        <td v-if="puedeEditar">
          <button class="tenue" @click="usar(u)">Usar este punto</button>
        </td>
      </tr>
      <tr v-if="!recibidas.length">
        <td :colspan="puedeEditar ? 6 : 5" class="tenue-txt">
          Ninguna todavía. En cuanto un conductor conteste el marcaje 3, aparece aquí.
        </td>
      </tr>
    </tbody>
  </table>
</template>
