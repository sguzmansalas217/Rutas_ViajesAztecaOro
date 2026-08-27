<script setup>
import { ref, onMounted } from 'vue';
import { api } from '../api.js';

const archivo = ref(null);
const subiendo = ref(false);
const reporte = ref(null);
const historial = ref([]);
const error = ref('');

async function cargarHistorial() {
  try { historial.value = await api.get('/carga'); } catch (e) { error.value = e.message; }
}

async function subir() {
  if (!archivo.value) return;
  subiendo.value = true;
  error.value = '';
  reporte.value = null;
  try {
    const fd = new FormData();
    fd.append('archivo', archivo.value);
    reporte.value = await api.post('/carga', fd);
    await cargarHistorial();
  } catch (e) {
    error.value = e.message;
  } finally {
    subiendo.value = false;
  }
}

onMounted(cargarHistorial);
</script>

<template>
  <h2>Cargar Excel</h2>
  <p class="sub">
    El archivo semanal tal cual lo manda el cliente (FVA-MON-01). No hay que modificarlo:
    subirlo dos veces no duplica nada.
  </p>

  <div v-if="error" class="error">{{ error }}</div>

  <div class="barra">
    <input type="file" accept=".xlsx" @change="archivo = $event.target.files[0]" />
    <button :disabled="!archivo || subiendo" @click="subir">
      {{ subiendo ? 'Procesando…' : 'Subir y procesar' }}
    </button>
  </div>

  <div v-if="reporte">
    <div class="ok">
      Semana {{ reporte.semanaInicio }} → {{ reporte.semanaFin }}.
      {{ reporte.leidas }} celdas leídas, {{ reporte.resueltas }} listas,
      {{ reporte.marcajesProgramados }} marcajes programados.
    </div>
    <div v-if="reporte.pendientes" class="aviso">
      {{ reporte.pendientes }} quedaron por resolver (casi siempre falta el teléfono).
      Ve a <router-link to="/por-resolver">Por resolver</router-link>.
    </div>
    <div class="tarjetas">
      <div v-for="(n, hoja) in reporte.hojas" :key="hoja" class="tarjeta">
        <div class="n">{{ n }}</div><div class="r">{{ hoja }}</div>
      </div>
    </div>
    <p v-if="reporte.multiples?.length" class="tenue-txt">
      Celdas con dos conductores: {{ reporte.multiples.map(m => `${m.hoja}!${m.celda}`).join(', ') }}
    </p>
  </div>

  <h3 style="margin-top:26px;font-size:15px">Cargas anteriores</h3>
  <table>
    <thead>
      <tr><th>Archivo</th><th>Semana</th><th>Leídas</th><th>Listas</th><th>Pendientes</th><th>Quién</th><th>Cuándo</th></tr>
    </thead>
    <tbody>
      <tr v-for="c in historial" :key="c.id">
        <td>{{ c.archivo }}</td>
        <td class="tenue-txt">{{ c.semana_inicio }} → {{ c.semana_fin }}</td>
        <td>{{ c.filas_leidas }}</td>
        <td>{{ c.filas_resueltas }}</td>
        <td><span :class="c.filas_pendientes ? 'chip amarillo' : 'chip verde'">{{ c.filas_pendientes }}</span></td>
        <td class="tenue-txt">{{ c.subido_por }}</td>
        <td class="tenue-txt">{{ new Date(c.creado_en).toLocaleString('es-MX') }}</td>
      </tr>
    </tbody>
  </table>
</template>
