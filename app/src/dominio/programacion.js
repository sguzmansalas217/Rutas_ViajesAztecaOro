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

  // Subir el Excel otra vez es la forma de aplicar los Tiempos a lo ya
  // cargado (pedido del cliente, 2026-10-20: guardar en Tiempos no mueve
  // nada, volver a subir el archivo sí). Antes el ON CONFLICT de abajo dejaba
  // cada marcaje como nació, y eso rompió dos cosas en producción:
  //   · Rutas cargadas con tiempos de prueba siguieron saliendo con 3 minutos
  //     entre mensajes días después de corregir la pantalla de Tiempos.
  //   · Una carga de otro archivo daba de baja las rutas y cancelaba sus
  //     mensajes; al volver a subir el bueno la asignación revivía, pero sus
  //     marcajes se quedaban 'cancelado' y el conductor no recibía nada.
  // Sólo rutas que todavía no empiezan (ningún mensaje enviado ni contestado)
  // y sólo hacia horas futuras: una ruta en curso no se toca nunca.
  // Si hay otra copia viva de la misma ruta, conductor y día —celda escrita
  // distinto entre cargas—, no se revive la cancelada: le llegaría doble.
  const { rowCount: reprogramados } = await consultar(
    `WITH n(numero, desfase) AS (VALUES (1, $4::int), (2, $5::int), (3, $6::int), (4, $7::int))
     UPDATE marcaje m
        SET estado = 'pendiente',
            programado_para = (a.fecha + r.hora_monitoreo)::timestamp AT TIME ZONE $3
                              + (n.desfase * interval '1 minute')
       FROM asignacion a
       JOIN ruta r ON r.id = a.ruta_id, n
      WHERE m.asignacion_id = a.id
        AND n.numero = m.numero
        AND a.fecha BETWEEN $1 AND $2
        AND a.estado = 'programada'
        AND m.estado IN ('pendiente', 'cancelado')
        AND m.enviado_en IS NULL AND m.respondido_en IS NULL
        AND (a.fecha + r.hora_monitoreo)::timestamp AT TIME ZONE $3
              + (n.desfase * interval '1 minute') > now()
        AND (m.estado = 'cancelado'
             OR m.programado_para <> (a.fecha + r.hora_monitoreo)::timestamp AT TIME ZONE $3
                                      + (n.desfase * interval '1 minute'))
        AND NOT EXISTS (SELECT 1 FROM marcaje x
                         WHERE x.asignacion_id = a.id
                           AND (x.enviado_en IS NOT NULL OR x.respondido_en IS NOT NULL))
        AND (m.estado = 'pendiente' OR NOT EXISTS (
              SELECT 1 FROM asignacion o
               WHERE o.id <> a.id AND o.estado = 'programada'
                 AND o.fecha = a.fecha AND o.ruta_id = a.ruta_id AND o.conductor_id = a.conductor_id
                 AND (o.id < a.id OR EXISTS (SELECT 1 FROM marcaje mo
                                              WHERE mo.asignacion_id = o.id AND mo.estado <> 'cancelado'))))`,
    [desde, hasta, ZONA, d[1], d[2], d[3], d[4]],
  );
  if (reprogramados) log.info({ desde, hasta, reprogramados }, 'marcajes reprogramados con los Tiempos actuales');

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
 * Rutas de hoy que ya no van a recibir el despertar: su hora pasó (más allá
 * de los 15 minutos en que el trabajador todavía lo manda) y nunca salió
 * ningún mensaje. Pasa cuando el Excel llega después de la hora de la ruta
 * —el 2026-10-20 se subió a las 5:00 con una ruta de las 4:20— y antes la
 * carga no decía nada: el conductor no recibía mensajes y nadie se enteraba.
 */
export async function rutasQueYaNoSalen() {
  return (await consultar(
    `SELECT r.nombre AS ruta, to_char(r.hora_monitoreo, 'HH24:MI') AS hora, c.nombre AS conductor
       FROM asignacion a
       JOIN ruta r ON r.id = a.ruta_id
       JOIN conductor c ON c.id = a.conductor_id
       JOIN marcaje m ON m.asignacion_id = a.id AND m.numero = 1
      WHERE a.estado = 'programada'
        AND a.fecha = (now() AT TIME ZONE $1)::date
        AND m.programado_para <= now() - interval '15 minutes'
        AND NOT EXISTS (SELECT 1 FROM marcaje x
                         WHERE x.asignacion_id = a.id
                           AND (x.enviado_en IS NOT NULL OR x.respondido_en IS NOT NULL))
      ORDER BY r.hora_monitoreo, r.nombre`,
    [ZONA],
  )).rows;
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
