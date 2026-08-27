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
import { log } from '../log.js';
import {
  normalizar, esRuido, detectarEstatus, partirCelda,
  partirMultiples, claveCanonica,
} from '../dominio/normalizar.js';

// Columnas F..L son los siete días de la semana en todas las hojas.
const COLUMNAS_DIA = [6, 7, 8, 9, 10, 11, 12];

/**
 * Configuración por hoja. `pm: true` significa que las horas menores a las 12
 * están guardadas en formato de 12 h y hay que sumarles 12.
 *   TARDE:      1:20 → 13:20   ·  12:45 se queda en 12:45
 *   NOCHE:      9:00 → 21:00
 *   ENTRADA TB: 1:50 → 13:50   (turno B entra por la tarde)
 *
 * La fila del encabezado NO se declara aquí: la busca localizarEncabezado()
 * leyendo el contenido, porque no es la misma en las cinco hojas.
 */
const HOJAS = {
  'MAÑANA':     { turno: 'MANANA',     pm: false, cols: { hora: 2, ruta: 3, nota: 4, parada: 5, encargado: 13 } },
  'MANANA':     { turno: 'MANANA',     pm: false, cols: { hora: 2, ruta: 3, nota: 4, parada: 5, encargado: 13 } },
  'TARDE':      { turno: 'TARDE',      pm: true,  cols: { hora: 2, ruta: 3, nota: 4, parada: 5, encargado: 13 } },
  'NOCHE':      { turno: 'NOCHE',      pm: true,  cols: { hora: 2, ruta: 3, nota: 4, parada: 5, encargado: 13 } },
  'ENTRADA TA': { turno: 'ENTRADA_TA', pm: false, cols: { ruta: 2, nota: 3, hora: 4, salida: 5, encargado: 13 } },
  'ENTRADA TB': { turno: 'ENTRADA_TB', pm: true,  cols: { ruta: 2, nota: 3, hora: 4, salida: 5, encargado: 13 } },
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
  const fechas = {};

  for (let nf = 1; nf <= limite; nf++) {
    const fila = hoja.getRow(nf);

    // ¿Es la fila de fechas? Se exigen al menos 4 días para no confundirla
    // con una celda suelta con fecha.
    const enEstaFila = {};
    for (const col of COLUMNAS_DIA) {
      const v = fila.getCell(col).value;
      if (v instanceof Date) {
        enEstaFila[col] = `${v.getUTCFullYear()}-${String(v.getUTCMonth() + 1).padStart(2, '0')}-${String(v.getUTCDate()).padStart(2, '0')}`;
      }
    }
    if (!filaFechas && Object.keys(enEstaFila).length >= 4) {
      filaFechas = nf;
      Object.assign(fechas, enEstaFila);
    }

    // ¿Es la fila de etiquetas? Lleva 'RUTA' en las primeras columnas.
    if (!filaEtiquetas) {
      for (let c = 2; c <= 4; c++) {
        if (normalizar(textoDe(fila.getCell(c))) === 'RUTA') { filaEtiquetas = nf; break; }
      }
    }
  }

  // Los datos empiezan después de la última de las dos, sean cuales sean.
  const ultima = Math.max(filaFechas, filaEtiquetas);
  return { fechas, filaFechas, filaEtiquetas, primeraFilaDatos: ultima + 1 };
}

/**
 * Una fila de sección ('FRESNILLO PLC', 'EXTRAS JUANICIPIO (VAO)') es la que
 * tiene texto en B pero ni hora ni conductores. Rompe el parseo lineal ingenuo:
 * hay que reconocerla y usarla como etiqueta de las filas siguientes.
 */
function esFilaSeccion(fila, cfg) {
  const hayConductores = COLUMNAS_DIA.some((c) => textoDe(fila.getCell(c)).trim() !== '');
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
    'SELECT vehiculo_id FROM vehiculo_alias WHERE alias = $1',
    [alias],
  );
  if (existente.rowCount) {
    memo.vehiculos.set(alias, existente.rows[0].vehiculo_id);
    return existente.rows[0].vehiculo_id;
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
  memo.vehiculos.set(alias, id);
  return id;
}

/**
 * Resuelve el conductor por el texto COMPLETO de la celda: 'RICARDO' aparece 64
 * veces en unidades distintas, así que el nombre solo no identifica a nadie.
 * La llave real es nombre + unidad.
 *
 * Si no existe, se da de alta SIN teléfono y la asignación queda 'por_resolver'.
 */
async function resolverConductor(cliente, textoCelda, nombre, crear, memo) {
  const alias = normalizar(textoCelda);
  if (!alias) return { id: null, completo: false };
  if (memo.conductores.has(alias)) return memo.conductores.get(alias);

  const existente = await cliente.query(
    `SELECT c.id, c.telefono_e164 IS NOT NULL AS completo
       FROM conductor_alias a JOIN conductor c ON c.id = a.conductor_id
      WHERE a.alias = $1`,
    [alias],
  );
  if (existente.rowCount) {
    const r = { id: existente.rows[0].id, completo: existente.rows[0].completo };
    memo.conductores.set(alias, r);
    return r;
  }

  if (!crear) return { id: null, completo: false };

  const { rows } = await cliente.query(
    'INSERT INTO conductor (nombre) VALUES ($1) RETURNING id',
    [nombre || alias],
  );
  await cliente.query(
    `INSERT INTO conductor_alias (alias, conductor_id, origen)
     VALUES ($1, $2, 'importador') ON CONFLICT (alias) DO NOTHING`,
    [alias, rows[0].id],
  );
  const r = { id: rows[0].id, completo: false, nuevo: true };
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

  const libro = new ExcelJS.Workbook();
  await libro.xlsx.load(buffer);

  const reporte = {
    hojas: {},
    leidas: 0,
    resueltas: 0,
    pendientes: 0,
    conductoresNuevos: [],
    unidadesNuevas: [],
    sinUnidad: [],
    multiples: [],
    ignoradas: [],
    fusionPrefijoV: fusionarV,
  };

  return enTransaccion(async (cliente) => {
    const carga = await cliente.query(
      `INSERT INTO carga (archivo, hash_archivo, subido_por) VALUES ($1, $2, $3) RETURNING id`,
      [nombreArchivo, hash, usuarioId],
    );
    const cargaId = carga.rows[0].id;
    const memo = { vehiculos: new Map(), conductores: new Map(), rutas: new Map() };
    let minFecha = null;
    let maxFecha = null;

    for (const hoja of libro.worksheets) {
      const cfg = HOJAS[normalizar(hoja.name)] ?? HOJAS[hoja.name];
      if (!cfg) {
        reporte.ignoradas.push(hoja.name);
        continue;
      }

      const { fechas, primeraFilaDatos } = localizarEncabezado(hoja);
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

        if (esFilaSeccion(fila, cfg)) {
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
          encargado: normalizar(textoDe(fila.getCell(cfg.cols.encargado))) || null,
        }, memo);

        for (const col of COLUMNAS_DIA) {
          const fecha = fechas[col];
          if (!fecha) continue;

          const crudo = textoDe(fila.getCell(col)).trim();
          if (!crudo || esRuido(crudo)) continue;

          // Una celda puede traer dos conductores: 'ARMANDO 63/JUAN F 49'
          const partes = crudo.includes('/') ? partirMultiples(crudo) : [normalizar(crudo)];
          if (partes.length > 1) {
            reporte.multiples.push({ hoja: hoja.name, celda: `${colLetra(col)}${nf}`, texto: crudo });
          }

          for (const parte of partes) {
            reporte.leidas++;
            const estatus = detectarEstatus(parte);
            const { nombre, unidad } = partirCelda(parte);

            let vehiculoId = null;
            let conductor = { id: null, completo: false };

            if (!estatus) {
              vehiculoId = await resolverVehiculo(cliente, unidad, fusionarV, memo);
              conductor = await resolverConductor(cliente, parte, nombre, crearConductores, memo);
              // Un conductor sale en varias celdas de la semana: el reporte
              // lista nombres, no apariciones.
              if (conductor.nuevo && !reporte.conductoresNuevos.includes(parte)) {
                reporte.conductoresNuevos.push(parte);
              }
              if (!unidad) reporte.sinUnidad.push({ hoja: hoja.name, celda: `${colLetra(col)}${nf}`, texto: parte });
            }

            // Sin teléfono no se le puede mandar nada: queda por resolver.
            const estado = estatus ?? (conductor.completo ? 'programada' : 'por_resolver');
            if (estado === 'programada') reporte.resueltas++;
            else if (estado === 'por_resolver') reporte.pendientes++;

            await cliente.query(
              `INSERT INTO asignacion
                 (carga_id, fecha, ruta_id, vehiculo_id, conductor_id, texto_origen, hoja, celda, estado)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
               ON CONFLICT (fecha, ruta_id, texto_origen) DO UPDATE
                 SET carga_id     = EXCLUDED.carga_id,
                     vehiculo_id  = EXCLUDED.vehiculo_id,
                     conductor_id = EXCLUDED.conductor_id,
                     estado       = EXCLUDED.estado`,
              [cargaId, fecha, rutaId, vehiculoId, conductor.id, parte, hoja.name,
               `${colLetra(col)}${nf}`, estado],
            );
            enHoja++;
          }
        }
      }
      reporte.hojas[hoja.name] = enHoja;
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
      { cargaId, leidas: reporte.leidas, pendientes: reporte.pendientes },
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
