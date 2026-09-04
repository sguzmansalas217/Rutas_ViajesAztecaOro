<script setup>
// A quién le avisa el sistema cuando un conductor no contesta.
//
// El rojo del Tablero sirve mientras alguien lo esté mirando. Fuera de eso el
// único aviso es este WhatsApp, y hasta ahora se configuraba con un UPDATE a
// mano en la base: nadie que no fuera el proveedor podía tocarlo, y no había
// forma de saber si estaba puesto ni si de verdad llegaba.
import { ref, computed, onMounted } from 'vue';
import { api } from '../api.js';
import { esAdmin } from '../sesion.js';

const cargando = ref(true);
const error = ref('');
const aviso = ref('');
const fallo = ref('');
const guardando = ref(false);
const probando = ref(false);

const telefono = ref('');
const espera = ref(5);
const guardado = ref({ telefono: '', espera: 5, plantilla: '' });

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

const normalizado = computed(() => aE164(telefono.value));
const valido = computed(() => !telefono.value.trim() || /^\+\d{11,15}$/.test(normalizado.value));
const cambio = computed(
  () => normalizado.value !== guardado.value.telefono || Number(espera.value) !== guardado.value.espera,
);
const configurado = computed(() => Boolean(guardado.value.telefono));

async function cargar() {
  error.value = '';
  try {
    const p = await api.get('/catalogos/parametros');
    guardado.value = {
      telefono: String(p['aviso.encargado_telefono'] ?? ''),
      espera: Number(p['alerta.espera_min'] ?? 5),
      plantilla: String(p['wa.plantilla_alerta'] ?? ''),
    };
    telefono.value = guardado.value.telefono;
    espera.value = guardado.value.espera;
  } catch (e) {
    error.value = e.message;
  } finally {
    cargando.value = false;
  }
}

async function guardar() {
  error.value = ''; aviso.value = ''; fallo.value = ''; guardando.value = true;
  try {
    await api.put('/catalogos/parametros/aviso.encargado_telefono', { valor: normalizado.value });
    await api.put('/catalogos/parametros/alerta.espera_min', { valor: Number(espera.value) });
    await cargar();
    aviso.value = guardado.value.telefono
      ? 'Guardado. Manda una prueba para comprobar que sí llega.'
      : 'Guardado. Sin número, los rojos sólo se ven en el Tablero.';
  } catch (e) {
    error.value = e.message;
  } finally {
    guardando.value = false;
  }
}

async function probar() {
  error.value = ''; aviso.value = ''; fallo.value = ''; probando.value = true;
  try {
    // El endpoint no revienta cuando Meta rechaza: contesta ok:false con el
    // motivo. Una ventana de 24 h cerrada no es un error del sistema y no se
    // pinta como tal —se explica, porque se arregla del otro lado—.
    const r = await api.post('/catalogos/alertas/prueba', {});
    if (!r.ok) { fallo.value = r.error; return; }
    // Por dónde salió no es un detalle técnico: es la diferencia entre un
    // aviso gratis y uno que se cobra cada vez, todos los días del mes.
    aviso.value = r.canal === 'plantilla'
      ? `Enviado a ${r.telefono} por plantilla, porque ese número no tiene ventana de 24 h abierta. Llega, pero cada aviso se cobra. Si el encargado contesta cualquier cosa, el resto del día sale gratis.`
      : `Enviado a ${r.telefono} por texto libre, sin costo. Si no llega en un minuto, revisa el número.`;
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
    sistema manda un WhatsApp con la lista. Aquí se decide a qué número y con
    cuánta espera.
  </p>

  <div v-if="error" class="error">{{ error }}</div>
  <div v-if="aviso" class="ok">{{ aviso }}</div>
  <div v-if="fallo" class="aviso amarillo">{{ fallo }}</div>

  <div v-if="!cargando && !configurado" class="aviso">
    <strong>Ahorita no le llegan a nadie.</strong>
    Sin número configurado, un conductor puede no contestar y nadie se entera
    hasta que alguien abra el Tablero.
  </div>

  <div class="cuenta">
    <div class="caja">
      <h3>A quién le llega</h3>

      <label for="tel">WhatsApp que recibe las alertas</label>
      <input
        id="tel" v-model="telefono" :disabled="!esAdmin"
        placeholder="449 255 7153"
        autocomplete="off"
      />
      <p class="tenue-txt" :class="{ 'mal': !valido }">
        <template v-if="!telefono.trim()">Vacío: no se manda ningún aviso.</template>
        <template v-else-if="valido">Se guarda como <strong>{{ normalizado }}</strong></template>
        <template v-else>Ese número no se ve bien. Escribe los 10 dígitos.</template>
      </p>

      <label for="espera">Minutos de espera antes de marcar rojo</label>
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
        Por eso el sistema intenta las dos cosas, en este orden:
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
      <p v-if="cambio && configurado" class="tenue-txt">Guarda primero para probar el número nuevo.</p>
    </div>
  </div>
</template>
