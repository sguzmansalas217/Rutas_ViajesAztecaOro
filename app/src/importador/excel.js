// ============================================================================
//  IMPORTADOR DEL EXCEL DEL CLIENTE
//
//  El cliente NO va a modificar su archivo: es un documento controlado
//  (FVA-MON-01, Rev. 01/ENE-2024). Toda la suciedad se absorbe aquí.
//
//  Lo que hay que tolerar, verificado contra el archivo real del 3–9 ago 2026:
//   · 5 hojas con DOS layouts distintos y encabezado en fila 5 o 7
//   · el archivo es SEMANAL: columnas F..L = lunes..domingo
//   · horas AM/PM ambiguas: TARDE guarda 1:20 queriendo decir 13:20
//   · filas de sección combinadas dentro de los datos ('FRESNILLO PLC')
//   · 204 llaves de conductor con 6 formatos distintos y alias/dedazos
//   · palabras de estatus en la celda del conductor (CANCELADO, VACACIONES)
//   · 3 celdas con dos conductores separados por '/'
//   · basura de pie de página ('Página 1 de 1', 'Clave: FVA-MON-01')
//
//  Principio rector: LA CARGA NUNCA FALLA. Lo que no se reconoce se guarda
//  como 'por_resolver' y se atiende desde el portal en 5 segundos.
// ============================================================================
import { createHash } from 'node:crypto';
import ExcelJS from 'exceljs';

import { enTransaccion, parametros } from '../db.js';
import { limiteVehiculos } from '../dominio/contrato.js';
import { log } from '../log.js';
import {
  normalizar, esRuido, detectarEstatus, partirCelda,
  partirMultiples, claveCanonica, limpiarUnidad,
} from '../dominio/normalizar.js';
import { leerDirectorio, esHojaTelefonos, llave } from './telefonos.js';

// F es la primera columna de días en las cinco hojas. Antes cada día ocupaba
// una sola columna (F..L, siete columnas fijas); desde el formato acordado en
// la junta del 25-sep-2026 cada día trae DOS columnas —nombre y unidad
// separados—, así que el ancho del bloque ya no es fijo y se detecta por
// contenido (ver detectarDias). PRIMERA_COL_DIA es lo único que sigue fijo.
const PRIMERA_COL_DIA = 6;

/**
 * Configuración por hoja. `pm: true` significa que las horas menores a las 12
 * están guardadas en formato de 12 h y hay que sumarles 12.
 *   TARDE:      1:20 → 13:20   ·  12:45 se queda en 12:45
 *   NOCHE:      9:00 → 21:00
 *   ENTRADA TB: 1:50 → 13:50   (turno B entra por la tarde)
 *
 * La fila del encabezado NO se declara aquí: la busca localizarEncabezado()
 * leyendo el contenido, porque no es la misma en las cinco hojas. La columna
 * de ENCARGADO tampoco: es la primera después del bloque de días, sea cual
 * sea su ancho (detectarDias la calcula sola).
 */
const HOJAS = {
  'MAÑANA':     { turno: 'MANANA',     pm: false, cols: { hora: 2, ruta: 3, nota: 4, parada: 5 } },
  'MANANA':     { turno: 'MANANA',     pm: false, cols: { hora: 2, ruta: 3, nota: 4, parada: 5 } },
  'TARDE':      { turno: 'TARDE',      pm: true,  cols: { hora: 2, ruta: 3, nota: 4, parada: 5 } },
  'NOCHE':      { turno: 'NOCHE',      pm: true,  cols: { hora: 2, ruta: 3, nota: 4, parada: 5 } },
  'ENTRADA TA': { turno: 'ENTRADA_TA', pm: false, cols: { ruta: 2, nota: 3, hora: 4, salida: 5 } },
  'ENTRADA TB': { turno: 'ENTRADA_TB', pm: true,  cols: { ruta: 2, nota: 3, hora: 4, salida: 5 } },
};

// ── Lectura de celdas ───────────────────────────────────────────────────────

function textoDe(celda) {
  const v = celda?.value;
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    if (v.richText) return v.richText.map((t) => t.text).join('');
    if (v.text) return String(v.text);
    if (v.result != null) return String(v.result);
  }
  return String(v);
}

/**
 * Convierte el valor de hora del Excel a 'HH:MM:SS' aplicando el turno.
 * ExcelJS entrega las horas como Date en UTC (epoch 1899), por eso se leen
 * los componentes UTC y no los locales.
 */
function horaDe(celda, esPm) {
  const v = celda?.value;
  if (v == null) return null;

  let h;
  let m;
  if (v instanceof Date) {
    h = v.getUTCHours();
    m = v.getUTCMinutes();
  } else if (typeof v === 'number' && v > 0 && v < 1) {
    const total = Math.round(v * 24 * 60);
    h = Math.floor(total / 60);
    m = total % 60;
  } else {
    const t = String(v).match(/(\d{1,2}):(\d{2})/);
    if (!t) return null;
    h = Number(t[1]);
    m = Number(t[2]);
  }

  // Un valor guardado como 12:45 en una hoja PM ya es 12:45 PM: no se toca.
  if (esPm && h < 12) h += 12;
  if (h > 23) h -= 24;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;
}

// Excel a veces guarda una fecha como número de serie crudo en vez de tipo
// fecha —pasa al copiar/pegar una celda sin conservar formato, o al duplicar
// una columna a mano—. 25000-60000 cubre 1968-2064, ancho de sobra para no
// confundir un número de serie con una unidad (las unidades del archivo real
// no pasan de 3 dígitos).
function comoFecha(v) {
  if (v instanceof Date) return v;
  if (typeof v === 'number' && v > 25000 && v < 60000) {
    return new Date(Date.UTC(1899, 11, 30) + v * 86400000);
  }
  return null;
}

const fechaISO = (v) => `${v.getUTCFullYear()}-${String(v.getUTCMonth() + 1).padStart(2, '0')}-${String(v.getUTCDate()).padStart(2, '0')}`;

/**
 * Arma el bloque de días de una fila, columna por columna desde
 * PRIMERA_COL_DIA, y se detiene en la primera que no sea fecha —ahí empieza
 * ENCARGADO, tenga rótulo o no—.
 *
 * Cada día puede venir en UNA columna (formato viejo: 'NOMBRE UNIDAD' junto)
 * o en DOS (formato nuevo, acordado en la junta del 25-sep-2026: nombre y
 * unidad separados). Se detecta solo: si la columna siguiente trae la MISMA
 * fecha, es la mitad derecha del mismo día, no el día siguiente. No se asume
 * un ancho fijo para no tener que tocar código el día que el cliente termine
 * de convertir todas sus hojas —puede haber una mezcla mientras tanto—.
 *
 * @returns {{ colNombre: number, colUnidad: number, fecha: string }[]}
 */
function detectarDias(hoja, filaFechas) {
  const fila = hoja.getRow(filaFechas);
  const dias = [];
  let c = PRIMERA_COL_DIA;
  while (c <= hoja.columnCount) {
    const v = comoFecha(fila.getCell(c).value);
    if (!v) break;
    const siguiente = comoFecha(fila.getCell(c + 1).value);
    const esPar = siguiente && fechaISO(siguiente) === fechaISO(v);
    dias.push({ colNombre: c, colUnidad: esPar ? c + 1 : c, fecha: fechaISO(v) });
    c += esPar ? 2 : 1;
  }
  return dias;
}

/**
 * Las fechas de la semana NO están en la misma fila en las cinco hojas:
 *
 *   ENTRADA TA/TB → fila 5: 'RUTA | NOTA | HORA | SALIDA | 03-ago | 04-ago | …'
 *                            (etiquetas y fechas comparten fila)
 *   MAÑANA/NOCHE  → fila 4: las fechas
 *                   fila 5: 'HORA MONITOREO | RUTA | … | LUNES | MARTES | …'
 *   TARDE         → lo mismo, pero corrido dos filas (6 y 7)
 *
 * Fijar el número de fila fue un error: tres hojas quedaban fuera y el
 * archivo se importaba a medias sin avisar. Se buscan por contenido, que
 * además aguanta que el cliente inserte una fila de logo o de firma.
 */
function localizarEncabezado(hoja) {
  const limite = Math.min(hoja.rowCount, 20);
  let filaFechas = 0;
  let filaEtiquetas = 0;
  let dias = [];

  for (let nf = 1; nf <= limite; nf++) {
    const fila = hoja.getRow(nf);

    // ¿Es la fila de fechas? Se exigen al menos 4 días para no confundirla
    // con una celda suelta con fecha.
    if (!filaFechas) {
      const candidatos = detectarDias(hoja, nf);
      if (candidatos.length >= 4) {
        filaFechas = nf;
        dias = candidatos;
      }
    }

    // ¿Es la fila de etiquetas? Lleva 'RUTA' en las primeras columnas.
    if (!filaEtiquetas) {
      for (let c = 2; c <= 4; c++) {
        if (normalizar(textoDe(fila.getCell(c))) === 'RUTA') { filaEtiquetas = nf; break; }
      }
    }
  }

  const fechas = Object.fromEntries(dias.map((d) => [d.colNombre, d.fecha]));
  // La columna de ENCARGADO es la primera después del bloque de días —tenga
  // rótulo o no: ENTRADA TA/TB no lo escriben, pero el dato sí está ahí—.
  const colEncargado = dias.length ? dias[dias.length - 1].colUnidad + 1 : null;

  // Los datos empiezan después de la última de las dos, sean cuales sean.
  const ultima = Math.max(filaFechas, filaEtiquetas);
  return { fechas, dias, colEncargado, filaFechas, filaEtiquetas, primeraFilaDatos: ultima + 1 };
}

/**
 * Una fila de sección ('FRESNILLO PLC', 'EXTRAS JUANICIPIO (VAO)') es la que
 * tiene texto en B pero ni hora ni conductores. Rompe el parseo lineal ingenuo:
 * hay que reconocerla y usarla como etiqueta de las filas siguientes.
 */
function esFilaSeccion(fila, cfg, dias) {
  const hayConductores = dias.some(
    (d) => textoDe(fila.getCell(d.colNombre)).trim() !== '' || textoDe(fila.getCell(d.colUnidad)).trim() !== '',
  );
  if (hayConductores) return false;
  const hora = fila.getCell(cfg.cols.hora).value;
  const b = normalizar(textoDe(fila.getCell(2)));
  return !hora && b.length > 2 && !esRuido(b);
}

// ── Resolución de catálogos ─────────────────────────────────────────────────

/**
 * Resuelve (o da de alta) el vehículo a partir de la clave leída.
 * `fusionarV` decide si '21' y 'V-21' son la misma unidad. AFECTA LA FACTURA:
 * en el archivo real hay 25 números que aparecen de las dos formas.
 */
async function resolverVehiculo(cliente, unidad, fusionarV, memo) {
  if (!unidad) return null;
  const alias = unidad;
  if (memo.vehiculos.has(alias)) return memo.vehiculos.get(alias);

  const existente = await cliente.query(
    `SELECT va.vehiculo_id, v.contratado
       FROM vehiculo_alias va JOIN vehiculo v ON v.id = va.vehiculo_id
      WHERE va.alias = $1`,
    [alias],
  );
  if (existente.rowCount) {
    const r = { id: existente.rows[0].vehiculo_id, contratado: existente.rows[0].contratado };
    memo.vehiculos.set(alias, r);
    return r;
  }

  const canonica = claveCanonica(unidad, fusionarV);
  const { rows } = await cliente.query(
    `INSERT INTO vehiculo (clave) VALUES ($1)
     ON CONFLICT (clave) DO UPDATE SET clave = EXCLUDED.clave
     RETURNING id`,
    [canonica],
  );
  const id = rows[0].id;

  await cliente.query(
    `INSERT INTO vehiculo_alias (alias, vehiculo_id, origen)
     VALUES ($1, $2, 'importador') ON CONFLICT (alias) DO NOTHING`,
    [alias, id],
  );
  // Una unidad nueva NUNCA entra contratada por sí sola con solo aparecer en
  // el Excel: el contrato cubre un número fijo y el archivo trae muchas más.
  // Si SÍ está dada de alta en TELEFONOS, es distinto —esa hoja es el padrón
  // de lo que de verdad se monitorea— y se contrata sola más abajo, en
  // importarExcel.
  const r = { id, contratado: false, nuevo: true, clave: canonica };
  memo.vehiculos.set(alias, r);
  return r;
}

/**
 * Si esta unidad está dada de alta en TELEFONOS y todavía no está en el
 * contrato, se contrata sola —siempre que haya lugar—. TELEFONOS es el
 * padrón de lo que de verdad se monitorea (justo lo mismo que decide qué
 * conductores se procesan, ver la puerta más abajo), así que tiene sentido
 * que también decida qué unidades entran, sin depender de que alguien vaya
 * a la pantalla de Unidades a darle clic a cada una.
 *
 * El WHERE ya trae la cuenta de contratadas < límite: si no hay lugar, no
 * intenta —se queda 'fuera_contrato' como cualquier otra, y el operador
 * decide a mano cuál sale para que ésta entre—. Nunca revienta el tope.
 */
async function contratarSiEsDeTelefonos(cliente, vehiculo, limite, memo) {
  if (!vehiculo || vehiculo.contratado || memo.contratoIntentado.has(vehiculo.id)) return;
  memo.contratoIntentado.add(vehiculo.id);

  const { rowCount } = await cliente.query(
    `UPDATE vehiculo SET contratado = true, contratado_en = now()
      WHERE id = $1 AND NOT contratado
        AND (SELECT count(*) FROM vehiculo WHERE contratado) < $2`,
    [vehiculo.id, limite],
  );
  if (rowCount) vehiculo.contratado = true;
}

/**
 * Escribe el teléfono de un conductor. La hoja TELEFONOS del Excel manda: si
 * el cliente le cambió el número ahí, aquí se pisa el que hubiera en el
 * sistema. Nunca al revés —un número editado a mano en el portal se pierde en
 * la siguiente carga, a propósito—. El teléfono correcto vive en el Excel.
 *
 * La guarda del NOT EXISTS evita reventar contra el UNIQUE de telefono_e164.
 * No es paranoia: el Excel genera VARIOS registros de conductor para la misma
 * persona cuando la celda viene escrita distinto ('DANIEL V-12' y 'DANIEL V-12
 * SALIDA 7:00 PM' son dos registros). Los dos casan con la misma fila de la
 * hoja de teléfonos y el segundo chocaría. Si se dejara al UNIQUE reventar,
 * la excepción abortaría TODA la transacción y la carga entera se perdería —
 * justo lo contrario del principio rector de este importador.
 *
 * Se prefiere el registro con más asignaciones, que es el bueno; el otro se
 * reporta como duplicado para que se atienda desde el portal.
 *
 * @returns {'aplicado'|'igual'|'duplicado'}
 */
async function aplicarTelefono(cliente, conductorId, telefono) {
  const actual = await cliente.query(
    'SELECT telefono_e164 FROM conductor WHERE id = $1',
    [conductorId],
  );
  if (actual.rows[0]?.telefono_e164 === telefono) return 'igual';

  const { rowCount } = await cliente.query(
    `UPDATE conductor
        SET telefono_e164 = $2, actualizado_en = now()
      WHERE id = $1
        AND NOT EXISTS (SELECT 1 FROM conductor o WHERE o.id <> $1 AND o.telefono_e164 = $2)`,
    [conductorId, telefono],
  );
  return rowCount ? 'aplicado' : 'duplicado';
}

/**
 * Resuelve el conductor por el texto COMPLETO de la celda: 'RICARDO' aparece 64
 * veces en unidades distintas, así que el nombre solo no identifica a nadie.
 * La llave real es nombre + unidad — salvo que el nombre sea único en el
 * padrón, en cuyo caso una unidad nueva es la misma persona que cambió de
 * unidad, no alguien más (ver el mismo criterio en la puerta de TELEFONOS,
 * más arriba en importarExcel).
 *
 * Si la hoja TELEFONOS trae el número de ese nombre (+ unidad, o solo nombre
 * si es único), se le pone aquí mismo. Tiene que ser en este punto y no
 * después: `completo` es lo que decide unas líneas más abajo si la
 * asignación nace 'programada' o 'por_resolver', y en una base vacía el
 * conductor se está creando en esta misma llamada.
 *
 * Si no hay número, se da de alta SIN teléfono y la asignación queda
 * 'por_resolver'.
 */
async function resolverConductor(cliente, textoCelda, nombre, unidad, crear, memo, tels) {
  const alias = normalizar(textoCelda);
  if (!alias) return { id: null, completo: false };
  if (memo.conductores.has(alias)) return memo.conductores.get(alias);

  // La fila de la hoja de teléfonos que le toca a esta celda, si existe. Si
  // no hay una exacta por unidad pero el nombre no se repite en el padrón,
  // se usa esa —es la misma persona, la unidad de su fila ya no es la de hoy—.
  const k = llave(nombre, unidad);
  let delDirectorio = tels?.dir?.mapa.get(k) ?? null;
  if (!delDirectorio && tels) {
    const porNombre = tels.dir.porNombre.get(nombre);
    if (porNombre?.length === 1) delDirectorio = porNombre[0];
  }
  const kDirectorio = delDirectorio ? llave(delDirectorio.nombre, delDirectorio.unidad) : null;

  const existente = await cliente.query(
    `SELECT c.id, c.telefono_e164 IS NOT NULL AS completo
       FROM conductor_alias a JOIN conductor c ON c.id = a.conductor_id
      WHERE a.alias = $1`,
    [alias],
  );

  let id;
  let completo;
  let nuevo = false;

  if (existente.rowCount) {
    id = existente.rows[0].id;
    completo = existente.rows[0].completo;
  } else {
    // Antes de dar de alta a alguien nuevo: ¿ya hay un conductor con este
    // nombre, SIN que nadie más lo comparta? Si sí, es la misma persona en
    // otra unidad —se reusa su registro— en vez de duplicarlo. Si el nombre
    // es ambiguo (dos o más), no hay de otra que darlo de alta aparte: es
    // justo el caso de los dos OSCAR, adivinar mal manda el WhatsApp a quien
    // no es.
    const homonimos = await cliente.query(
      'SELECT id, telefono_e164 IS NOT NULL AS completo FROM conductor WHERE upper(nombre) = upper($1)',
      [nombre],
    );
    if (nombre && homonimos.rowCount === 1) {
      id = homonimos.rows[0].id;
      completo = homonimos.rows[0].completo;
      await cliente.query(
        `INSERT INTO conductor_alias (alias, conductor_id, origen)
         VALUES ($1, $2, 'importador') ON CONFLICT (alias) DO NOTHING`,
        [alias, id],
      );
    } else {
      if (!crear) return { id: null, completo: false };
      const { rows } = await cliente.query(
        'INSERT INTO conductor (nombre) VALUES ($1) RETURNING id',
        [nombre || alias],
      );
      id = rows[0].id;
      await cliente.query(
        `INSERT INTO conductor_alias (alias, conductor_id, origen)
         VALUES ($1, $2, 'importador') ON CONFLICT (alias) DO NOTHING`,
        [alias, id],
      );
      nuevo = true;
    }
    completo = completo ?? false;
  }

  if (delDirectorio) {
    const r = await aplicarTelefono(cliente, id, delDirectorio.telefono);
    tels.aplicadas.add(kDirectorio);
    if (r === 'aplicado') {
      completo = true;
      tels.reporte.aplicados++;
    } else if (r === 'igual') {
      completo = true;
      tels.reporte.yaTenian++;
    } else {
      tels.reporte.duplicados.push({
        nombre, unidad, telefono: delDirectorio.telefono, alias,
      });
    }
  }

  const r = { id, completo, ...(nuevo ? { nuevo: true } : {}) };
  memo.conductores.set(alias, r);
  return r;
}

async function resolverRuta(cliente, { nombre, turno, hora, salida, parada, seccion, encargado }, memo) {
  const llave = `${turno}|${nombre}|${hora}`;
  if (memo.rutas.has(llave)) return memo.rutas.get(llave);

  const { rows } = await cliente.query(
    `INSERT INTO ruta (nombre, turno, hora_monitoreo, hora_salida, parada_inicial, seccion, encargado)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (nombre, turno, hora_monitoreo) DO UPDATE
       SET hora_salida    = COALESCE(EXCLUDED.hora_salida, ruta.hora_salida),
           parada_inicial = COALESCE(EXCLUDED.parada_inicial, ruta.parada_inicial),
           seccion        = COALESCE(EXCLUDED.seccion, ruta.seccion),
           encargado      = COALESCE(EXCLUDED.encargado, ruta.encargado)
     RETURNING id`,
    [nombre, turno, hora, salida, parada, seccion, encargado],
  );
  memo.rutas.set(llave, rows[0].id);
  return rows[0].id;
}

// ── Importación ─────────────────────────────────────────────────────────────

/**
 * Lee el archivo y vuelca todo a base de datos dentro de una sola transacción.
 * Idempotente por hash: volver a subir el mismo archivo no duplica nada.
 *
 * @param {Buffer} buffer  contenido del .xlsx
 * @param {string} nombreArchivo
 * @param {number|null} usuarioId
 */
export async function importarExcel(buffer, nombreArchivo, usuarioId = null) {
  const hash = createHash('sha256').update(buffer).digest('hex');
  const p = await parametros();
  const fusionarV = p['importador.fusionar_prefijo_v'] !== false;
  const crearConductores = p['importador.crear_conductores'] !== false;
  const limite = await limiteVehiculos();

  const libro = new ExcelJS.Workbook();
  await libro.xlsx.load(buffer);

  const reporte = {
    hojas: {},
    leidas: 0,
    resueltas: 0,
    pendientes: 0,
    fueraContrato: 0,       // unidades del archivo que no cubre el contrato
    fueraDeTelefonos: 0,    // conductores que ni se procesan: no están en TELEFONOS
    conductoresNuevos: [],
    unidadesNuevas: [],
    sinUnidad: [],
    multiples: [],
    ignoradas: [],
    reemplazadas: 0,        // filas que este archivo dejó fuera (cambio del cliente)
    marcajesCancelados: 0,  // marcajes de esas filas que aún no salían
    fusionPrefijoV: fusionarV,
    // Resumen de la pestaña TELEFONOS. Queda en null si el archivo no la trae:
    // así se distingue 'el cliente no mandó la hoja' de 'la mandó vacía'.
    telefonos: null,
  };

  // La hoja de teléfonos se lee ANTES que las de programación. El teléfono es
  // lo que decide si una asignación nace 'programada', y en una base vacía el
  // conductor se crea al vuelo leyendo la programación: si el directorio no
  // estuviera cargado ya, la primera carga dejaría todo en 'por_resolver'.
  const dir = leerDirectorio(libro, fusionarV);
  if (dir) {
    reporte.telefonos = {
      hoja: dir.hoja,
      filas: dir.filas,
      aplicados: 0,      // números que se escribieron en un conductor
      yaTenian: 0,       // el conductor ya tenía ese mismo número, sin cambio
      invalidos: dir.invalidos,   // no son un teléfono válido (dígitos de más/menos)
      repetidos: dir.repetidos,   // el mismo número en dos filas de la hoja
      duplicados: [],    // el número ya lo tiene otro registro de la misma persona
      sinAmarre: [],     // no hay ningún conductor con ese nombre + unidad
    };
  }
  // `aplicadas` lleva las llaves ya atendidas para saber, al final, cuáles
  // filas de la hoja se quedaron sin dueño.
  const tels = dir ? { dir, reporte: reporte.telefonos, aplicadas: new Set() } : null;

  return enTransaccion(async (cliente) => {
    const carga = await cliente.query(
      `INSERT INTO carga (archivo, hash_archivo, subido_por) VALUES ($1, $2, $3) RETURNING id`,
      [nombreArchivo, hash, usuarioId],
    );
    const cargaId = carga.rows[0].id;
    const memo = {
      vehiculos: new Map(), conductores: new Map(), rutas: new Map(),
      contratoIntentado: new Set(),
    };
    // Los id de asignación que trae este archivo. Al final, lo que exista en
    // las mismas fechas y no esté en este conjunto se da por reemplazado.
    const vigentes = new Set();
    let minFecha = null;
    let maxFecha = null;

    // El teléfono de la hoja TELEFONOS de ESTE archivo manda, sin excepción:
    // se borran TODOS los que hay en base y se repueblan sólo con lo que trae
    // esta hoja. Antes un número de prueba de una carga vieja se quedaba vivo
    // para siempre porque nunca volvía a aparecer en TELEFONOS para pisarlo —
    // acordado así en la junta del 25 sep 2026, es más agresivo que sólo
    // sincronizar los que coinciden. Sin hoja TELEFONOS (tels es null) no se
    // toca nada: no hay con qué repoblar.
    if (tels) await cliente.query('UPDATE conductor SET telefono_e164 = NULL WHERE telefono_e164 IS NOT NULL');

    for (const hoja of libro.worksheets) {
      const cfg = HOJAS[normalizar(hoja.name)] ?? HOJAS[hoja.name];
      if (!cfg) {
        // TELEFONOS no es una hoja ignorada: ya se leyó arriba y tiene su
        // propio apartado en el reporte. Listarla ahí asustaba sin motivo.
        if (!esHojaTelefonos(hoja.name)) reporte.ignoradas.push(hoja.name);
        continue;
      }

      const { fechas, dias, colEncargado, primeraFilaDatos } = localizarEncabezado(hoja);
      if (Object.keys(fechas).length === 0) {
        reporte.ignoradas.push(`${hoja.name} (no se encontró la fila de fechas)`);
        continue;
      }
      for (const f of Object.values(fechas)) {
        if (!minFecha || f < minFecha) minFecha = f;
        if (!maxFecha || f > maxFecha) maxFecha = f;
      }

      let seccion = null;
      let enHoja = 0;

      for (let nf = primeraFilaDatos; nf <= hoja.rowCount; nf++) {
        const fila = hoja.getRow(nf);

        if (esFilaSeccion(fila, cfg, dias)) {
          seccion = normalizar(textoDe(fila.getCell(2)));
          continue;
        }

        const nombreRuta = normalizar(textoDe(fila.getCell(cfg.cols.ruta)));
        const hora = horaDe(fila.getCell(cfg.cols.hora), cfg.pm);
        if (!nombreRuta || esRuido(nombreRuta) || !hora) continue;

        const rutaId = await resolverRuta(cliente, {
          nombre: nombreRuta,
          turno: cfg.turno,
          hora,
          salida: cfg.cols.salida ? horaDe(fila.getCell(cfg.cols.salida), cfg.pm) : null,
          parada: cfg.cols.parada ? textoDe(fila.getCell(cfg.cols.parada)).trim() || null : null,
          seccion,
          encargado: colEncargado ? normalizar(textoDe(fila.getCell(colEncargado))) || null : null,
        }, memo);

        for (const dia of dias) {
          const { colNombre, colUnidad, fecha } = dia;
          if (!fecha) continue;
          const col = colNombre; // ancla para reportes ('celda': F12, etc.)

          // Si el día ya viene partido (formato acordado en la junta del
          // 25-sep-2026), la unidad es un DATO de su propia columna, no una
          // adivinanza: no pasa por partirCelda(). El formato viejo —un día,
          // una celda— sigue funcionando exactamente igual que antes.
          const yaPartido = colUnidad !== colNombre;
          const textoNombreCelda = textoDe(fila.getCell(colNombre)).trim();
          const textoUnidadCelda = yaPartido ? textoDe(fila.getCell(colUnidad)).trim() : '';
          const crudo = yaPartido ? `${textoNombreCelda} ${textoUnidadCelda}`.trim() : textoNombreCelda;
          if (!crudo || esRuido(crudo)) continue;

          // Una celda puede traer dos conductores: 'ARMANDO 63/JUAN F 49'
          // (formato viejo) o 'ARMANDO/JUAN F' + '63/49' en columnas
          // separadas (formato nuevo, misma idea, una unidad por nombre).
          let partes;
          if (yaPartido && (textoNombreCelda.includes('/') || textoUnidadCelda.includes('/'))) {
            const nombres = partirMultiples(textoNombreCelda);
            const unidades = textoUnidadCelda.split('/').map((u) => u.trim()).filter(Boolean);
            partes = nombres.map((n, i) => ({
              texto: `${n} ${unidades[i] ?? ''}`.trim(),
              conocido: true,
              nombreConocido: normalizar(n),
              unidadConocida: unidades[i] ? limpiarUnidad(unidades[i]) : null,
            }));
          } else if (yaPartido) {
            partes = [{
              texto: normalizar(crudo),
              conocido: true,
              nombreConocido: normalizar(textoNombreCelda),
              unidadConocida: textoUnidadCelda ? limpiarUnidad(textoUnidadCelda) : null,
            }];
          } else {
            const brutos = crudo.includes('/') ? partirMultiples(crudo) : [normalizar(crudo)];
            partes = brutos.map((texto) => ({ texto, conocido: false, nombreConocido: null, unidadConocida: null }));
          }
          if (partes.length > 1) {
            reporte.multiples.push({ hoja: hoja.name, celda: `${colLetra(col)}${nf}`, texto: crudo });
          }

          for (const { texto: parte, conocido, nombreConocido, unidadConocida } of partes) {
            const estatus = detectarEstatus(parte);
            // Con el día ya partido, nombre y unidad son datos de sus propias
            // columnas: no hay nada que adivinar. partirCelda() sólo entra
            // cuando el día sigue en el formato viejo (una celda).
            const guess = conocido ? null : partirCelda(parte);
            const nombre = conocido ? nombreConocido : guess.nombre;
            const unidad = conocido ? unidadConocida : guess.unidad;
            const unidadCanon = claveCanonica(unidad, fusionarV);

            // TELEFONOS es el padrón de a quién de verdad se monitorea. El
            // Excel del cliente trae cientos de rutas ajenas al contrato —sin
            // este filtro cada una nace conductor y asignación 'por_resolver'
            // que nadie va a atender nunca, y el tablero se llena de gente que
            // no es del servicio. Si el archivo no trae hoja TELEFONOS no hay
            // padrón contra qué filtrar, así que se procesa todo como antes.
            //
            // El conductor puede cambiar de unidad sin ser un conductor
            // nuevo: si su nombre no se repite en el padrón (nadie más se
            // llama igual), entra aunque la unidad de esta celda no sea la
            // que trae su fila de TELEFONOS. Si el nombre sí se repite, no
            // hay de otra que exigir la unidad exacta.
            const enTelefonos = tels && (
              tels.dir.mapa.has(llave(nombre, unidadCanon))
              || tels.dir.porNombre.get(nombre)?.length === 1
            );
            if (tels && !enTelefonos) {
              reporte.fueraDeTelefonos++;
              continue;
            }

            reporte.leidas++;

            let vehiculo = null;
            let conductor = { id: null, completo: false };

            if (!estatus) {
              vehiculo = await resolverVehiculo(cliente, unidad, fusionarV, memo);
              // Está en TELEFONOS —si no, ni habríamos llegado aquí—, así que
              // se contrata sola en vez de esperar a que alguien le dé clic
              // en Unidades. Sin hoja TELEFONOS (tels es null) no hay padrón
              // que lo respalde, y se deja el comportamiento manual de siempre.
              if (tels) await contratarSiEsDeTelefonos(cliente, vehiculo, limite, memo);
              conductor = await resolverConductor(
                cliente, parte, nombre, unidadCanon,
                crearConductores, memo, tels,
              );
              // Un conductor sale en varias celdas de la semana: el reporte
              // lista nombres, no apariciones.
              if (conductor.nuevo && !reporte.conductoresNuevos.includes(parte)) {
                reporte.conductoresNuevos.push(parte);
              }
              // Unidades que nunca se habían visto: el operador tiene que
              // decidir si alguna entra al contrato (y cuál sale).
              if (vehiculo?.nuevo && !reporte.unidadesNuevas.includes(vehiculo.clave)) {
                reporte.unidadesNuevas.push(vehiculo.clave);
              }
              if (!unidad) reporte.sinUnidad.push({ hoja: hoja.name, celda: `${colLetra(col)}${nf}`, texto: parte });
            }

            // Orden de precedencia, de más fuerte a más débil:
            //   1. Lo que dice la celda (CANCELADO, VACACIONES): lo puso el
            //      cliente y manda sobre todo lo demás.
            //   2. Unidad fuera del contrato: aunque tuviera teléfono, no se
            //      le manda nada. Es el límite de alcance.
            //   3. Sin teléfono: no hay a dónde mandar, queda por resolver.
            let estado;
            if (estatus) estado = estatus;
            else if (!vehiculo?.contratado) estado = 'fuera_contrato';
            else if (conductor.completo) estado = 'programada';
            else estado = 'por_resolver';

            if (estado === 'programada') reporte.resueltas++;
            else if (estado === 'por_resolver') reporte.pendientes++;
            else if (estado === 'fuera_contrato') reporte.fueraContrato++;

            const guardada = await cliente.query(
              `INSERT INTO asignacion
                 (carga_id, fecha, ruta_id, vehiculo_id, conductor_id, texto_origen, hoja, celda, estado)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
               ON CONFLICT (fecha, ruta_id, texto_origen) DO UPDATE
                 SET carga_id     = EXCLUDED.carga_id,
                     vehiculo_id  = EXCLUDED.vehiculo_id,
                     conductor_id = EXCLUDED.conductor_id,
                     hoja         = EXCLUDED.hoja,
                     celda        = EXCLUDED.celda,
                     estado       = EXCLUDED.estado
               RETURNING id`,
              [cargaId, fecha, rutaId, vehiculo?.id ?? null, conductor.id, parte, hoja.name,
               `${colLetra(col)}${nf}`, estado],
            );
            // Se anota qué filas trae ESTE archivo. Lo que quede de las mismas
            // fechas y no esté aquí es algo que el cliente quitó o cambió.
            vigentes.add(guardada.rows[0].id);
            enHoja++;
          }
        }
      }
      reporte.hojas[hoja.name] = enHoja;
    }

    // ── Filas del padrón que no salieron en la programación de esta semana ──
    //  La hoja TELEFONOS es un padrón, no el rol: trae gente que esta semana
    //  no maneja. Si esa persona ya existe de una carga anterior, su número se
    //  sincroniza aquí —se pise o no el que ya tenía—. Se busca por nombre +
    //  unidad contra el histórico de asignaciones, que es lo único que amarra
    //  una persona a una unidad.
    if (tels) {
      for (const [k, f] of tels.dir.mapa) {
        if (tels.aplicadas.has(k)) continue;

        const { rows } = await cliente.query(
          `SELECT c.id, count(*) AS asignaciones
             FROM conductor c
             JOIN asignacion a ON a.conductor_id = c.id
             JOIN vehiculo   v ON v.id = a.vehiculo_id
            WHERE upper(c.nombre) = $1
              AND v.clave = $2
            GROUP BY c.id
            ORDER BY count(*) DESC, c.id`,
          [f.nombre, f.unidad],
        );

        if (!rows.length) {
          // Nadie con ese nombre en esa unidad. Puede ser un conductor que
          // todavía no aparece en ningún Excel, o que el cliente escribió la
          // unidad distinto. Se reporta para resolverlo desde el portal.
          reporte.telefonos.sinAmarre.push({
            fila: f.fila, nombre: f.nombre, unidad: f.unidadBruta, telefono: f.telefono,
          });
          continue;
        }

        const estado = await aplicarTelefono(cliente, rows[0].id, f.telefono);
        if (estado === 'aplicado') reporte.telefonos.aplicados++;
        else if (estado === 'igual') reporte.telefonos.yaTenian++;
        else reporte.telefonos.duplicados.push({
          nombre: f.nombre, unidad: f.unidadBruta, telefono: f.telefono,
        });

        // Los demás registros con el mismo nombre + unidad son la misma
        // persona escrita distinto en el Excel. No pueden compartir número
        // (UNIQUE) y se listan para fusionarlos a mano.
        for (const otro of rows.slice(1)) {
          reporte.telefonos.duplicados.push({
            nombre: f.nombre, unidad: f.unidadBruta, telefono: f.telefono, conductorId: otro.id,
          });
        }
      }

      // Un teléfono aplicado en la pasada de arriba llega tarde: la asignación
      // ya se guardó como 'por_resolver'. Se reevalúan las de ESTA carga.
      // Sólo se toca 'por_resolver': 'cancelada', 'vacaciones' y
      // 'fuera_contrato' mandan sobre el teléfono y no se pisan.
      const { rowCount: rescatadas } = await cliente.query(
        `UPDATE asignacion a
            SET estado = 'programada'
           FROM conductor c, vehiculo v
          WHERE a.carga_id = $1
            AND a.estado = 'por_resolver'
            AND c.id = a.conductor_id
            AND v.id = a.vehiculo_id
            AND v.contratado
            AND c.telefono_e164 IS NOT NULL`,
        [cargaId],
      );
      reporte.resueltas += rescatadas;
      reporte.pendientes -= rescatadas;
    }

    // ── Lo que el cliente quitó o cambió ─────────────────────────────────────
    //  El archivo se carga todos los días. Las celdas que no cambiaron ya se
    //  actualizaron en su sitio (misma fila, mismos marcajes: la llave UNIQUE
    //  de asignación se encarga). Pero cuando el cliente CAMBIA un conductor,
    //  el texto de la celda cambia y la llave ya no casa: entra una fila nueva
    //  y la vieja se quedaba viva y programada. El conductor que ya no maneja
    //  esa ruta seguía recibiendo el WhatsApp y se pagaba la plantilla.
    //
    //  Aquí se retira lo que ya no viene en el archivo, acotado a las fechas
    //  que este archivo cubre: subir la semana que entra no toca la anterior.
    // La guarda del leidas > 0 no sobra: si el archivo llegara vacío o con las
    // hojas ilegibles, sin ella se daría de baja la semana entera de un golpe.
    //
    //  Nunca hacia el pasado, aunque el archivo cubra la semana completa:
    //  ese día ya ocurrió y su servicio ya se cobró o se va a cobrar —si un
    //  conductor que hoy ya no aparece en TELEFONOS sí apareció el lunes,
    //  el lunes ya mandó sus marcajes de verdad y esa unidad debe seguir
    //  contando para la factura del mes aunque el miércoles ya no salga en
    //  el archivo. Reescribir el pasado por un cambio de hoy sería borrar
    //  evidencia de un servicio que sí se dio.
    if (minFecha && maxFecha && reporte.leidas > 0) {
      const { rowCount: retiradas } = await cliente.query(
        `UPDATE asignacion a
            SET estado = 'reemplazada', carga_id = $1
          WHERE a.fecha BETWEEN GREATEST($2::date, CURRENT_DATE) AND $3
            AND a.estado <> 'reemplazada'
            AND NOT (a.id = ANY($4::bigint[]))
            -- Se retira si nada de esta ruta TERMINÓ todavía —"terminó" es que
            -- el conductor contestó, no sólo que se le mandó el mensaje—. Un
            -- marcaje enviado y sin contestar sí se puede reemplazar: el Excel
            -- corrigió algo (unidad, conductor, hora) y el conductor recibe la
            -- pregunta otra vez con el dato bueno. Lo que ya contestó es la
            -- evidencia de lo que pasó y ya no se toca ni se duplica.
            AND NOT EXISTS (
              SELECT 1 FROM marcaje m WHERE m.asignacion_id = a.id AND m.respondido_en IS NOT NULL
            )`,
        [cargaId, minFecha, maxFecha, [...vigentes]],
      );
      reporte.reemplazadas = retiradas;

      // Todo lo que no se había contestado se cancela con la asignación: ya
      // no hay a qué responder, la reemplazó una fila nueva con el dato
      // corregido. Lo ya contestado nunca llega aquí —la asignación que lo
      // trae no se marcó 'reemplazada' arriba—.
      const { rowCount: cancelados } = await cliente.query(
        `UPDATE marcaje m
            SET estado = 'cancelado'
           FROM asignacion a
          WHERE a.id = m.asignacion_id
            AND a.carga_id = $1
            AND a.estado = 'reemplazada'
            AND m.estado <> 'cancelado'
            AND m.respondido_en IS NULL`,
        [cargaId],
      );
      reporte.marcajesCancelados = cancelados;
    }

    await cliente.query(
      `UPDATE carga
          SET semana_inicio = $2, semana_fin = $3,
              filas_leidas = $4, filas_resueltas = $5, filas_pendientes = $6,
              estado = 'completada', detalle = $7::jsonb
        WHERE id = $1`,
      [cargaId, minFecha, maxFecha, reporte.leidas, reporte.resueltas,
       reporte.pendientes, JSON.stringify(reporte)],
    );

    log.info(
      {
        cargaId,
        leidas: reporte.leidas,
        pendientes: reporte.pendientes,
        telefonos: reporte.telefonos
          ? `${reporte.telefonos.aplicados}/${reporte.telefonos.filas}`
          : 'sin hoja',
      },
      'carga de Excel completada',
    );
    return { cargaId, semanaInicio: minFecha, semanaFin: maxFecha, ...reporte };
  });
}

function colLetra(n) {
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}
