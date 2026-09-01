<script setup>
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { api, fijarToken } from '../api.js';

// El logotipo se importa, no se referencia por ruta: así Vite le pone huella
// en el nombre y el navegador nunca sirve una versión vieja de caché. Va en
// PNG con transparencia porque el original del cliente trae un viñeteado gris
// que sobre el panel oscuro se vería como un recuadro; el recorte lo hace
// web/herramientas/recortar-logo.py a partir del JPG que mandó el cliente.
import logo from '../recursos/logo-azteca.png';

const router = useRouter();
const correo = ref('');
const clave = ref('');
const error = ref('');
const cargando = ref(false);

// Lo que hace el sistema, en la propia pantalla de entrada. No es adorno: al
// portal entran encargados que lo usan de vez en cuando y conviene que la
// primera pantalla diga de qué va.
const PUNTOS = [
  { t: 'Marcajes automáticos por WhatsApp', d: ['M21 11.5a8.4 8.4 0 0 1-12.5 7.3L3 20.5l1.8-5.3A8.4 8.4 0 1 1 21 11.5z'] },
  { t: 'Ubicación validada contra geocercas', d: ['M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 1 1 16 0z', 'M12 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z'] },
  { t: 'Evidencia de cada viaje, con respaldo', d: ['M9 11l2.5 2.5L16 9', 'M20.5 12c0 5-3.6 8.2-8.5 9.5C7.1 20.2 3.5 17 3.5 12V5.8L12 2.5l8.5 3.3z'] },
];

async function entrar() {
  error.value = '';
  cargando.value = true;
  try {
    const r = await api.post('/auth/login', { correo: correo.value, clave: clave.value });
    fijarToken(r.token);
    router.push('/');
  } catch (e) {
    error.value = e.message;
  } finally {
    cargando.value = false;
  }
}
</script>

<template>
  <div class="login">
    <!-- 'marco' y no 'tarjeta': esa clase ya es la de los indicadores del
         tablero y traía fondo blanco, relleno y un hover que aquí sobra. -->
    <div class="marco">
      <!-- Columna del cliente: es su logo y su nombre los que mandan aquí. -->
      <section class="sello">
        <img :src="logo" alt="Viajes Azteca Oro" />
        <h1>Monitoreo de Rutas</h1>
        <p class="razon">Viajes Azteca Oro, S.A. de C.V.</p>
        <hr />
        <ul>
          <li v-for="p in PUNTOS" :key="p.t">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
              <path v-for="(d, k) in p.d" :key="k" :d="d" />
            </svg>
            <span>{{ p.t }}</span>
          </li>
        </ul>
      </section>

      <section class="acceso">
        <form @submit.prevent="entrar">
          <h2>Iniciar sesión</h2>
          <p class="pie-h2">Acceso restringido al personal autorizado.</p>

          <div v-if="error" class="error">{{ error }}</div>

          <label for="correo">Correo</label>
          <input id="correo" v-model="correo" type="email"
                 placeholder="nombre@empresa.com" autocomplete="username" required />

          <label for="clave">Contraseña</label>
          <input id="clave" v-model="clave" type="password"
                 placeholder="••••••••" autocomplete="current-password" required />

          <button :disabled="cargando">{{ cargando ? 'Entrando…' : 'Entrar' }}</button>

          <p class="firma">Nexori System · Sergio Daniel Guzmán Salas</p>
        </form>
      </section>
    </div>
  </div>
</template>
