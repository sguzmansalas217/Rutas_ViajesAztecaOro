// ============================================================================
//  PROGRAMACIÓN DE LOS 4 MARCAJES
//
//  El Excel trae una sola hora por ruta: la HORA DE MONITOREO. De ahí salen los
//  cuatro marcajes, cada uno contado DESDE EL ANTERIOR, con minutos que se
//  configuran en el portal (pantalla Tiempos, tabla parametro):
//
//      1  despertar   hora del Excel  + marcaje1.desfase_min   (abre la ventana)
//      2  revisión    marcaje 1       + marcaje2.retraso_min   (botones)
//      3  filtro      marcaje 2       + marcaje3.retraso_min   (pide ubicación)
//      4  salida      marcaje 3       + marcaje4.retraso_min   (botón)
//
//  En cascada y no desde un origen común, y todos los números positivos. Antes
//  había dos anclas —los 1 y 2 desde la hora del Excel, los 3 y 4 desde una
//  hora de salida que la hoja MAÑANA no trae y que el sistema inventaba como
//  monitoreo + 40 min—, y el filtro se configuraba como «−20»: veinte minutos
//  antes de una hora que no está en el archivo. Setear eso bien exigía tener
//  el código en la cabeza, y setearlo mal no avisaba: los mensajes se
//  encabalgaban y al conductor le llegaban en desorden.
//
//  Con la cascada el encabalgamiento no se valida, es que no se puede escribir.
//
//  Sólo se programan asignaciones en estado 'programada': si falta el teléfono
//  la asignación está 'por_resolver' y no genera marcajes ni gasto.
// ============================================================================
import { consultar, parametros } from '../db.js';
import { log } from '../log.js';

const ZONA = process.env.TZ || 'America/Mexico_City';

// Cada espera es «cuánto después del marcaje anterior», así que negativa no
// significa nada: se toma como cero. La base sí puede ser negativa —despertar
// antes de la hora del Excel es una petición legítima—.
const espera = (v, def) => {
  const n = Number(v ?? def);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : def;
};

/**
 * Los cuatro desfases resueltos en minutos DESDE LA HORA DEL EXCEL, que es lo
 * que la consulta necesita. Se acumulan aquí para que la cascada viva en un
 * solo lugar y no repartida entre dos SQL.
 */
export function desfasesDe(p) {
  const base = Number(p['marcaje1.desfase_min'] ?? 0);
  const uno = Number.isFinite(base) ? Math.round(base) : 0;
  const dos = uno + espera(p['marcaje2.retraso_min'], 10);
  const tres = dos + espera(p['marcaje3.retraso_min'], 10);
  const cuatro = tres + espera(p['marcaje4.retraso_min'], 20);
  return { 1: uno, 2: dos, 3: tres, 4: cuatro };
}

export async function programarSemana(desde, hasta) {
  if (!desde || !hasta) return 0;
  const d = desfasesDe(await parametros());

  // Los cuatro cuelgan de hora_monitoreo. La columna ruta.hora_salida se sigue
  // importando —las hojas ENTRADA TA y TB la traen y se ve en el catálogo—,
  // pero ya no programa nada: la segunda ancla era justo lo que hacía
  // imposible de entender la pantalla de Tiempos.
  const r = await consultar(
    `INSERT INTO marcaje (asignacion_id, numero, programado_para, estado)
     SELECT a.id,
            n.numero,
            (a.fecha + r.hora_monitoreo)::timestamp AT TIME ZONE $3
              + (n.desfase * interval '1 minute'),
            'pendiente'
       FROM asignacion a
       JOIN ruta r ON r.id = a.ruta_id
       CROSS JOIN (VALUES (1, $4::int), (2, $5::int), (3, $6::int), (4, $7::int)) AS n(numero, desfase)
      WHERE a.fecha BETWEEN $1 AND $2
        AND a.estado = 'programada'
     ON CONFLICT (asignacion_id, numero) DO NOTHING`,
    [desde, hasta, ZONA, d[1], d[2], d[3], d[4]],
  );

  log.info({ desde, hasta, marcajes: r.rowCount }, 'marcajes programados');
  return r.rowCount;
}

/**
 * Programa los marcajes de asignaciones sueltas que acaban de quedar en
 * 'programada' FUERA de la carga del Excel: al capturar un teléfono que
 * faltaba, o al meter una unidad al contrato.
 *
 * Sin esto la asignación se activa pero nace sin marcajes: el tablero la
 * enseña como «Sin marcajes» y no manda nada nunca. Se veía como si el sistema
 * estuviera roto, y la única forma de destrabarlo era volver a subir el Excel.
 *
 * Idempotente: el ON CONFLICT deja pasar las que ya tienen marcajes.
 */
export async function programarVarias(ids) {
  if (!ids?.length) return 0;
  const d = desfasesDe(await parametros());
  const r = await consultar(
    `INSERT INTO marcaje (asignacion_id, numero, programado_para, estado)
     SELECT a.id,
            n.numero,
            (a.fecha + r.hora_monitoreo)::timestamp AT TIME ZONE $2
              + (n.desfase * interval '1 minute'),
            'pendiente'
       FROM asignacion a
       JOIN ruta r ON r.id = a.ruta_id
       CROSS JOIN (VALUES (1, $3::int), (2, $4::int), (3, $5::int), (4, $6::int)) AS n(numero, desfase)
      WHERE a.id = ANY($1::int[])
        AND a.estado = 'programada'
     ON CONFLICT (asignacion_id, numero) DO NOTHING`,
    [ids.map(Number), ZONA, d[1], d[2], d[3], d[4]],
  );
  return r.rowCount;
}

/** Reprograma una asignación suelta. Idempotente. */
export const programarAsignacion = (asignacionId) => programarVarias([asignacionId]);
