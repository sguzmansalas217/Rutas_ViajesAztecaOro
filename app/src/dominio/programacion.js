// ============================================================================
//  PROGRAMACIÓN DE LOS 4 MARCAJES
//
//  El Excel trae una sola hora por ruta: la HORA DE MONITOREO. Los cuatro
//  marcajes se derivan de ella con desfases configurables (tabla parametro),
//  para poder ajustarlos sin tocar código cuando la operación lo pida.
//
//      1  despertar      hora_monitoreo            (plantilla, abre la ventana)
//      2  revisión       +10 min                   (libre, gratis)
//      3  filtro         hora_salida − 20 min      (pide ubicación)
//      4  salida         hora_salida               (libre, gratis)
//
//  Sólo se programan asignaciones en estado 'programada': si falta el teléfono
//  la asignación está 'por_resolver' y no genera marcajes ni gasto.
// ============================================================================
import { consultar, parametros } from '../db.js';
import { log } from '../log.js';

const ZONA = process.env.TZ || 'America/Mexico_City';

export async function programarSemana(desde, hasta) {
  if (!desde || !hasta) return 0;
  const p = await parametros();

  const desfases = {
    1: Number(p['marcaje1.desfase_min'] ?? 0),
    2: Number(p['marcaje2.retraso_min'] ?? 10),
    3: Number(p['marcaje3.desfase_min'] ?? -20), // relativo a la hora de salida
    4: Number(p['marcaje4.desfase_min'] ?? 0),   // relativo a la hora de salida
  };

  // Los marcajes 1 y 2 cuelgan de hora_monitoreo; los 3 y 4 de hora_salida
  // (si la ruta no trae salida, se usa hora_monitoreo + 40/60 min).
  const r = await consultar(
    `INSERT INTO marcaje (asignacion_id, numero, programado_para, estado)
     SELECT a.id,
            n.numero,
            (a.fecha
              + CASE WHEN n.numero <= 2 THEN r.hora_monitoreo
                     ELSE COALESCE(r.hora_salida, r.hora_monitoreo + interval '40 minutes')
                END)::timestamp AT TIME ZONE $3
              + (n.desfase * interval '1 minute'),
            'pendiente'
       FROM asignacion a
       JOIN ruta r ON r.id = a.ruta_id
       CROSS JOIN (VALUES (1, $4::int), (2, $5::int), (3, $6::int), (4, $7::int)) AS n(numero, desfase)
      WHERE a.fecha BETWEEN $1 AND $2
        AND a.estado = 'programada'
     ON CONFLICT (asignacion_id, numero) DO NOTHING`,
    [desde, hasta, ZONA, desfases[1], desfases[2], desfases[3], desfases[4]],
  );

  log.info({ desde, hasta, marcajes: r.rowCount }, 'marcajes programados');
  return r.rowCount;
}

/**
 * Reprograma una asignación suelta (por ejemplo, después de resolverla desde
 * la bandeja de pendientes). Idempotente.
 */
export async function programarAsignacion(asignacionId) {
  const p = await parametros();
  const r = await consultar(
    `INSERT INTO marcaje (asignacion_id, numero, programado_para, estado)
     SELECT a.id, n.numero,
            (a.fecha
              + CASE WHEN n.numero <= 2 THEN r.hora_monitoreo
                     ELSE COALESCE(r.hora_salida, r.hora_monitoreo + interval '40 minutes')
                END)::timestamp AT TIME ZONE $2
              + (n.desfase * interval '1 minute'),
            'pendiente'
       FROM asignacion a JOIN ruta r ON r.id = a.ruta_id
       CROSS JOIN (VALUES (1, $3::int), (2, $4::int), (3, $5::int), (4, $6::int)) AS n(numero, desfase)
      WHERE a.id = $1 AND a.estado = 'programada'
     ON CONFLICT (asignacion_id, numero) DO NOTHING`,
    [asignacionId, ZONA,
     Number(p['marcaje1.desfase_min'] ?? 0), Number(p['marcaje2.retraso_min'] ?? 10),
     Number(p['marcaje3.desfase_min'] ?? -20), Number(p['marcaje4.desfase_min'] ?? 0)],
  );
  return r.rowCount;
}
