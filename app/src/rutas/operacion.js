// Tablero del día, marcajes y la bandeja de "por resolver".
import { filas, unaFila, consultar, auditar } from '../db.js';
import { ventanasAbiertas } from '../dominio/ventana.js';

export default async function operacion(app) {
  app.addHook('preHandler', app.autenticar);

  // ── Tablero ───────────────────────────────────────────────────────────────
  app.get('/tablero', async (req) => {
    const fecha = req.query.fecha ?? new Date().toISOString().slice(0, 10);

    const resumen = await unaFila(
      `SELECT count(*)::int                                              AS asignaciones,
              count(*) FILTER (WHERE estado = 'programada')::int         AS programadas,
              count(*) FILTER (WHERE estado = 'por_resolver')::int       AS por_resolver,
              count(*) FILTER (WHERE estado IN ('cancelada','vacaciones','descanso'))::int AS sin_operar,
              count(DISTINCT vehiculo_id)::int                           AS unidades
         FROM asignacion WHERE fecha = $1`,
      [fecha],
    );

    const marcajes = await unaFila(
      `SELECT count(*)::int                                        AS total,
              count(*) FILTER (WHERE semaforo = 'verde')::int      AS verde,
              count(*) FILTER (WHERE semaforo = 'amarillo')::int   AS amarillo,
              count(*) FILTER (WHERE semaforo = 'rojo')::int       AS rojo,
              count(*) FILTER (WHERE respondido_en IS NULL
                               AND programado_para < now())::int   AS pendientes
         FROM marcaje m
         JOIN asignacion a ON a.id = m.asignacion_id
        WHERE a.fecha = $1`,
      [fecha],
    );

    return { fecha, ...resumen, marcajes, ventanasAbiertas: await ventanasAbiertas() };
  });

  app.get('/asignaciones', async (req) => {
    const fecha = req.query.fecha ?? new Date().toISOString().slice(0, 10);
    return filas(
      `SELECT a.id, a.estado, a.texto_origen, a.hoja, a.celda,
              r.nombre AS ruta, r.turno, r.hora_monitoreo, r.encargado,
              v.clave  AS unidad,
              c.nombre AS conductor, c.telefono_e164,
              (SELECT json_agg(json_build_object(
                        'numero', m.numero, 'estado', m.estado, 'semaforo', m.semaforo,
                        'programado', m.programado_para, 'respondido', m.respondido_en)
                      ORDER BY m.numero)
                 FROM marcaje m WHERE m.asignacion_id = a.id) AS marcajes
         FROM asignacion a
         JOIN ruta r ON r.id = a.ruta_id
         LEFT JOIN vehiculo v  ON v.id = a.vehiculo_id
         LEFT JOIN conductor c ON c.id = a.conductor_id
        WHERE a.fecha = $1 AND ($2 = '' OR r.turno = $2)
        ORDER BY r.hora_monitoreo, r.nombre`,
      [fecha, String(req.query.turno ?? '')],
    );
  });

  // ── Bandeja "por resolver" ────────────────────────────────────────────────
  // Es el mecanismo que permite que el cliente no toque su Excel: lo que el
  // importador no pudo interpretar aterriza aquí en vez de reventar la carga.
  app.get('/por-resolver', async () =>
    filas(
      `SELECT a.id, a.fecha, a.texto_origen, a.hoja, a.celda,
              r.nombre AS ruta, r.turno, r.hora_monitoreo,
              v.clave  AS unidad,
              c.id AS conductor_id, c.nombre AS conductor, c.telefono_e164,
              CASE
                WHEN a.conductor_id IS NULL              THEN 'sin conductor identificado'
                WHEN c.telefono_e164 IS NULL             THEN 'falta teléfono'
                WHEN a.vehiculo_id IS NULL               THEN 'sin unidad en la celda'
                ELSE 'revisar'
              END AS motivo
         FROM asignacion a
         JOIN ruta r ON r.id = a.ruta_id
         LEFT JOIN vehiculo v  ON v.id = a.vehiculo_id
         LEFT JOIN conductor c ON c.id = a.conductor_id
        WHERE a.estado = 'por_resolver' AND a.fecha >= current_date
        ORDER BY a.fecha, r.hora_monitoreo
        LIMIT 500`,
    ));

  app.post('/asignaciones/:id/resolver', { preHandler: [app.exigirRol('admin', 'operador')] }, async (req, reply) => {
    const { conductorId, vehiculoId, estado } = req.body ?? {};
    const a = await unaFila(
      `UPDATE asignacion
          SET conductor_id = COALESCE($2, conductor_id),
              vehiculo_id  = COALESCE($3, vehiculo_id),
              estado       = COALESCE($4, estado)
        WHERE id = $1 RETURNING *`,
      [req.params.id, conductorId ?? null, vehiculoId ?? null, estado ?? null],
    );
    if (!a) return reply.code(404).send({ error: 'Asignación no encontrada' });

    // Con conductor y teléfono ya se puede programar.
    if (a.estado === 'por_resolver' && a.conductor_id) {
      const c = await unaFila('SELECT telefono_e164 FROM conductor WHERE id = $1', [a.conductor_id]);
      if (c?.telefono_e164) {
        await consultar(`UPDATE asignacion SET estado = 'programada' WHERE id = $1`, [a.id]);
        a.estado = 'programada';
      }
    }
    await auditar({ usuarioId: req.user.id, accion: 'resuelve_asignacion', entidad: 'asignacion', entidadId: a.id, ip: req.ip });
    return a;
  });

  // ── Marcajes ──────────────────────────────────────────────────────────────
  app.get('/marcajes', async (req) => {
    const fecha = req.query.fecha ?? new Date().toISOString().slice(0, 10);
    return filas(
      `SELECT m.*, r.nombre AS ruta, r.turno, c.nombre AS conductor, v.clave AS unidad
         FROM marcaje m
         JOIN asignacion a ON a.id = m.asignacion_id
         JOIN ruta r       ON r.id = a.ruta_id
         LEFT JOIN conductor c ON c.id = a.conductor_id
         LEFT JOIN vehiculo  v ON v.id = a.vehiculo_id
        WHERE a.fecha = $1 AND ($2 = '' OR m.semaforo = $2)
        ORDER BY m.programado_para, m.numero`,
      [fecha, String(req.query.semaforo ?? '')],
    );
  });

  // Registro manual: el conductor avisó por radio o por teléfono.
  // Se marca la fuente para que la evidencia no se confunda con la automática.
  app.post('/marcajes/:id/manual', { preHandler: [app.exigirRol('admin', 'operador')] }, async (req, reply) => {
    const m = await unaFila(
      `UPDATE marcaje
          SET estado = 'respondido', respondido_en = now(), semaforo = 'amarillo',
              fuente = 'manual', nota = $2
        WHERE id = $1 RETURNING *`,
      [req.params.id, String(req.body?.nota ?? '').slice(0, 500)],
    );
    if (!m) return reply.code(404).send({ error: 'Marcaje no encontrado' });
    await auditar({ usuarioId: req.user.id, accion: 'marcaje_manual', entidad: 'marcaje', entidadId: m.id, ip: req.ip });
    return m;
  });

  app.get('/bitacora', { preHandler: [app.exigirRol('admin')] }, async (req) =>
    filas(
      `SELECT b.*, u.correo FROM bitacora b LEFT JOIN usuario u ON u.id = b.usuario_id
        ORDER BY b.creado_en DESC LIMIT $1`,
      [Math.min(Number(req.query.limite ?? 200), 1000)],
    ));
}
