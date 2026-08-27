<script setup>
import { ref, onMounted } from 'vue';
import { api } from '../api.js';

// Esta pantalla es la razón por la que el cliente no tiene que tocar su Excel:
// lo que el importador no pudo interpretar aterriza aquí y se arregla en segundos.
const filas = ref([]);
const error = ref('');
const aviso = ref('');

async function cargar() {
  try {
    error.value = '';
    filas.value = await api.get('/operacion/por-resolver');
  } catch (e) { error.value = e.message; }
}

async function guardarTelefono(f, valor) {
  if (!f.conductor_id) { error.value = 'Primero asigna un conductor a esa celda'; return; }
  try {
    const r = await api.put(`/catalogos/conductores/${f.conductor_id}`, { telefono: valor });
    aviso.value = `Teléfono guardado. Se reactivaron ${r.reactivadas} asignaciones de ${r.nombre}.`;
    await cargar();
  } catch (e) { error.value = e.message; }
}

async function marcar(f, estado) {
  try {
    await api.post(`/operacion/asignaciones/${f.id}/resolver`, { estado });
    await cargar();
  } catch (e) { error.value = e.message; }
}

onMounted(cargar);
</script>

<template>
  <h2>Por resolver</h2>
  <p class="sub">
    Celdas del Excel que el importador no pudo cerrar. Mientras estén aquí no se les manda
    ningún mensaje y no cuentan como unidad facturable.
  </p>

  <div v-if="error" class="error">{{ error }}</div>
  <div v-if="aviso" class="ok">{{ aviso }}</div>

  <div v-if="!filas.length" class="ok">Todo resuelto. No hay pendientes de aquí en adelante.</div>

  <table v-else>
    <thead>
      <tr>
        <th>Fecha</th><th>Turno / Ruta</th><th>Celda</th><th>Texto del Excel</th>
        <th>Motivo</th><th>Teléfono</th><th></th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="f in filas" :key="f.id">
        <td>{{ f.fecha }}</td>
        <td>{{ f.turno.replace('_', ' ') }} · {{ f.ruta }}<br /><span class="tenue-txt">{{ String(f.hora_monitoreo).slice(0,5) }}</span></td>
        <td class="tenue-txt">{{ f.hoja }}!{{ f.celda }}</td>
        <td><strong>{{ f.texto_origen }}</strong></td>
        <td><span class="chip amarillo">{{ f.motivo }}</span></td>
        <td>
          <input
            v-if="f.conductor_id && !f.telefono_e164"
            placeholder="10 dígitos"
            style="width:120px"
            @change="guardarTelefono(f, $event.target.value)"
          />
          <span v-else class="tenue-txt">{{ f.telefono_e164 ?? '—' }}</span>
        </td>
        <td>
          <button class="tenue" @click="marcar(f, 'cancelada')">No opera</button>
        </td>
      </tr>
    </tbody>
  </table>
</template>
