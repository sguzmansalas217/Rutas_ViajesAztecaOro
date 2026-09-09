<script setup>
// A qué hora sale cada uno de los cuatro marcajes.
//
// El Excel trae una sola hora por ruta —la de monitoreo— y de ahí se derivan
// los cuatro. Hasta ahora esos desfases sólo se cambiaban con un UPDATE a mano
// en la base, así que en la práctica eran fijos: ajustar la operación pedía al
// proveedor. Aquí se tocan desde el portal y se ve el resultado antes de
// guardar.
import { ref, computed, onMounted } from 'vue';
import { api } from '../api.js';
import { esAdmin } from '../sesion.js';

// Se guardan con el nombre que ya tenían en la tabla parametro. Cambiarlos por
// unos más bonitos obligaría a migrar y a tocar programacion.js, y el nombre
// no lo lee nadie.
const CAMPOS = [
  { clave: 'marcaje1.desfase_min', def: 0 },
  { clave: 'marcaje2.retraso_min', def: 10 },
  { clave: 'marcaje3.desfase_min', def: -20 },
  { clave: 'marcaje4.desfase_min', def: 0 },
  { clave: 'marcaje.tolerancia_min', def: 15 },
];

const cargando = ref(true);
const error = ref('');
const aviso = ref('');
const guardando = ref(false);

const v = ref({});
const guardado = ref({});

// Hora de ejemplo para la vista previa. No se guarda en ningún lado: es una
// calculadora. 05:00 porque es la hora típica del primer turno del cliente.
const ejemplo = ref('05:00');

const enMin = (t) => {
  const m = String(t).match(/^(\d{1,2}):(\d{2})$/);
  return m && Number(m[1]) < 24 && Number(m[2]) < 60 ? Number(m[1]) * 60 + Number(m[2]) : null;
};
const aTexto = (n) => {
  const x = ((n % 1440) + 1440) % 1440;
  return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`;
};

const base = computed(() => enMin(ejemplo.value));

// La hoja del cliente no trae columna de salida, así que el sistema la supone
// 40 min después del monitoreo. Los marcajes 3 y 4 cuelgan de ahí, no de la
// hora de monitoreo: por eso se enseña también en la vista previa.
const salida = computed(() => (base.value == null ? null : base.value + 40));

const previa = computed(() => {
  if (base.value == null) return [];
  const t = [
    { n: 1, nombre: 'Despertar', min: base.value + Number(v.value['marcaje1.desfase_min'] ?? 0) },
    { n: 2, nombre: 'Revisión', min: base.value + Number(v.value['marcaje2.retraso_min'] ?? 0) },
    { n: 3, nombre: 'Filtro', min: salida.value + Number(v.value['marcaje3.desfase_min'] ?? 0) },
    { n: 4, nombre: 'Salida', min: salida.value + Number(v.value['marcaje4.desfase_min'] ?? 0) },
  ];
  return t.map((m, i) => ({ ...m, hora: aTexto(m.min), espera: i === 0 ? null : m.min - t[i - 1].min }));
});

// Un marcaje que sale antes que el anterior no revienta nada —cada uno se manda
// por su cuenta—, pero el conductor recibe las preguntas en desorden y el
// tablero se lee al revés. Es el error fácil de cometer aquí.
const desordenado = computed(() => previa.value.some((m) => m.espera != null && m.espera < 0));

const valido = computed(() => CAMPOS.every((c) => {
  const n = Number(v.value[c.clave]);
  return Number.isInteger(n) && n >= -240 && n <= 240;
}) && Number(v.value['marcaje.tolerancia_min']) >= 1);

const cambio = computed(() => CAMPOS.some((c) => Number(v.value[c.clave]) !== Number(guardado.value[c.clave])));

async function cargar() {
  error.value = '';
  try {
    const p = await api.get('/catalogos/parametros');
    const leido = {};
    for (const c of CAMPOS) leido[c.clave] = Number(p[c.clave] ?? c.def);
    guardado.value = leido;
    v.value = { ...leido };
  } catch (e) {
    error.value = e.message;
  } finally {
    cargando.value = false;
  }
}

async function guardar() {
  error.value = ''; aviso.value = ''; guardando.value = true;
  try {
    for (const c of CAMPOS) {
      if (Number(v.value[c.clave]) !== Number(guardado.value[c.clave])) {
        await api.put(`/catalogos/parametros/${c.clave}`, { valor: Number(v.value[c.clave]) });
      }
    }
    await cargar();
    aviso.value = 'Guardado. Aplica a los archivos que subas de aquí en adelante; '
      + 'los marcajes que ya estaban programados no se mueven.';
  } catch (e) {
    error.value = e.message;
  } finally {
    guardando.value = false;
  }
}

function restaurar() {
  for (const c of CAMPOS) v.value[c.clave] = c.def;
}

onMounted(cargar);
</script>

<template>
  <h2>Tiempos</h2>
  <p class="sub">
    El Excel trae una sola hora por ruta. De ahí salen los cuatro marcajes, cada
    uno con los minutos que se le pongan aquí.
  </p>

  <div v-if="error" class="error">{{ error }}</div>
  <div v-if="aviso" class="ok">{{ aviso }}</div>

  <!-- Lo primero que hay que saber, porque es lo que confunde: se cambia el
       tiempo, se mira el tablero de hoy y no se movió nada. Los marcajes se
       calculan cuando se sube el archivo, no cuando les toca salir. -->
  <div class="aviso">
    <strong>Los cambios valen para lo que se cargue después.</strong>
    Las horas se calculan al subir el Excel, así que un cambio a media mañana no
    mueve los marcajes de hoy: hay que volver a cargar el archivo.
  </div>

  <div v-if="desordenado" class="aviso amarillo">
    Con estos números <strong>un marcaje sale antes que el anterior</strong>.
    Funciona, pero al conductor le llegan las preguntas en desorden.
  </div>

  <div class="cuenta">
    <div class="caja">
      <h3>Minutos de cada marcaje</h3>

      <label for="d1">1 · Despertar — respecto a la hora de monitoreo</label>
      <input id="d1" v-model.number="v['marcaje1.desfase_min']" type="number" step="1" :disabled="!esAdmin" />
      <p class="tenue-txt">
        Con 0 sale a la hora que dice el Excel. Es el que abre la ventana de 24 h;
        adelantarlo mucho no sirve de nada.
      </p>

      <label for="d2">2 · Revisión — minutos después de la hora de monitoreo</label>
      <input id="d2" v-model.number="v['marcaje2.retraso_min']" type="number" step="1" :disabled="!esAdmin" />
      <p class="tenue-txt">
        El tiempo que le das para levantarse y salir rumbo a la unidad.
      </p>

      <label for="d3">3 · Filtro — respecto a la hora de salida <span class="tenue-txt">(negativo = antes)</span></label>
      <input id="d3" v-model.number="v['marcaje3.desfase_min']" type="number" step="1" :disabled="!esAdmin" />
      <p class="tenue-txt">
        El del alcoholímetro, el único que pide ubicación. Con −20 se le pregunta
        veinte minutos antes de que salga la ruta.
      </p>

      <label for="d4">4 · Salida — respecto a la hora de salida</label>
      <input id="d4" v-model.number="v['marcaje4.desfase_min']" type="number" step="1" :disabled="!esAdmin" />

      <label for="tol">Tolerancia para contestar (minutos)</label>
      <input id="tol" v-model.number="v['marcaje.tolerancia_min']" type="number" min="1" max="240" step="1" :disabled="!esAdmin" />
      <p class="tenue-txt">
        Contestar dentro de esos minutos sale <strong>verde</strong>; después,
        <strong>amarillo</strong>. Esto no es lo mismo que la espera para el aviso
        al encargado, que se pone en <router-link to="/alertas">Alertas</router-link>.
      </p>

      <div v-if="esAdmin" class="barra" style="margin-top:14px">
        <button :disabled="guardando || !cambio || !valido" @click="guardar">
          {{ guardando ? 'Guardando…' : 'Guardar' }}
        </button>
        <button class="tenue" :disabled="guardando" @click="restaurar">Valores de siempre</button>
      </div>
      <p v-else class="tenue-txt">Sólo un administrador puede cambiar esto.</p>
    </div>

    <div class="caja">
      <h3>Cómo quedaría</h3>
      <label for="ej">Hora de monitoreo de ejemplo</label>
      <input id="ej" v-model="ejemplo" placeholder="05:00" autocomplete="off" style="max-width:140px" />
      <p class="tenue-txt">
        Si la ruta no trae hora de salida propia —el formato de la hoja MAÑANA no
        la trae—, el sistema la toma 40 min después: las
        <strong>{{ salida != null ? aTexto(salida) : '—' }}</strong> en este ejemplo.
      </p>

      <table v-if="previa.length" style="margin-top:10px">
        <thead>
          <tr><th>#</th><th>Marcaje</th><th>Sale a las</th><th>Desde el anterior</th></tr>
        </thead>
        <tbody>
          <tr v-for="m in previa" :key="m.n">
            <td>{{ m.n }}</td>
            <td><strong>{{ m.nombre }}</strong></td>
            <td>{{ m.hora }}</td>
            <td :class="m.espera != null && m.espera < 0 ? 'mal' : 'tenue-txt'">
              {{ m.espera == null ? '—' : `${m.espera} min` }}
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else class="tenue-txt">Escribe una hora en formato 24 h, por ejemplo 05:00.</p>

      <p class="tenue-txt" v-if="!cargando">
        Para una prueba conviene apretarlos —5 y 10 minutos— y volver a subir el
        archivo; para producción, los de siempre: 0, 10, −20 y 0.
      </p>
    </div>
  </div>
</template>
