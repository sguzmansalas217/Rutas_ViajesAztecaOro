// ============================================================================
//  HOJA 'TELEFONOS' DEL EXCEL DEL CLIENTE
//
//  El cliente agregó una pestaña con los números. Es lo único que faltaba para
//  que las asignaciones dejen de caer en 'por_resolver': sin teléfono no hay a
//  dónde mandar el marcaje (ver el orden de precedencia en excel.js).
//
//  Layout real de la hoja (archivo del 3–9 ago 2026, 30 filas de datos):
//
//      A     B                C                 D        E
//      #     RUTA             NOMBRE            UNIDAD   TELEFONO
//      ─── VAO ───                                              ← fila de bloque
//      1     RUTA BALCONES    KEVIN             ECO 32   4921234567
//      6     RUTA CENTRO      JUAN              224      4929876543
//      ─── ORO ───
//      1     ...              KAREN             C-09     4925551122
//
//  Tres cosas que hay que absorber aquí:
//
//   1. 'ECO' es sólo la etiqueta de económico: 'ECO 82' es la unidad 82. Se
//      confirmó cruzando la hoja contra la base (ECO 82 / ARTURO REYES sale en
//      la programación como unidad 82 / ARTURO REYES). No existe una serie ECO.
//   2. Las filas 'VAO' y 'ORO' son encabezados de bloque, no conductores.
//   3. LA HOJA ES UN PADRÓN, NO EL ROL DE LA SEMANA. 'RUTA BALCONES | KEVIN |
//      ECO 32' no coincide con quien maneja esa ruta esa semana. Por eso el
//      teléfono se amarra a la PERSONA (nombre + unidad), nunca a la ruta.
//
//  La llave es nombre + unidad, la misma que usa el importador para el
//  conductor: 'RICARDO' solo aparece 64 veces en unidades distintas y no
//  identifica a nadie. Amarrar sólo por nombre mandaría el WhatsApp al
//  conductor equivocado — en este archivo hay dos OSCAR distintos (unidad 181 y
//  unidad 34). Lo que no case por nombre + unidad se reporta, no se adivina.
// ============================================================================
import { normalizar, partirCelda, claveCanonica, aE164 } from '../dominio/normalizar.js';

/** ¿Es la pestaña de teléfonos? El cliente podría escribirla con acento. */
export function esHojaTelefonos(nombre) {
  return normalizar(nombre).includes('TELEFONO');
}

const COL = { consecutivo: 1, ruta: 2, nombre: 3, unidad: 4, telefono: 5 };

function textoDe(fila, col) {
  const v = fila.getCell(col).value;
  if (v == null) return '';
  if (typeof v === 'object' && !(v instanceof Date)) {
    if (v.richText) return v.richText.map((t) => t.text).join('');
    if (v.text) return String(v.text);
    if (v.result != null) return String(v.result);
  }
  return String(v).trim();
}

/**
 * Unidad de la hoja de teléfonos a la misma clave que usa el importador.
 *
 *   'ECO 41' → '41'     'V-37' → '37' (si fusionarV)     'C-09' → 'C-9'
 *
 * Se pasa por partirCelda para no repetir la lógica de formatos de unidad, y
 * después por claveCanonica para que el lado del teléfono y el lado de la
 * programación hablen de la misma unidad física. Si aquí no se fusionara la
 * serie V, 'MARCO V-37' de la programación y 'MARCO / V-37' de esta hoja
 * quedarían en llaves distintas y el teléfono no se aplicaría.
 */
export function unidadDeHoja(bruto, fusionarV = true) {
  const sinEco = normalizar(bruto).replace(/^ECO\b/, '').trim();
  if (!sinEco) return null;
  const { unidad } = partirCelda(sinEco);
  return unidad ? claveCanonica(unidad, fusionarV) : null;
}

/** Llave del directorio. Mismo criterio que el conductor: nombre + unidad. */
export function llave(nombre, unidad) {
  return `${normalizar(nombre)}|${unidad ?? ''}`;
}

/**
 * Lee la pestaña y devuelve el directorio en memoria.
 *
 * No toca la base: sólo interpreta. Quien aplica los teléfonos es el
 * importador, que es el que sabe qué conductores existen.
 *
 * @returns {{ hoja: string, filas: number, mapa: Map<string, object>,
 *             invalidos: object[], repetidos: object[] }}
 */
export function leerDirectorio(libro, fusionarV = true) {
  const hoja = libro.worksheets.find((h) => esHojaTelefonos(h.name));
  if (!hoja) return null;

  const filas = [];
  for (let nf = 1; nf <= hoja.rowCount; nf++) {
    const f = hoja.getRow(nf);
    const consecutivo = textoDe(f, COL.consecutivo);
    const rutaTexto = textoDe(f, COL.ruta);
    const nombre = normalizar(textoDe(f, COL.nombre));
    const unidadBruta = textoDe(f, COL.unidad);
    const telBruto = textoDe(f, COL.telefono);

    // Fila de bloque ('VAO', 'ORO'): sólo trae texto en B. Se salta; el bloque
    // no cambia a quién pertenece el número, así que ni se guarda.
    if (!consecutivo && rutaTexto && !nombre && !unidadBruta && !telBruto) continue;
    // El consecutivo numérico de la columna A es lo que distingue una fila de
    // datos de los encabezados y de la basura de pie de página.
    if (!/^\d+$/.test(consecutivo)) continue;
    if (!nombre && !telBruto) continue;

    filas.push({
      fila: nf,
      ruta: normalizar(rutaTexto),
      nombre,
      unidadBruta,
      unidad: unidadDeHoja(unidadBruta, fusionarV),
      telBruto,
      telefono: aE164(telBruto),
    });
  }

  // ── Números que no son números ────────────────────────────────────────────
  //  En el archivo real hay uno de 9 dígitos ('493159768'). Le falta un dígito
  //  y no hay forma de adivinar cuál: se reporta con nombre y fila para que se
  //  corrija en el portal o se le pida al cliente. NUNCA se descarta callando.
  const invalidos = filas
    .filter((f) => !f.telefono)
    .map((f) => ({
      fila: f.fila,
      nombre: f.nombre,
      unidad: f.unidadBruta,
      texto: f.telBruto,
      digitos: String(f.telBruto).replace(/\D/g, '').length,
    }));

  // ── Un mismo número en dos filas ──────────────────────────────────────────
  //  conductor.telefono_e164 es UNIQUE, y con razón: el webhook resuelve quién
  //  contestó buscando por número. Dos personas con el mismo número harían
  //  ambiguo el marcaje. Se aplica el primero y el resto se reporta.
  const porNumero = new Map();
  for (const f of filas) {
    if (!f.telefono) continue;
    porNumero.set(f.telefono, [...(porNumero.get(f.telefono) ?? []), f]);
  }
  const repetidos = [...porNumero.entries()]
    .filter(([, v]) => v.length > 1)
    .map(([telefono, v]) => ({
      telefono,
      filas: v.map((x) => ({ fila: x.fila, nombre: x.nombre, unidad: x.unidadBruta })),
    }));

  const mapa = new Map();
  for (const f of filas) {
    if (!f.telefono) continue;
    const k = llave(f.nombre, f.unidad);
    // Si la misma llave viene dos veces, gana la primera: el orden de la hoja
    // es el orden en que el cliente los capturó.
    if (!mapa.has(k)) mapa.set(k, f);
  }

  return { hoja: hoja.name, filas: filas.length, mapa, invalidos, repetidos };
}
