<script setup>
import { computed, ref, onMounted, onUnmounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api, fijarToken, hayToken } from './api.js';
import { usuario, cargarSesion, olvidarSesion } from './sesion.js';

const ruta = useRoute();
const router = useRouter();
const conSesion = computed(() => hayToken() && ruta.path !== '/login');

// Menú agrupado: lo que se usa a diario arriba, lo que se toca de vez en
// cuando abajo. Los iconos son trazos SVG en línea; nada de fuentes externas
// ni CDNs, que el servidor va detrás de Nginx sin salida a internet.
const MENU = [
  {
    grupo: 'Operación',
    items: [
      { a: '/', texto: 'Tablero', d: ['M3 3h7v7H3z', 'M14 3h7v7h-7z', 'M14 14h7v7h-7z', 'M3 14h7v7H3z'] },
      { a: '/por-resolver', texto: 'Por resolver', d: ['M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z', 'M12 9v4', 'M12 17h.01'] },
      { a: '/conductores', texto: 'Conductores', d: ['M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2', 'M9 3a4 4 0 1 1 0 8 4 4 0 0 1 0-8z', 'M23 21v-2a4 4 0 0 0-3-3.9', 'M16 3.1a4 4 0 0 1 0 7.8'] },
    ],
  },
  {
    grupo: 'Administración',
    items: [
      { a: '/unidades', texto: 'Unidades', d: ['M1 3h15v13H1z', 'M16 8h4l3 3v5h-7z', 'M5.5 21a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5z', 'M18.5 21a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5z'] },
      { a: '/carga', texto: 'Cargar Excel', roles: ['admin', 'operador'], d: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'M17 8l-5-5-5 5', 'M12 3v12'] },
      { a: '/filtros', texto: 'Filtros', d: ['M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 1 1 16 0z', 'M12 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z'] },
      { a: '/alertas', texto: 'Alertas', roles: ['admin'], d: ['M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9', 'M13.7 21a2 2 0 0 1-3.4 0'] },
      { a: '/cobro', texto: 'Cobro', roles: ['admin'], d: ['M12 1v22', 'M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6'] },
      { a: '/usuarios', texto: 'Usuarios', roles: ['admin'], d: ['M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2', 'M9 3.5a4 4 0 1 1 0 8 4 4 0 0 1 0-8z', 'M19 8v6', 'M22 11h-6'] },
    ],
  },
];

const contrato = ref(null);

// Los renglones que piden rol se le esconden a quien no lo tiene: le darían 403
// al entrar. El API es el que manda —y el guardia del router tampoco los deja
// abrir a mano—; esto sólo evita ofrecer lo que no se puede.
const menu = computed(() => MENU
  .map((g) => ({ ...g, items: g.items.filter((i) => !i.roles || i.roles.includes(usuario.value?.rol)) }))
  .filter((g) => g.items.length > 0));

const reloj = ref('');
let tic = null;

const iniciales = computed(() => {
  const n = usuario.value?.nombre ?? usuario.value?.correo ?? '';
  const p = n.split(/[\s@.]+/).filter(Boolean);
  return ((p[0]?.[0] ?? '') + (p[1]?.[0] ?? '')).toUpperCase() || '·';
});

function marcarHora() {
  reloj.value = new Date().toLocaleString('es-MX', {
    weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

async function cargarContexto() {
  if (!hayToken()) { olvidarSesion(); contrato.value = null; return; }
  await cargarSesion();
  try { contrato.value = await api.get('/catalogos/contrato'); } catch { contrato.value = null; }
}

// El alcance del contrato cambia desde la pantalla de Unidades: al salir de
// ella se relee para que el indicador de arriba no quede viejo.
watch(() => ruta.path, (nueva, vieja) => {
  if (vieja === '/unidades' && nueva !== '/unidades') cargarContexto();
});
watch(conSesion, (hay) => { if (hay) cargarContexto(); });

onMounted(() => {
  marcarHora();
  tic = setInterval(marcarHora, 30_000);
  cargarContexto();
});
onUnmounted(() => clearInterval(tic));

async function salir() {
  try { await api.post('/auth/salir'); } catch { /* da igual */ }
  fijarToken(null);
  olvidarSesion();
  router.push('/login');
}
</script>

<template>
  <!-- Sin sesión no hay barra lateral ni cabecera y el login pinta la ventana
       completa; la clase le quita el relleno al contenedor para que el
       degradado llegue hasta los bordes. -->
  <div class="app" :class="{ 'sin-sesion': !conSesion }">
    <aside v-if="conSesion" class="lateral">
      <div class="marca">
        <div class="logotipo">N</div>
        <div class="marca-txt">
          <strong>Monitoreo de Rutas</strong>
          <span>Nexori System</span>
        </div>
      </div>

      <nav class="menu">
        <template v-for="g in menu" :key="g.grupo">
          <p class="grupo">{{ g.grupo }}</p>
          <router-link v-for="i in g.items" :key="i.a" :to="i.a" :title="i.texto">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
              <path v-for="(d, k) in i.d" :key="k" :d="d" />
            </svg>
            <span>{{ i.texto }}</span>
          </router-link>
        </template>
      </nav>

      <div class="pie">
        <!-- El bloque del usuario es la entrada a Mi cuenta. No se le pone
             renglón propio en el menú: se toca una vez cada varios meses y
             ahí es donde todo el mundo lo busca. -->
        <router-link to="/cuenta" class="usuario" title="Mi cuenta">
          <div class="avatar">{{ iniciales }}</div>
          <div class="usuario-txt">
            <strong>{{ usuario?.nombre ?? '—' }}</strong>
            <span>{{ usuario?.rol ?? '' }}</span>
          </div>
        </router-link>
        <button class="salir" title="Cerrar sesión" @click="salir">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
            <path d="M16 17l5-5-5-5" /><path d="M21 12H9" />
          </svg>
          <span>Salir</span>
        </button>
      </div>
    </aside>

    <div class="lienzo">
      <header v-if="conSesion" class="superior">
        <div class="cliente">
          <strong>Viajes Azteca Oro, S.A. de C.V.</strong>
          <span>Servicio de monitoreo por WhatsApp</span>
        </div>
        <div class="contexto">
          <router-link v-if="contrato" to="/unidades" class="indicador"
                       :class="contrato.libres === 0 ? 'lleno' : 'hueco'">
            <span class="punto"></span>
            {{ contrato.contratadas }}/{{ contrato.limite }} unidades
          </router-link>
          <span class="reloj">{{ reloj }}</span>
        </div>
      </header>

      <main class="contenido">
        <div class="ancho"><router-view /></div>
      </main>
    </div>
  </div>
</template>
