// ============================================================================
//  Normalización de las celdas del Excel del cliente.
//
//  El archivo real tiene 204 llaves distintas escritas de seis formas distintas
//  ('NOMBRE V-NN', 'NOMBRE NN', 'V-NN NOMBRE', 'NOMBRE C-NN', ...), con alias
//  ('LALO 65' = 'EDUARDO 65'), dedazos ('ERI9K 59') y celdas con dos conductores.
//  Todo eso se resuelve aquí, no en el Excel: el cliente no lo va a modificar.
// ============================================================================

/** Mayúsculas, sin acentos, espacios colapsados. Base de toda comparación. */
export function normalizar(valor) {
  return String(valor ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[,;.]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Texto que no identifica a nadie: encabezados, pies de página, estatus. */
const RUIDO = new Set([
  'LUNES', 'MARTES', 'MIERCOLES', 'JUEVES', 'VIERNES', 'SABADO', 'DOMINGO',
  'CONTROL DE DOCUMENTOS', 'ENCARGADO', 'RUTA', 'NOTA', 'NOTAS',
  'HORA MONITOREO', 'HORA DE MONITOREO', 'PARADA INICIAL', 'SALIDA', 'FORMATO',
]);
const RUIDO_PATRON = /^(PAGINA \d+ DE \d+|CLAVE:.*|REVISION:.*|MONITOREO DE RUTAS.*|TURNO [AB])$/;

export function esRuido(texto) {
  const t = normalizar(texto);
  return t === '' || RUIDO.has(t) || RUIDO_PATRON.test(t);
}

/** Palabras de estatus que el cliente escribe dentro de la celda del conductor. */
const ESTATUS = [
  [/\bCANCELAD[AO]\b/, 'cancelada'],
  [/\bVACACIONES\b/, 'vacaciones'],
  [/\bDESCANSO\b/, 'cancelada'],
];

export function detectarEstatus(texto) {
  const t = normalizar(texto);
  for (const [patron, estado] of ESTATUS) if (patron.test(t)) return estado;
  return null;
}

// Formatos de unidad observados: V-40, C-03, ACM 05, TC 37, 262, 09.
const RE_UNIDAD = /\b(V\s*-\s*\d{1,3}|C\s*-\s*\d{1,3}|ACM\s*\d{1,3}|TC\s*\d{1,3}|\d{1,3})\b/g;

/** Deja la unidad en forma estable: 'V - 21' → 'V-21', '09' → '9'. */
function limpiarUnidad(bruto) {
  const t = normalizar(bruto).replace(/\s*-\s*/, '-').replace(/\s+/g, ' ');
  const conPrefijo = t.match(/^(V|C|ACM|TC)[- ](\d{1,3})$/);
  if (conPrefijo) return `${conPrefijo[1]}-${String(Number(conPrefijo[2]))}`;
  if (/^\d{1,3}$/.test(t)) return String(Number(t));
  return t;
}

/**
 * Separa una celda en { nombre, unidad }.
 *
 * Casos reales cubiertos:
 *   'JUAN CARLOS V-22'            → { nombre: 'JUAN CARLOS', unidad: 'V-22' }
 *   'RICARDO 04'                  → { nombre: 'RICARDO',     unidad: '4'    }
 *   'V-31 JESUS'                  → { nombre: 'JESUS',       unidad: 'V-31' }
 *   'DANIEL V-12 SALIDA 7:00 PM'  → { nombre: 'DANIEL',      unidad: 'V-12' }
 *   'VIRGILIO'                    → { nombre: 'VIRGILIO',    unidad: null   }
 */
export function partirCelda(texto) {
  // Quita coletillas tipo 'SALIDA 7:00 PM' que ensucian la extracción.
  const limpio = normalizar(texto).replace(/\bSALIDA\b.*$/, '').trim();
  if (!limpio) return { nombre: '', unidad: null };

  const encontrados = [...limpio.matchAll(RE_UNIDAD)];
  if (encontrados.length === 0) return { nombre: limpio, unidad: null };

  // Si la unidad viene al principio ('V-31 JESUS') es esa; si no, la última.
  const primera = encontrados[0];
  const elegida = primera.index === 0 ? primera : encontrados[encontrados.length - 1];

  const nombre = (limpio.slice(0, elegida.index) + ' ' + limpio.slice(elegida.index + elegida[0].length))
    .replace(/\s+/g, ' ')
    .trim();

  return { nombre, unidad: limpiarUnidad(elegida[0]) };
}

/**
 * Clave canónica de la unidad para efectos de FACTURACIÓN.
 *
 * `fusionarV` viene del parámetro `importador.fusionar_prefijo_v`. En el archivo
 * real hay 25 números que aparecen con y sin prefijo ('21' y 'V-21'). Tratarlos
 * como unidades distintas infla la factura ~$1,250 al mes con unidades fantasma.
 * La serie 'C-' sí se conserva aparte: es otra serie de la flota.
 */
export function claveCanonica(unidad, fusionarV = true) {
  if (!unidad) return null;
  if (fusionarV && /^V-\d+$/.test(unidad)) return unidad.slice(2);
  return unidad;
}

/** Celdas con dos conductores: 'ARMANDO 63/JUAN F 49'. Solo 3 en el archivo real. */
export function partirMultiples(texto) {
  return normalizar(texto)
    .split('/')
    .map((p) => p.trim())
    .filter((p) => p && !esRuido(p));
}

/** Teléfono mexicano a E.164. Acepta '4921234567', '492 123 4567', '+524921234567'. */
export function aE164(bruto, ladaPais = '52') {
  const digitos = String(bruto ?? '').replace(/\D/g, '');
  if (!digitos) return null;
  if (digitos.length === 10) return `+${ladaPais}${digitos}`;
  if (digitos.length === 12 && digitos.startsWith(ladaPais)) return `+${digitos}`;
  // México a veces se escribe con el 1 después del 52 (formato viejo de WhatsApp).
  if (digitos.length === 13 && digitos.startsWith(`${ladaPais}1`)) return `+${ladaPais}${digitos.slice(3)}`;
  return null;
}
