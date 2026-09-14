<script setup>
// Qué pasó hoy, ruta por ruta, con las ubicaciones a la mano.
//
// No repite el Tablero aunque las dos listen rutas. El Tablero es de hoy y en
// vivo: existe para levantar el teléfono ahora. Éste es de cualquier fecha y
// para reconstruir: la pregunta que llega tres días después, cuando el cliente
// reclama un retraso y hay que enseñarle la hora y el punto desde donde
// contestó el conductor.
//
// Un renglón por ruta, y el detalle sólo cuando se pide. Con treinta unidades
// el día son ciento veinte eventos: en lista corrida no cabe ni una cuarta
// parte en pantalla, y lo que se busca —en qué ruta se atoró— queda enterrado
// entre los renglones de las que salieron bien.
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { api } from '../api.js';
import { hoyLocal } from '../fechas.js';

const fecha = ref(hoyLocal());
const filtro = ref('');
const eventos = ref([]);
const abiertas = ref(new Set());
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
const enMapa = (e) => `https://www.google.com/maps?q=${e.latitud},${e.longitud}`;

const pasaFiltro = (e) => {
  if (filtro.value === 'problemas') return e.semaforo !== 'verde';
  if (filtro.value === 'ubicacion') return e.latitud != null;
  if (filtro.value === 'manual') return e.fuente === 'manual';
  return true;
};

// El filtro decide qué RUTAS se ven, no qué eventos. Una ruta aparece si algo
// suyo coincide, y al abrirla se ve completa: quien busca "con ubicación" está
// buscando la ruta donde pasó eso, y enseñarle el día recortado a un solo
// renglón le quita justo el contexto que fue a buscar.
const rutas = computed(() => {
  const grupos = new Map();
  // Los eventos vienen del más nuevo al más viejo, así que el orden en que se
  // van dando de alta los grupos ya es "la ruta que se movió hace menos,
  // arriba". Es el orden que se quiere: lo de ahorita primero.
  for (const e of eventos.value) {
    let g = grupos.get(e.asignacion);
    if (!g) {
      g = {
        id: e.asignacion,
        ruta: e.ruta,
        turno: e.turno,
        unidad: e.unidad,
        conductor: e.conductor,
        encargado: e.encargado,
        reemplazada: e.asignacion_estado === 'reemplazada',
        ultima: cuando(e),
        eventos: [],
      };
      grupos.set(e.asignacion, g);
    }
    g.eventos.push(e);
  }
  // Dentro de una ruta se lee al derecho: despertó, revisó, llegó, salió. Es
  // una historia, y una historia no se cuenta al revés.
  for (const g of grupos.values()) g.eventos.sort((a, b) => a.numero - b.numero);
  return [...grupos.values()].filter((g) => g.eventos.some(pasaFiltro));
});

/** Los cuatro cuadritos en su orden, con hueco donde no hubo nada. */
function faros(g) {
  return [1, 2, 3, 4].map((n) => {
    const e = g.eventos.find((x) => x.numero === n);
    return {
      numero: n,
      evento: e,
      clase: e ? e.semaforo : 'ninguno',
      simbolo: e ? simbolo(e) : '',
      titulo: e
        ? `${MARCAJES[n].nombre} · ${hora(cuando(e))} · ${quePaso(e)}`
        : `${MARCAJES[n].nombre} · sin registro`,
    };
  });
}

// Una línea que diga si hay que abrir la ruta o no. Sin esto el renglón obliga
// a descifrar cuatro colores, que es exactamente el trabajo que se quería
// ahorrar al agrupar.
function resumen(g) {
  const rojos = g.eventos.filter((e) => e.semaforo === 'rojo').length;
  const llamadas = g.eventos.filter((e) => e.fuente === 'manual').length;
  const sinPunto = g.eventos.filter(
    (e) => (e.numero === 3 || e.numero === 4) && e.respondido_en && e.latitud == null,
  ).length;

  const base = rojos
    ? `${rojos} sin contestar`
    : g.eventos.length === 4 ? 'Completa' : `${g.eventos.length} de 4 registrados`;

  const extras = [];
  if (llamadas) extras.push(`${llamadas} por teléfono`);
  if (sinPunto) extras.push(`${sinPunto} sin ubicación`);
  return extras.length ? `${base} · ${extras.join(' · ')}` : base;
}

// El color del renglón es el peor de sus marcajes: una ruta con tres verdes y
// un rojo es una ruta con un problema, no una ruta que va bien.
function comoVa(g) {
  if (g.eventos.some((e) => e.semaforo === 'rojo')) return 'rojo';
  if (g.eventos.some((e) => e.semaforo === 'amarillo')) return 'amarillo';
  if (g.eventos.length === 4) return 'verde';
  return 'pendiente';
}

function abrir(id) {
  const s = new Set(abiertas.value);
  if (s.has(id)) s.delete(id);
  else s.add(id);
  abiertas.value = s;
}

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
    Lo que pasó en el día, una ruta por renglón. Haz clic en cualquiera para ver
    a qué hora contestó el conductor cada mensaje y desde dónde. Se actualiza
    solo cada minuto.
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
        <th class="col-hora">Última</th>
        <th class="col-faros">Marcajes</th>
        <th>Ruta</th>
        <th>Unidad</th>
        <th>Conductor</th>
        <th>Cómo salió</th>
        <th class="col-abrir"></th>
      </tr>
    </thead>
    <tbody>
      <template v-for="g in rutas" :key="g.id">
        <tr class="fila-ruta" :class="{ abierta: abiertas.has(g.id) }" @click="abrir(g.id)">
          <td class="col-hora">{{ hora(g.ultima) }}</td>
          <td class="col-faros">
            <span class="faros">
              <span
                v-for="f in faros(g)"
                :key="f.numero"
                class="faro"
                :class="f.clase"
                :title="f.titulo"
              >{{ f.simbolo }}</span>
            </span>
          </td>
          <td>
            {{ g.ruta }}
            <!-- Una asignación que una recarga del Excel dejó fuera. Sus
                 mensajes sí salieron, así que el renglón se queda; pero hay que
                 decir por qué no aparece en el Tablero. -->
            <span v-if="g.reemplazada" class="chip gris" title="Una carga posterior del Excel reemplazó esta fila. Lo que ya había pasado se conserva.">reemplazada</span>
          </td>
          <td><strong>{{ g.unidad ?? '—' }}</strong></td>
          <td>{{ g.conductor ?? '—' }}</td>
          <td class="paso"><span class="senal" :class="comoVa(g)"></span>{{ resumen(g) }}</td>
          <td class="col-abrir"><span class="flecha">{{ abiertas.has(g.id) ? '▾' : '▸' }}</span></td>
        </tr>

        <tr v-if="abiertas.has(g.id)" class="fila-detalle">
          <td colspan="7">
            <table class="detalle">
              <tr v-for="e in g.eventos" :key="e.id">
                <td class="col-hora">{{ hora(cuando(e)) }}</td>
                <td class="col-faro"><span class="faro" :class="e.semaforo">{{ simbolo(e) }}</span></td>
                <td class="nowrap"><i class="ic">{{ MARCAJES[e.numero]?.icono }}</i>{{ MARCAJES[e.numero]?.nombre }}</td>
                <td class="paso">{{ quePaso(e) }}</td>
                <td class="col-mapa">
                  <a
                    v-if="e.latitud != null"
                    class="punto-mapa"
                    :href="enMapa(e)"
                    target="_blank"
                    rel="noopener"
                    :title="`${e.latitud}, ${e.longitud} — se abre en Google Maps`"
                    @click.stop
                  >📍 Ver</a>
                  <span v-else class="tenue-txt">—</span>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </template>

      <tr v-if="!rutas.length">
        <td colspan="7" class="tenue-txt">
          <template v-if="eventos.length">Nada coincide con el filtro.</template>
          <template v-else>Todavía no pasa nada en esta fecha.</template>
        </td>
      </tr>
    </tbody>
  </table>
</template>
