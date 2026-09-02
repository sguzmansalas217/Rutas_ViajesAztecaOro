<script setup>
import { ref, onMounted } from 'vue';
import { api } from '../api.js';
import { puedeEditar } from '../sesion.js';

const lista = ref([]);
const buscar = ref('');
const soloSinTelefono = ref(false);
const error = ref('');
const aviso = ref('');

async function cargar() {
  try {
    error.value = '';
    lista.value = await api.get(
      `/catalogos/conductores?buscar=${encodeURIComponent(buscar.value)}&sinTelefono=${soloSinTelefono.value ? 1 : 0}`,
    );
  } catch (e) { error.value = e.message; }
}

async function guardar(c, valor) {
  try {
    const r = await api.put(`/catalogos/conductores/${c.id}`, { telefono: valor });
    c.telefono_e164 = r.telefono_e164;
    aviso.value = r.reactivadas
      ? `${r.nombre}: teléfono guardado y ${r.reactivadas} asignaciones activadas.`
      : `${r.nombre}: teléfono guardado.`;
  } catch (e) { error.value = e.message; }
}

onMounted(cargar);
</script>

<template>
  <h2>Conductores</h2>
  <p class="sub">
    El Excel no trae teléfonos: se capturan aquí una sola vez. La columna
    "Como aparece" son los alias detectados — así se reconoce a la misma persona
    aunque el Excel la escriba distinto cada semana.
  </p>

  <div v-if="error" class="error">{{ error }}</div>
  <div v-if="aviso" class="ok">{{ aviso }}</div>

  <div class="barra">
    <input v-model="buscar" placeholder="Buscar por nombre o alias" @keyup.enter="cargar" style="width:260px" />
    <label class="tenue-txt">
      <input v-model="soloSinTelefono" type="checkbox" @change="cargar" /> sólo sin teléfono
    </label>
    <button class="tenue" @click="cargar">Buscar</button>
  </div>

  <table>
    <thead>
      <tr><th>Nombre</th><th>Como aparece en el Excel</th><th>Teléfono</th><th>Estado</th></tr>
    </thead>
    <tbody>
      <tr v-for="c in lista" :key="c.id">
        <td><strong>{{ c.nombre }}</strong></td>
        <td class="tenue-txt">{{ c.como_aparece }}</td>
        <td>
          <input
            v-if="puedeEditar"
            :value="c.telefono_e164 ? c.telefono_e164.slice(3) : ''"
            placeholder="10 dígitos"
            style="width:130px"
            @change="guardar(c, $event.target.value)"
          />
          <span v-else class="tenue-txt">{{ c.telefono_e164 ?? '—' }}</span>
        </td>
        <td>
          <span v-if="c.telefono_e164" class="chip verde">listo</span>
          <span v-else class="chip rojo">falta teléfono</span>
        </td>
      </tr>
    </tbody>
  </table>
</template>
