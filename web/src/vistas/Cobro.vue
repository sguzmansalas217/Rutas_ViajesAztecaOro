<script setup>
import { ref, onMounted, computed } from 'vue';
import { api } from '../api.js';

const periodo = ref(new Date().toISOString().slice(0, 7) + '-01');
const calculo = ref(null);
const margen = ref(null);
const error = ref('');
const aviso = ref('');

const mxn = (n) => Number(n ?? 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });
const total = computed(() => calculo.value?.total ?? 0);

async function cargar() {
  error.value = '';
  try {
    calculo.value = await api.get(`/cobro/periodo?periodo=${periodo.value}`);
  } catch (e) { error.value = e.message; }
  // El margen es sólo del proveedor —enseña lo que cuesta el servicio, no lo
  // que se cobra—. Al administrador del cliente el API le contesta 403 y aquí
  // el bloque simplemente no se pinta; el resto de la pantalla va igual.
  try { margen.value = await api.get(`/cobro/margen?periodo=${periodo.value}`); } catch { margen.value = null; }
}

async function cerrar() {
  if (!confirm('Cerrar el periodo congela el conteo de unidades. No se puede deshacer. ¿Continuar?')) return;
  try {
    await api.post('/cobro/cerrar', { periodo: periodo.value });
    aviso.value = 'Periodo cerrado. Ese conteo es el que respalda la factura.';
    await cargar();
  } catch (e) { error.value = e.message; }
}

onMounted(cargar);
</script>

<template>
  <h2>Cobro</h2>
  <p class="sub">
    Se cobra por <strong>vehículo activo</strong>. Una unidad que cubre 1, 2, 3 o 4 rutas
    paga lo mismo: el número de rutas no entra en la fórmula.
  </p>

  <div v-if="error" class="error">{{ error }}</div>
  <div v-if="aviso" class="ok">{{ aviso }}</div>

  <div class="barra">
    <input type="month" :value="periodo.slice(0, 7)"
           @change="periodo = $event.target.value + '-01'; cargar()" />
    <button class="tenue" @click="cargar">Recalcular</button>
    <button @click="cerrar">Cerrar periodo</button>
  </div>

  <div v-if="calculo" class="tarjetas">
    <div class="tarjeta"><div class="n">{{ calculo.vehiculosActivos }}</div><div class="r">Vehículos activos</div></div>
    <div class="tarjeta"><div class="n">{{ calculo.incluidas }}</div><div class="r">Incluidos</div></div>
    <div class="tarjeta"><div class="n">{{ calculo.adicionales }}</div><div class="r">Adicionales</div></div>
    <div class="tarjeta"><div class="n" style="font-size:19px">{{ mxn(calculo.subtotal) }}</div><div class="r">Subtotal</div></div>
    <div class="tarjeta"><div class="n" style="font-size:19px">{{ mxn(total) }}</div><div class="r">Total con IVA</div></div>
  </div>

  <!-- El contrato cubre un número fijo de unidades y el archivo trae más.
       Este aviso es el argumento de venta: cuánto costaría cubrirlas todas. -->
  <div v-if="calculo?.proyeccion" class="aviso amarillo">
    En el archivo de este periodo hay
    <strong>{{ calculo.proyeccion.vehiculosActivos }}</strong> unidades, pero el contrato
    cubre <strong>{{ calculo.limiteContrato }}</strong>. Se factura {{ mxn(total) }}.
    Cubrirlas todas costaría <strong>{{ mxn(calculo.proyeccion.total) }}</strong> al mes.
    <router-link to="/unidades">Ver cuáles están dentro</router-link>
  </div>

  <div v-if="calculo" class="aviso">
    <strong>{{ calculo.unidadesConVariasRutas }}</strong> unidades cubren más de una ruta
    ({{ calculo.rutasTotales }} rutas en total) y no generan ningún cargo adicional.
    Fórmula: {{ mxn(calculo.rentaBase) }} + {{ calculo.adicionales }} × {{ mxn(calculo.precioExtra) }}.
  </div>

  <!-- Pantalla interna: esto NO se le enseña al cliente. -->
  <div v-if="margen" class="tarjetas">
    <div class="tarjeta"><div class="n">{{ margen.plantillas }}</div><div class="r">Plantillas (con costo)</div></div>
    <div class="tarjeta verde"><div class="n">{{ margen.libres }}</div><div class="r">Libres (gratis)</div></div>
    <div class="tarjeta" :class="margen.porcentajeGratis >= 80 ? 'verde' : 'amarillo'">
      <div class="n">{{ margen.porcentajeGratis }}%</div><div class="r">Dentro de ventana</div>
    </div>
    <div class="tarjeta" :class="margen.excedeUmbral ? 'rojo' : ''">
      <div class="n" style="font-size:19px">{{ mxn(margen.costoMetaMxn) }}</div><div class="r">Costo Meta</div>
    </div>
    <div class="tarjeta"><div class="n" style="font-size:19px">{{ mxn(margen.margenMxn) }}</div><div class="r">Margen</div></div>
  </div>

  <h3 style="margin-top:24px;font-size:15px">Detalle por unidad</h3>
  <table v-if="calculo">
    <thead>
      <tr><th>Unidad</th><th>Rutas distintas</th><th>Días activos</th><th>Asignaciones</th><th>Primer día</th><th>Último día</th></tr>
    </thead>
    <tbody>
      <tr v-for="d in calculo.detalle" :key="d.vehiculo_id">
        <td><strong>{{ d.vehiculo }}</strong></td>
        <td>
          {{ d.rutas_distintas }}
          <span v-if="d.rutas_distintas > 1" class="chip verde">sin cargo extra</span>
        </td>
        <td>{{ d.dias_activos }}</td>
        <td>{{ d.asignaciones }}</td>
        <td class="tenue-txt">{{ d.primer_dia }}</td>
        <td class="tenue-txt">{{ d.ultimo_dia }}</td>
      </tr>
    </tbody>
  </table>
</template>
