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
         FROM asignacion
        WHERE fecha = $1
          -- 'reemplazada' es lo que una carga posterior dejó fuera. Sigue en
          -- la tabla como evidencia, pero contarla inflaría el tablero con
          -- filas que ya no existen en el Excel del cliente.
          AND estado <> 'reemplazada'`,
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
        WHERE a.fecha = $1 AND a.estado <> 'reemplazada'`,
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
              -- 'enviado' es lo que separa "no ha contestado" de "todavía no se
              -- le pregunta". Sin ese dato el tablero no puede decir en qué
              -- punto va la ruta: un hueco en blanco se lee igual en los dos
              -- casos y son cosas distintas —uno es para hablarle al
              -- conductor, el otro es esperar—.
              -- 'id', 'fuente' y 'nota' son para el registro manual: el tablero
              -- necesita a cuál marcaje le pega, y al pintarlo tiene que poder
              -- decir que ese amarillo lo puso una llamada y no WhatsApp.
              (SELECT json_agg(json_build_object(
                        'id', m.id,
                        'numero', m.numero, 'estado', m.estado, 'semaforo', m.semaforo,
                        'programado', m.programado_para, 'enviado', m.enviado_en,
                        'respondido', m.respondido_en,
                        'fuente', m.fuente, 'nota', m.nota)
                      ORDER BY m.numero)
                 FROM marcaje m WHERE m.asignacion_id = a.id) AS marcajes
         FROM asignacion a
         JOIN ruta r ON r.id = a.ruta_id
         LEFT JOIN vehiculo v  ON v.id = a.vehiculo_id
         LEFT JOIN conductor c ON c.id = a.conductor_id
        WHERE a.fecha = $1 AND a.estado <> 'reemplazada'
          AND ($2 = '' OR r.turno = $2)
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

  // ── Historial del día ─────────────────────────────────────────────────────
  // El Tablero contesta "¿cómo va la ruta?" y por eso está de cara a la ruta:
  // una fila por ruta, cuatro cuadritos. Esto contesta otra pregunta —"¿qué
  // pasó hoy, en orden?"— y sólo se puede leer de cara al tiempo: qué se
  // preguntó, a qué hora, qué contestó cada quien y desde dónde.
  //
  // Es la vista que se usa cuando el cliente reclama algo de hace tres días. En
  // el Tablero eso obliga a abrir ruta por ruta; aquí es un renglón.
  //
  // Sólo lo que ya ocurrió: un marcaje que todavía no se envía no es historia,
  // es agenda, y mezclarlos haría que la lista de las 5 a.m. ya estuviera llena
  // de cosas que no han pasado.
  app.get('/historial', async (req) => {
    const fecha = req.query.fecha ?? new Date().toISOString().slice(0, 10);
    return filas(
      `SELECT m.id, m.numero, m.estado, m.semaforo, m.fuente, m.nota, m.respuesta,
              m.programado_para, m.enviado_en, m.respondido_en,
              m.latitud, m.longitud, m.distancia_m, m.dentro_geocerca,
              g.nombre AS geocerca,
              r.nombre AS ruta, r.turno, r.encargado,
              v.clave  AS unidad,
              c.nombre AS conductor
         FROM marcaje m
         JOIN asignacion a ON a.id = m.asignacion_id
         JOIN ruta r       ON r.id = a.ruta_id
         LEFT JOIN vehiculo  v ON v.id = a.vehiculo_id
         LEFT JOIN conductor c ON c.id = a.conductor_id
         LEFT JOIN geocerca  g ON g.id = m.geocerca_id
        WHERE a.fecha = $1 AND a.estado <> 'reemplazada'
          AND (m.enviado_en IS NOT NULL OR m.respondido_en IS NOT NULL)
        -- Lo último arriba: un historial se lee empezando por lo que acaba de
        -- pasar, no por lo de hace ocho horas.
        ORDER BY COALESCE(m.respondido_en, m.enviado_en) DESC, m.numero DESC`,
      [fecha],
    );
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
        WHERE a.fecha = $1 AND a.estado <> 'reemplazada'
          AND ($2 = '' OR m.semaforo = $2)
        ORDER BY m.programado_para, m.numero`,
      [fecha, String(req.query.semaforo ?? '')],
    );
  });

  // Registro manual: el conductor no contestó el WhatsApp, se le habló por
  // teléfono o por radio y sí estaba. El marcaje se cierra desde el tablero.
  //
  // Queda en AMARILLO a propósito, nunca en verde. Verde quiere decir una cosa
  // concreta —el conductor contestó él solo, por WhatsApp, dentro de la
  // tolerancia—, y si hubo que perseguirlo eso no pasó. Pintarlo verde dejaría
  // el tablero perfecto y borraría justo el dato por el que existe el tablero:
  // a quién hay que estarle hablando. Amarillo lo deja registrado y visible.
  //
  // La nota es obligatoria. Es lo único que distingue "le hablé y ya venía en
  // camino" de "no contestó el teléfono y su esposa dijo que ya salió", y sin
  // ella el registro manual sería un botón para limpiar rojos.
  app.post('/marcajes/:id/manual', { preHandler: [app.exigirRol('admin', 'operador')] }, async (req, reply) => {
    const nota = String(req.body?.nota ?? '').trim().slice(0, 500);
    if (nota.length < 3) {
      return reply.code(400).send({ error: 'Escribe qué pasó: es la evidencia de este registro' });
    }

    // Sólo los que siguen abiertos. Uno ya contestado no se reescribe desde
    // aquí: la respuesta del conductor es el hecho, y esto no lo corrige.
    const m = await unaFila(
      `UPDATE marcaje
          SET estado = 'respondido', respondido_en = now(), semaforo = 'amarillo',
              fuente = 'manual', nota = $2
        WHERE id = $1 AND respondido_en IS NULL RETURNING *`,
      [req.params.id, nota],
    );
    if (!m) return reply.code(404).send({ error: 'Ese marcaje ya no está abierto' });
    await auditar({
      usuarioId: req.user.id, accion: 'marcaje_manual', entidad: 'marcaje', entidadId: m.id,
      detalle: { numero: m.numero, nota }, ip: req.ip,
    });
    return m;
  });

  app.get('/bitacora', { preHandler: [app.exigirRol('admin')] }, async (req) =>
    filas(
      `SELECT b.*, u.correo FROM bitacora b LEFT JOIN usuario u ON u.id = b.usuario_id
        ORDER BY b.creado_en DESC LIMIT $1`,
      [Math.min(Number(req.query.limite ?? 200), 1000)],
    ));
}
