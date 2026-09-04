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

// Qué es cada marcaje. En la base son 1, 2, 3 y 4 porque ahí lo que importa es
// el orden, pero al operador el número no le dice nada: tiene que traducirlo
// mentalmente cada vez y con cuatro columnas iguales se equivoca de renglón.
// El nombre y el icono son los mismos que le llegan al conductor por WhatsApp
// (parámetros texto.marcaje1..4), para que cuando hable con él estén viendo lo
// mismo. 'que' se usa en las descripciones: es lo que falta que haga.
const MARCAJES = [
  { n: 1, icono: '☀️', nombre: 'Despertar', que: 'confirmar que ya despertó' },
  { n: 2, icono: '🔧', nombre: 'Revisión',  que: 'confirmar que la unidad está en buenas condiciones' },
  { n: 3, icono: '📍', nombre: 'Filtro',     que: 'compartir su ubicación en el filtro' },
  { n: 4, icono: '🛣️', nombre: 'Salida',     que: 'confirmar que ya salió con la ruta' },
];
const DEF = Object.fromEntries(MARCAJES.map((d) => [d.n, d]));

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

// En qué va un marcaje, en una línea. Los cuatro casos son distintos y el
// color solo no los separa: 'pendiente' gris puede ser "ni siquiera se le ha
// preguntado" o "ya se le preguntó y no contesta", y son cosas opuestas.
function detalle(m) {
  if (m.estado === 'cancelado') return 'cancelado, no se envía';
  if (m.respondido) {
    const como = m.semaforo === 'verde' ? 'a tiempo'
      : m.semaforo === 'amarillo' ? 'tarde o sin comprobar la ubicación'
      : 'registrado';
    return `contestó ${hora(m.respondido)} · ${como}`;
  }
  if (m.semaforo === 'rojo') return `sin respuesta desde ${hora(m.enviado ?? m.programado)}`;
  if (m.enviado) return `enviado ${hora(m.enviado)} · esperando respuesta`;
  return `sale ${hora(m.programado)} · todavía no se le pregunta`;
}

function titulo(a, n) {
  const d = DEF[n];
  const m = marcaje(a, n);
  if (!m) return `${d.icono} ${d.nombre}: no programado`;
  return `${d.icono} ${d.nombre} — ${d.que}\n${detalle(m)}`;
}

/**
 * El estatus de la ruta completa: en qué punto del proceso va y qué toca.
 *
 * Las cuatro columnas dicen cómo salió cada marcaje; esto dice qué hacer con
 * la fila. Se resuelve por prioridad, de lo que urge a lo que no:
 *   rojo → alguien tiene que hablarle al conductor
 *   esperando → ya se preguntó y no contesta; todavía no vence
 *   completa → no hay nada que atender
 *   sigue → el día de esa ruta aún no empieza o va entre marcaje y marcaje
 */
function estatus(a) {
  const lista = MARCAJES.map((d) => ({ d, m: marcaje(a, d.n) })).filter((x) => x.m);
  if (!lista.length) {
    return {
      clase: 'gris',
      texto: 'Sin marcajes',
      resumen: 'Esta fila no tiene marcajes programados. Suele ser una asignación por resolver: sin conductor o sin teléfono no hay a quién preguntarle.',
      lineas: [],
    };
  }

  const lineas = lista.map(({ d, m }) => `${d.icono}  ${d.nombre} — ${detalle(m)}`);
  const rojos = lista.filter((x) => x.m.semaforo === 'rojo');
  const esperando = lista.find((x) => x.m.enviado && !x.m.respondido && x.m.semaforo !== 'rojo');
  const pendientes = lista.filter(
    (x) => !x.m.respondido && x.m.semaforo !== 'rojo' && x.m.estado !== 'cancelado',
  );
  const tarde = lista.filter((x) => x.m.semaforo === 'amarillo');

  if (rojos.length) {
    const { d } = rojos[rojos.length - 1];
    return {
      clase: 'rojo',
      texto: `No contestó · ${d.nombre}`,
      resumen: `Se le preguntó y no respondió: falta ${d.que}. ${rojos.length > 1 ? `Van ${rojos.length} marcajes sin contestar. ` : ''}Hay que localizar al conductor.`,
      lineas,
    };
  }
  if (esperando) {
    return {
      clase: 'espera',
      texto: `Esperando · ${esperando.d.nombre}`,
      resumen: `El mensaje salió a las ${hora(esperando.m.enviado)} y todavía no contesta: falta ${esperando.d.que}. Si no responde se pone en rojo solo.`,
      lineas,
    };
  }
  if (!pendientes.length) {
    return tarde.length
      ? {
          clase: 'amarillo',
          texto: 'Completa con retrasos',
          resumen: `Los ${lista.length} marcajes quedaron registrados, ${tarde.length} fuera de tiempo o sin comprobar la ubicación. La ruta salió, pero conviene revisarla.`,
          lineas,
        }
      : {
          clase: 'verde',
          texto: 'Ruta completa',
          resumen: 'Los cuatro marcajes se contestaron a tiempo. No hay nada que atender en esta fila.',
          lineas,
        };
  }
  const sigue = pendientes[0];
  return {
    clase: 'gris',
    texto: `Sigue · ${sigue.d.nombre}`,
    resumen: `Nada pendiente ahorita. El siguiente mensaje sale a las ${hora(sigue.m.programado)} y le va a pedir ${sigue.d.que}.`,
    lineas,
  };
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

// El estatus se calcula aquí y no en la plantilla: ahí se llamaría una vez por
// cada lugar donde se usa —texto, clase y las líneas del detalle— y en 300
// filas eso es recorrer los marcajes mil veces en cada refresco del minuto.
const visibles = computed(() => {
  const lista = asignaciones.value
    .filter((a) => filtros.value.every((f, i) => !f || color(a, i + 1) === f))
    .map((a) => ({ ...a, est: estatus(a) }));
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
  </div>

  <table>
    <thead>
      <tr>
        <th>Hora</th><th>Ruta</th><th>Turno</th><th>Unidad</th><th>Conductor</th>
        <th>Estatus</th>
        <th v-for="d in MARCAJES" :key="d.n" class="col-faro">
          <div class="cab-faro">
            <span class="nom-faro" :title="`Marcaje ${d.n} — ${d.que}`">
              <i>{{ d.icono }}</i>{{ d.nombre }}
            </span>
            <select
              v-model="filtros[d.n - 1]"
              :class="{ activo: filtros[d.n - 1] }"
              :title="`Ver sólo un color en el marcaje de ${d.nombre.toLowerCase()}`"
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
        <td>
          <!-- tabindex: en una tabla no hay dónde hacer clic, así que sin esto
               el estatus sólo se puede leer con ratón. Con foco se abre igual
               tabulando. -->
          <span class="estatus" :class="a.est.clase" tabindex="0">
            {{ a.est.texto }}
            <span class="pista">
              <strong>{{ a.est.resumen }}</strong>
              <span v-for="l in a.est.lineas" :key="l" class="reng">{{ l }}</span>
            </span>
          </span>
        </td>
        <td v-for="n in 4" :key="n" class="col-faro">
          <span class="faro" :class="color(a, n)" :title="titulo(a, n)">{{ SIMBOLO[color(a, n)] }}</span>
        </td>
        <td class="tenue-txt">{{ a.encargado ?? '—' }}</td>
      </tr>
      <tr v-if="!visibles.length">
        <td colspan="11" class="tenue-txt">
          <template v-if="hayFiltro">Ningún marcaje coincide con el filtro.</template>
          <template v-else>Sin asignaciones para esta fecha. Carga el Excel de la semana.</template>
        </td>
      </tr>
    </tbody>
  </table>
</template>
