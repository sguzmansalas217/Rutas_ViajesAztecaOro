// Cliente HTTP. El token va en cookie httpOnly (lo pone la API) y también en
// memoria para el header Authorization: así funciona igual detrás de Nginx.
let token = sessionStorage.getItem('token') ?? null;

export function fijarToken(t) {
  token = t;
  if (t) sessionStorage.setItem('token', t);
  else sessionStorage.removeItem('token');
}

async function pedir(metodo, ruta, cuerpo, opciones = {}) {
  const cabeceras = {};
  if (token) cabeceras.Authorization = `Bearer ${token}`;

  let body;
  if (cuerpo instanceof FormData) {
    body = cuerpo;
  } else if (cuerpo !== undefined) {
    cabeceras['Content-Type'] = 'application/json';
    body = JSON.stringify(cuerpo);
  }

  const r = await fetch(`/api${ruta}`, { method: metodo, headers: cabeceras, body, credentials: 'include', ...opciones });

  if (r.status === 401) {
    fijarToken(null);
    if (!location.hash.includes('login')) location.hash = '#/login';
    throw new Error('Sesión expirada');
  }

  const datos = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(datos.error ?? `Error ${r.status}`);
  return datos;
}

export const api = {
  get: (ruta) => pedir('GET', ruta),
  post: (ruta, cuerpo) => pedir('POST', ruta, cuerpo),
  put: (ruta, cuerpo) => pedir('PUT', ruta, cuerpo),
};

export const hayToken = () => Boolean(token);
