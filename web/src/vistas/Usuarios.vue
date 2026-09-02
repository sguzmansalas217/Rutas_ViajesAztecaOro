<script setup>
import { ref, computed, onMounted } from 'vue';
import { api } from '../api.js';

const lista = ref([]);
const yo = ref(null);
const error = ref('');
const aviso = ref('');
const entregar = ref(null);   // { correo, clave } — se enseña una sola vez

const nombre = ref('');
const correo = ref('');
const rol = ref('operador');
const clave = ref('');
const guardando = ref(false);

const MINIMO = 10;
const ROLES = [
  { v: 'admin', t: 'Administrador', d: 'Todo, incluido dar de alta usuarios.' },
  { v: 'operador', t: 'Operador', d: 'La operación diaria: cargar el Excel, resolver, marcar a mano.' },
  { v: 'consulta', t: 'Consulta', d: 'Sólo mirar. No cambia nada.' },
];

// Sin l/I/1 ni O/0: esta contraseña se dicta por teléfono o se copia a mano y
// esos pares se confunden. getRandomValues es el generador criptográfico del
// navegador, no Math.random.
const ALFABETO = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function inventarClave(largo = 14) {
  const n = crypto.getRandomValues(new Uint32Array(largo));
  return Array.from(n, (x) => ALFABETO[x % ALFABETO.length]).join('');
}

const problema = computed(() => {
  if (nombre.value.trim().length < 2) return 'Falta el nombre';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo.value.trim())) return 'El correo no se ve bien';
  if (clave.value.length < MINIMO) return `La contraseña debe tener al menos ${MINIMO} caracteres`;
  return '';
});

const fecha = (t) => (t ? new Date(t).toLocaleString('es-MX', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
const nombreRol = (v) => ROLES.find((r) => r.v === v)?.t ?? v;

async function cargar() {
  error.value = '';
  try {
    lista.value = await api.get('/auth/usuarios');
  } catch (e) { error.value = e.message; }
}

async function crear() {
  error.value = ''; aviso.value = ''; entregar.value = null;
  if (problema.value) { error.value = problema.value; return; }
  guardando.value = true;
  try {
    const u = await api.post('/auth/usuarios', {
      nombre: nombre.value.trim(),
      correo: correo.value.trim(),
      rol: rol.value,
      clave: clave.value,
    });
    entregar.value = { correo: u.correo, clave: clave.value };
    nombre.value = ''; correo.value = ''; clave.value = ''; rol.value = 'operador';
    await cargar();
  } catch (e) { error.value = e.message; } finally { guardando.value = false; }
}

async function cambiarActivo(u) {
  const accion = u.activo ? 'dar de baja' : 'reactivar';
  if (!confirm(`¿Seguro que quieres ${accion} a ${u.nombre}?`)) return;
  error.value = ''; aviso.value = ''; entregar.value = null;
  try {
    await api.post(`/auth/usuarios/${u.id}/activo`, { activo: !u.activo });
    aviso.value = u.activo ? `${u.nombre} ya no puede entrar.` : `${u.nombre} puede entrar otra vez.`;
    await cargar();
  } catch (e) { error.value = e.message; }
}

async function restablecer(u) {
  if (!confirm(`Se le pone una contraseña nueva a ${u.nombre}. La de antes deja de servir. ¿Continuar?`)) return;
  error.value = ''; aviso.value = ''; entregar.value = null;
  const nueva = inventarClave();
  try {
    await api.post(`/auth/usuarios/${u.id}/clave`, { nueva });
    entregar.value = { correo: u.correo, clave: nueva };
  } catch (e) { error.value = e.message; }
}

onMounted(async () => {
  try { yo.value = (await api.get('/auth/yo')).usuario; } catch { /* la lista ya avisa */ }
  await cargar();
});
</script>

<template>
  <h2>Usuarios</h2>
  <p class="sub">
    Quién entra al portal y qué puede hacer. Dar de baja no borra a nadie: la
    bitácora tiene que poder seguir diciendo quién hizo qué, así que la cuenta
    se apaga y deja de entrar.
  </p>

  <div v-if="error" class="error">{{ error }}</div>
  <div v-if="aviso" class="ok">{{ aviso }}</div>

  <!-- La contraseña se enseña una sola vez y no vuelve a estar disponible:
       en la base sólo queda el hash. -->
  <div v-if="entregar" class="aviso amarillo">
    Contraseña de <strong>{{ entregar.correo }}</strong>:
    <code class="clave">{{ entregar.clave }}</code>
    <br />
    Cópiala ahora y mándasela. No se vuelve a mostrar — de la base sólo sale el
    hash. Que la cambie al entrar, en Mi cuenta.
  </div>

  <div class="caja alta">
    <h3>Dar de alta</h3>
    <form @submit.prevent="crear">
      <div class="campos">
        <div>
          <label for="n">Nombre completo</label>
          <input id="n" v-model="nombre" autocomplete="off" />
        </div>
        <div>
          <label for="c">Correo</label>
          <input id="c" v-model="correo" type="email" placeholder="nombre@empresa.com" autocomplete="off" />
        </div>
        <div>
          <label for="r">Rol</label>
          <select id="r" v-model="rol">
            <option v-for="r in ROLES" :key="r.v" :value="r.v">{{ r.t }}</option>
          </select>
        </div>
        <div>
          <label for="k">Contraseña</label>
          <div class="con-boton">
            <input id="k" v-model="clave" type="text" :placeholder="`mínimo ${MINIMO} caracteres`" autocomplete="off" />
            <button type="button" class="tenue" @click="clave = inventarClave()">Generar</button>
          </div>
        </div>
      </div>
      <p class="tenue-txt">{{ ROLES.find((r) => r.v === rol)?.d }}</p>
      <button :disabled="guardando || Boolean(problema)">
        {{ guardando ? 'Dando de alta…' : 'Dar de alta' }}
      </button>
    </form>
  </div>

  <table>
    <thead>
      <tr><th>Nombre</th><th>Correo</th><th>Rol</th><th>Último acceso</th><th>Estado</th><th></th></tr>
    </thead>
    <tbody>
      <tr v-for="u in lista" :key="u.id" :class="{ apagado: !u.activo }">
        <td>
          <strong>{{ u.nombre }}</strong>
          <span v-if="u.id === yo?.id" class="chip">tú</span>
        </td>
        <td class="tenue-txt">{{ u.correo }}</td>
        <td>{{ nombreRol(u.rol) }}</td>
        <td class="tenue-txt">{{ fecha(u.ultimo_acceso) }}</td>
        <td>
          <span v-if="u.activo" class="chip verde">activo</span>
          <span v-else class="chip rojo">de baja</span>
        </td>
        <td class="acciones">
          <button class="tenue" @click="restablecer(u)">Restablecer contraseña</button>
          <button v-if="u.id !== yo?.id" class="tenue" @click="cambiarActivo(u)">
            {{ u.activo ? 'Dar de baja' : 'Reactivar' }}
          </button>
        </td>
      </tr>
    </tbody>
  </table>
</template>
