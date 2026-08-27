// ============================================================================
//  ALCANCE DEL CONTRATO
//
//  El contrato cubre un número fijo de unidades (hoy 30). El Excel del
//  cliente trae muchas más —113 en el archivo del 3 al 9 de agosto— y hay
//  que decidir explícitamente cuáles entran.
//
//  Quién manda: el parámetro `limite.vehiculos` y la bandera
//  `vehiculo.contratado`. El tope lo garantiza un trigger en la base
//  (005_limite_contrato.sql), así que aquí no hace falta volver a validarlo:
//  si se pasa, la base tira el INSERT/UPDATE y el error sube tal cual.
// ============================================================================
import { filas, unaFila, parametro } from '../db.js';

export async function limiteVehiculos() {
  return Number(await parametro('limite.vehiculos', 30)) || 30;
}

/** Resumen para el tablero: cuántas caben, cuántas hay y cuántas quedan fuera. */
export async function estadoContrato() {
  const limite = await limiteVehiculos();
  const r = await unaFila(
    `SELECT count(*) FILTER (WHERE contratado)     ::int AS contratadas,
            count(*) FILTER (WHERE NOT contratado) ::int AS fuera
       FROM vehiculo WHERE activo`,
  );
  const contratadas = r?.contratadas ?? 0;
  return {
    limite,
    contratadas,
    fuera: r?.fuera ?? 0,
    libres: Math.max(limite - contratadas, 0),
  };
}

/**
 * Listado para elegir las unidades. Ordena por carga de trabajo real
 * (asignaciones en el archivo), que es el criterio con el que alguien
 * escogería a mano: primero las que más trabajan.
 */
export async function listarVehiculos({ soloContratados = false } = {}) {
  return filas(
    `SELECT v.id,
            v.clave,
            v.contratado,
            v.contratado_en,
            count(a.id)                    ::int AS asignaciones,
            count(DISTINCT a.ruta_id)      ::int AS rutas,
            count(DISTINCT a.conductor_id) ::int AS conductores,
            max(a.fecha)                         AS ultimo_dia
       FROM vehiculo v
       LEFT JOIN asignacion a
              ON a.vehiculo_id = v.id
             AND a.estado <> 'cancelada'
      WHERE v.activo
        AND ($1::bool IS NOT TRUE OR v.contratado)
      GROUP BY v.id, v.clave, v.contratado, v.contratado_en
      ORDER BY v.contratado DESC, count(a.id) DESC, v.clave`,
    [soloContratados],
  );
}

/**
 * Da de alta o de baja una unidad del contrato.
 * Si se pasa del tope, el trigger de la base lanza check_violation y el
 * mensaje ya viene redactado para enseñárselo al operador.
 */
export async function fijarContratado(vehiculoId, contratado) {
  return unaFila(
    `UPDATE vehiculo
        SET contratado    = $2,
            contratado_en = CASE WHEN $2 THEN coalesce(contratado_en, now()) ELSE NULL END
      WHERE id = $1
      RETURNING id, clave, contratado`,
    [vehiculoId, contratado],
  );
}

/**
 * Propuesta automática: llena los lugares libres con las unidades que más
 * aparecen en el archivo. NO es una decisión final —el operador la revisa y
 * la cambia— pero evita que el sistema arranque sin monitorear nada.
 *
 * Sólo agrega; nunca da de baja una unidad que alguien ya eligió a mano.
 */
export async function proponerContratados() {
  const { libres } = await estadoContrato();
  if (libres <= 0) return { agregadas: [], libres: 0 };

  const candidatas = await filas(
    `SELECT v.id, v.clave, count(a.id)::int AS asignaciones
       FROM vehiculo v
       LEFT JOIN asignacion a
              ON a.vehiculo_id = v.id
             AND a.estado <> 'cancelada'
      WHERE v.activo AND NOT v.contratado
      GROUP BY v.id, v.clave
      HAVING count(a.id) > 0
      ORDER BY count(a.id) DESC, v.clave
      LIMIT $1`,
    [libres],
  );

  const agregadas = [];
  for (const c of candidatas) {
    await fijarContratado(c.id, true);
    agregadas.push(c);
  }
  return { agregadas, libres: libres - agregadas.length };
}

/**
 * Recalcula el estado de las asignaciones tras cambiar el alcance.
 * Al meter o sacar una unidad del contrato hay que mover sus asignaciones
 * entre 'fuera_contrato' y 'por_resolver'/'programada'; si no, se quedan
 * congeladas en el estado que tenían al importar.
 *
 * No toca 'cancelada' ni 'vacaciones': eso lo dijo el cliente en el Excel
 * y no es asunto del contrato.
 */
export async function resincronizarAsignaciones() {
  const fuera = await filas(
    `UPDATE asignacion a
        SET estado = 'fuera_contrato'
       FROM vehiculo v
      WHERE v.id = a.vehiculo_id
        AND NOT v.contratado
        AND a.estado IN ('programada','por_resolver')
      RETURNING a.id`,
  );

  // El conductor va en subconsulta y no en LEFT JOIN: en un UPDATE ... FROM,
  // Postgres no deja que la cláusula ON de un join referencie la tabla que se
  // está actualizando ("invalid reference to FROM-clause entry").
  const dentro = await filas(
    `UPDATE asignacion a
        SET estado = CASE
                       WHEN EXISTS (SELECT 1 FROM conductor c
                                     WHERE c.id = a.conductor_id
                                       AND c.activo
                                       AND c.telefono_e164 IS NOT NULL)
                         THEN 'programada'
                       ELSE 'por_resolver'
                     END
       FROM vehiculo v
      WHERE v.id = a.vehiculo_id
        AND v.contratado
        AND a.estado = 'fuera_contrato'
      RETURNING a.id`,
  );

  return { sacadas: fuera.length, metidas: dentro.length };
}
