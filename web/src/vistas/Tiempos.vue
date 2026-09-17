<script setup>
// A qué hora sale cada uno de los cuatro marcajes.
//
// El Excel trae una sola hora por ruta —la de monitoreo— y de ahí se derivan
// los cuatro, cada uno contado DESDE EL ANTERIOR: despertar tantos minutos
// después de la hora del Excel, revisión tantos después del despertar, filtro
// tantos después de la revisión, salida tantos después del filtro. Se lee
// igual que se dice en voz alta.
//
// Antes no era así. Los marcajes 3 y 4 colgaban de una «hora de salida» que la
// hoja MAÑANA no trae y que el sistema inventaba, y el filtro se ponía como
// −20: veinte minutos antes de una hora que no está en el archivo. Se podía
// setear bien sabiendo el truco, y setearlo mal no avisaba —los mensajes se
// encabalgaban y al conductor le llegaban en desorden—. Con la cascada el
// encabalgamiento no se valida: no se puede escribir.
import { ref, computed, onMounted } from 'vue';
import { api } from '../api.js';
import { esAdmin } from '../sesion.js';

// Se guardan con el nombre que ya tenían en la tabla parametro. El nombre no lo
// lee nadie; lo que importa es que coincidan con dominio/programacion.js.
const CAMPOS = [
  { clave: 'marcaje1.desfase_min', def: 0 },
  { clave: 'marcaje2.retraso_min', def: 10 },
  { clave: 'marcaje3.retraso_min', def: 10 },
  { clave: 'marcaje4.retraso_min', def: 20 },
  { clave: 'marcaje.tolerancia_min', def: 15 },
  { clave: 'alerta.espera_min', def: 5 },
];

// Rango válido de cada campo. Los tres de en medio son esperas: negativas no
// querrían decir nada. El primero sí puede serlo —despertar antes de la hora
// del Excel es una petición razonable—. El aviso al encargado vive aparte
// (Alertas.vue guarda el mismo parámetro), con su propio tope de 120: es
// minutos de espera, no de cascada, y no tiene sentido dejarlo crecer igual.
const RANGOS = {
  'marcaje1.desfase_min': { min: -240, max: 240 },
  'marcaje2.retraso_min': { min: 0, max: 240 },
  'marcaje3.retraso_min': { min: 0, max: 240 },
  'marcaje4.retraso_min': { min: 0, max: 240 },
  'marcaje.tolerancia_min': { min: 1, max: 240 },
  'alerta.espera_min': { min: 1, max: 120 },
};

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

const num = (clave) => Number(v.value[clave] ?? 0);

const previa = computed(() => {
  if (base.value == null) return [];
  const uno = base.value + num('marcaje1.desfase_min');
  const dos = uno + num('marcaje2.retraso_min');
  const tres = dos + num('marcaje3.retraso_min');
  const cuatro = tres + num('marcaje4.retraso_min');
  const t = [
    { n: 1, nombre: 'Despertar', min: uno },
    { n: 2, nombre: 'Revisión', min: dos },
    { n: 3, nombre: 'Filtro', min: tres },
    { n: 4, nombre: 'Salida', min: cuatro },
  ];
  return t.map((m, i) => ({ ...m, hora: aTexto(m.min), espera: i === 0 ? null : m.min - t[i - 1].min }));
});

const valido = computed(() => CAMPOS.every((c) => {
  const n = Number(v.value[c.clave]);
  const { min, max } = RANGOS[c.clave];
  return Number.isInteger(n) && n >= min && n <= max;
}));

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
    // La cascada (1-2-3-4 y tolerancia) queda grabada en cada marcaje al
    // programarse, así que un cambio no mueve lo que ya está pendiente. La
    // espera de alerta no: vencerYAlertar la lee en caliente en cada tic, así
    // que un cambio aquí sí afecta a los marcajes que ya están en curso.
    const soloEspera = CAMPOS.every((c) => c.clave === 'alerta.espera_min'
      || Number(v.value[c.clave]) === Number(guardado.value[c.clave]));

    for (const c of CAMPOS) {
      if (Number(v.value[c.clave]) !== Number(guardado.value[c.clave])) {
        await api.put(`/catalogos/parametros/${c.clave}`, { valor: Number(v.value[c.clave]) });
      }
    }
    await cargar();
    aviso.value = soloEspera
      ? 'Guardado. La espera de alerta ya aplica, incluso a los marcajes pendientes ahorita.'
      : 'Guardado. La cascada de minutos aplica a los archivos que subas de aquí en '
        + 'adelante —los marcajes ya programados no se mueven—; la espera de alerta ya '
        + 'aplica, incluso a los pendientes ahorita.';
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
    El Excel trae una sola hora por ruta. De ahí salen los cuatro marcajes, uno
    detrás de otro, con los minutos que se le pongan aquí.
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

  <div class="cuenta">
    <div class="caja">
      <h3>Minutos de cada marcaje</h3>

      <label for="d1">1 · Despertar — minutos <strong>después de la hora del Excel</strong></label>
      <input id="d1" v-model.number="v['marcaje1.desfase_min']" type="number" step="1" :disabled="!esAdmin" />
      <p class="tenue-txt">
        Con 0 sale a la hora que dice el Excel. Es el que abre la ventana de 24 h;
        adelantarlo mucho no sirve de nada. Se contesta escribiendo.
      </p>

      <label for="d2">2 · Revisión — minutos <strong>después del despertar</strong></label>
      <input id="d2" v-model.number="v['marcaje2.retraso_min']" type="number" min="0" step="1" :disabled="!esAdmin" />
      <p class="tenue-txt">
        El tiempo que le das para levantarse y llegar a la unidad. Éste sí lleva
        botones: <em>Todo bien</em> o <em>Hay una falla</em>.
      </p>

      <label for="d3">3 · Filtro — minutos <strong>después de la revisión</strong></label>
      <input id="d3" v-model.number="v['marcaje3.retraso_min']" type="number" min="0" step="1" :disabled="!esAdmin" />
      <p class="tenue-txt">
        El del alcoholímetro. Primero le pregunta si ya llegó, con el botón
        <em>Ya llegué</em>; al tocarlo se le pide la ubicación, que es lo único
        que cuenta.
      </p>

      <label for="d4">4 · Salida — minutos <strong>después del filtro</strong></label>
      <input id="d4" v-model.number="v['marcaje4.retraso_min']" type="number" min="0" step="1" :disabled="!esAdmin" />
      <p class="tenue-txt">
        Botón <em>Ya salí</em>. Si lo dice antes por su cuenta —«ya estoy en
        ruta»— también cuenta y no se le vuelve a preguntar.
      </p>

      <label for="tol">Tolerancia para contestar (minutos)</label>
      <input id="tol" v-model.number="v['marcaje.tolerancia_min']" type="number" min="1" max="240" step="1" :disabled="!esAdmin" />
      <p class="tenue-txt">
        Contestar dentro de esos minutos sale <strong>verde</strong>; después,
        <strong>amarillo</strong>. No es lo mismo que la espera para el aviso al
        encargado, de aquí abajo.
      </p>

      <label for="espera">Minutos de espera antes de marcar rojo</label>
      <input id="espera" v-model.number="v['alerta.espera_min']" type="number" min="1" max="120" step="1" :disabled="!esAdmin" />
      <p class="tenue-txt">
        Desde que sale el mensaje. Pasado este tiempo sin respuesta se pone en
        rojo y se avisa al encargado. Es el mismo parámetro que
        <router-link to="/alertas">Alertas</router-link> — cambiarlo aquí o allá
        es lo mismo.
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
        Escribe la hora que trae el Excel y abajo se ve a qué hora le llegaría
        cada mensaje al conductor.
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
            <td class="tenue-txt">{{ m.espera == null ? '—' : `${m.espera} min` }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else class="tenue-txt">Escribe una hora en formato 24 h, por ejemplo 05:00.</p>

      <p class="tenue-txt" v-if="!cargando">
        Para una prueba conviene apretarlos —1 y 2 minutos— y volver a subir el
        archivo; para producción, los de siempre: 0, 10, 10 y 20.
      </p>
    </div>
  </div>
</template>
