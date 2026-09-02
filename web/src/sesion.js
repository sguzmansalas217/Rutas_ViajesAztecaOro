// Quién está adentro y qué le toca tocar.
//
// Esto NO es la barrera: la barrera es el API, que trae su exigirRol en cada
// ruta que escribe. Aquí sólo se decide qué se pinta, para no ofrecer botones
// que van a contestar 403 —que es peor que no tenerlos: parece que se puede—.
//
// Se pide una sola vez y se guarda la promesa: el menú, el guardia del router
// y tres pantallas necesitan lo mismo y no tiene caso preguntarlo cuatro veces.
import { ref, computed } from 'vue';
import { api, hayToken } from './api.js';

export const usuario = ref(null);
let pendiente = null;

export async function cargarSesion() {
  if (!hayToken()) { olvidarSesion(); return null; }
  if (!pendiente) {
    pendiente = api.get('/auth/yo')
      .then((r) => { usuario.value = r.usuario; return r.usuario; })
      // Si falla se olvida para que el siguiente intento vuelva a preguntar;
      // si se quedara pegada, un tropiezo de red dejaría el menú vacío.
      .catch(() => { pendiente = null; return null; });
  }
  return pendiente;
}

export function olvidarSesion() {
  usuario.value = null;
  pendiente = null;
}

const rol = computed(() => usuario.value?.rol ?? null);

export const esAdmin = computed(() => rol.value === 'admin');

// 'consulta' entra a mirar y nada más. Es el mismo corte que hace el API con
// exigirRol('admin', 'operador').
export const puedeEditar = computed(() => rol.value === 'admin' || rol.value === 'operador');
