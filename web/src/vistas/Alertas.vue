<script setup>
// A quiénes les avisa el sistema cuando un conductor no contesta.
//
// El rojo del Tablero sirve mientras alguien lo esté mirando. Fuera de eso el
// único aviso es este WhatsApp, y hasta ahora se configuraba con un UPDATE a
// mano en la base: nadie que no fuera el proveedor podía tocarlo, y no había
// forma de saber si estaba puesto ni si de verdad llegaba.
import { ref, computed, onMounted } from 'vue';
import { api } from '../api.js';
import { esAdmin } from '../sesion.js';

const MAX_TELEFONOS = 5;

const cargando = ref(true);
const error = ref('');
const aviso = ref('');
const resultados = ref([]);
const guardando = ref(false);
const probando = ref(false);

const telefonos = ref(['']);
const espera = ref(5);
const guardado = ref({ telefonos: [], espera: 5, plantilla: '' });

// Se teclea como se dicta —10 dígitos— y se guarda en E.164, que es lo único
// que Meta acepta. Si viene con lada del país se respeta tal cual.
function aE164(v) {
  const d = String(v ?? '').replace(/\D/g, '');
  if (!d) return '';
  if (d.length === 10) return `+52${d}`;
  if (d.length === 12 && d.startsWith('52')) return `+${d}`;
  if (d.length === 13 && d.startsWith('521')) return `+${d}`;
  return `+${d}`;
}

// Uno por renglón: {texto, normalizado, valido}. Los vacíos se ignoran al
// guardar —son huecos que se dejaron al agregar un renglón de más—.
const filas = computed(() => telefonos.value.map((t) => {
  const normalizado = aE164(t);
  return { texto: t, normalizado, valido: !t.trim() || /^\+\d{11,15}$/.test(normalizado) };
}));

const normalizados = computed(() => filas.value.map((f) => f.normalizado).filter(Boolean));
const valido = computed(() => filas.value.every((f) => f.valido) && normalizados.value.length <= MAX_TELEFONOS);
const cambio = computed(() => {
  if (Number(espera.value) !== guardado.value.espera) return true;
  const a = [...normalizados.value].sort();
  const b = [...guardado.value.telefonos].sort();
  return JSON.stringify(a) !== JSON.stringify(b);
});
const configurado = computed(() => guardado.value.telefonos.length > 0);

function agregarNumero() {
  if (telefonos.value.length < MAX_TELEFONOS) telefonos.value.push('');
}
function quitarNumero(i) {
  telefonos.value.splice(i, 1);
  if (!telefonos.value.length) telefonos.value.push('');
}

async function cargar() {
  error.value = '';
  try {
    const p = await api.get('/catalogos/parametros');
    const crudo = p['aviso.encargado_telefono'];
    const lista = Array.isArray(crudo) ? crudo.filter(Boolean) : (crudo ? [String(crudo)] : []);
    guardado.value = {
      telefonos: lista,
      espera: Number(p['alerta.espera_min'] ?? 5),
      plantilla: String(p['wa.plantilla_alerta'] ?? ''),
    };
    telefonos.value = lista.length ? [...lista] : [''];
    espera.value = guardado.value.espera;
  } catch (e) {
    error.value = e.message;
  } finally {
    cargando.value = false;
  }
}

async function guardar() {
  error.value = ''; aviso.value = ''; resultados.value = []; guardando.value = true;
  try {
    await api.put('/catalogos/parametros/aviso.encargado_telefono', { valor: normalizados.value });
    await api.put('/catalogos/parametros/alerta.espera_min', { valor: Number(espera.value) });
    await cargar();
    aviso.value = guardado.value.telefonos.length
      ? `Guardado. Manda una prueba para comprobar que sí ${guardado.value.telefonos.length > 1 ? 'les llega a todos' : 'llega'}.`
      : 'Guardado. Sin números, los rojos sólo se ven en el Tablero.';
  } catch (e) {
    error.value = e.message;
  } finally {
    guardando.value = false;
  }
}

async function probar() {
  error.value = ''; aviso.value = ''; resultados.value = []; probando.value = true;
  try {
    // El endpoint no revienta cuando Meta rechaza uno: contesta ok:false para
    // ese número con el motivo. Una ventana de 24 h cerrada no es un error del
    // sistema y no se pinta como tal —se explica, porque se arregla del otro
    // lado—. Cada número se prueba y se reporta por separado.
    const r = await api.post('/catalogos/alertas/prueba', {});
    resultados.value = r.resultados;
  } catch (e) {
    error.value = e.message;
  } finally {
    probando.value = false;
  }
}

onMounted(cargar);
</script>

<template>
  <h2>Alertas</h2>
  <p class="sub">
    Cuando un conductor no contesta, el marcaje se pone en rojo en el Tablero y el
    sistema manda un WhatsApp con la lista. Aquí se decide a qué números (hasta
    {{ MAX_TELEFONOS }}) y con cuánta espera.
  </p>

  <div v-if="error" class="error">{{ error }}</div>
  <div v-if="aviso" class="ok">{{ aviso }}</div>

  <!-- Por dónde salió no es un detalle técnico: es la diferencia entre un
       aviso gratis y uno que se cobra cada vez, todos los días del mes. -->
  <div v-if="resultados.length" class="caja" style="margin-bottom:14px">
    <h3 style="margin-top:0">Resultado de la prueba</h3>
    <p v-for="r in resultados" :key="r.telefono" class="tenue-txt" :class="{ mal: !r.ok }">
      <strong>{{ r.telefono }}</strong>
      <span v-if="r.principal" class="chip">principal</span> —
      <template v-if="r.ok && r.canal === 'plantilla'">
        enviado por plantilla (ese número no tiene ventana de 24 h abierta; llega, pero se cobra).
      </template>
      <template v-else-if="r.ok">enviado por texto libre, sin costo.</template>
      <template v-else-if="!r.principal">
        no llegó — es secundario, sin respaldo de plantilla: solo le llega si escribió algo hoy.
      </template>
      <template v-else>no llegó: {{ r.error }}</template>
    </p>
  </div>

  <div v-if="!cargando && !configurado" class="aviso">
    <strong>Ahorita no le llega a nadie.</strong>
    Sin ningún número configurado, un conductor puede no contestar y nadie se
    entera hasta que alguien abra el Tablero.
  </div>

  <div class="cuenta">
    <div class="caja">
      <h3>A quiénes les llega</h3>

      <label>WhatsApp que reciben las alertas</label>
      <p class="tenue-txt" style="margin-top:0">
        El <strong>primero es el principal</strong>: a ése se le garantiza el aviso,
        pagando plantilla si hace falta. A los demás (secundarios) sólo les llega
        si escribieron algo al número del sistema en las últimas 24 h — nunca se
        paga plantilla por ellos.
      </p>
      <div v-for="(f, i) in filas" :key="i" class="barra" style="margin-bottom:6px">
        <span class="chip" style="min-width:74px; text-align:center">
          {{ i === 0 ? 'principal' : 'secundario' }}
        </span>
        <input
          v-model="telefonos[i]" :disabled="!esAdmin"
          placeholder="449 255 7153"
          autocomplete="off"
          style="flex:1"
        />
        <button
          v-if="esAdmin && telefonos.length > 1" class="tenue" type="button"
          title="Quitar este número" @click="quitarNumero(i)"
        >✕</button>
      </div>
      <p
        v-for="(f, i) in filas.filter((x) => x.texto.trim() && !x.valido)" :key="'err' + i"
        class="tenue-txt mal"
      >
        "{{ f.texto }}" no se ve bien. Escribe los 10 dígitos.
      </p>
      <p v-if="normalizados.length > MAX_TELEFONOS" class="tenue-txt mal">
        Máximo {{ MAX_TELEFONOS }} números.
      </p>
      <button
        v-if="esAdmin && telefonos.length < MAX_TELEFONOS" class="tenue" type="button"
        style="margin-top:4px" @click="agregarNumero"
      >+ Agregar número</button>

      <label for="espera" style="margin-top:14px">Minutos de espera antes de marcar rojo</label>
      <input id="espera" v-model.number="espera" type="number" min="1" max="120" :disabled="!esAdmin" />
      <p class="tenue-txt">
        Desde que sale el mensaje. Con {{ espera }} min, un conductor que contesta
        al minuto {{ Number(espera) + 1 }} ya salió en la alerta.
      </p>

      <button v-if="esAdmin" :disabled="guardando || !cambio || !valido" @click="guardar">
        {{ guardando ? 'Guardando…' : 'Guardar' }}
      </button>
      <p v-else class="tenue-txt">Sólo un administrador puede cambiar esto.</p>
    </div>

    <div class="caja">
      <h3>Cómo llega</h3>
      <p class="tenue-txt" style="margin-top:0">
        WhatsApp <strong>no deja escribirle primero</strong> a un número que no ha
        escrito antes. Quien recibe las alertas tendría que mandarle un mensaje
        —lo que sea— al número del sistema cada día para que el aviso saliera
        gratis, y nadie se acuerda de eso.
      </p>
      <p class="tenue-txt">
        Por eso el sistema intenta las dos cosas, en este orden, con cada número:
      </p>
      <ol class="tenue-txt canales">
        <li><strong>Texto libre</strong> — gratis. Sólo entra si ese número escribió en las últimas 24 h.</li>
        <li>
          <strong>Plantilla</strong> — entra siempre, pero <strong>se cobra</strong> cada aviso.
          <template v-if="guardado.plantilla">Usa «{{ guardado.plantilla }}», que tiene que estar aprobada en Meta.</template>
        </li>
      </ol>
      <p class="tenue-txt">
        Un rechazo de Meta no cuesta nada, así que probar el camino gratis primero
        sale gratis. Conviene comprobarlo de vez en cuando y no esperar a que haya
        un rojo de verdad para descubrir que el aviso no llegaba.
      </p>
      <button v-if="esAdmin" class="tenue" :disabled="probando || !configurado || cambio" @click="probar">
        {{ probando ? 'Mandando…' : 'Mandar mensaje de prueba' }}
      </button>
      <p v-if="cambio && configurado" class="tenue-txt">Guarda primero para probar los números nuevos.</p>
    </div>
  </div>
</template>
