// Tablero del día, marcajes y la bandeja de "por resolver".
import { filas, unaFila, consultar, auditar } from '../db.js';
import { ventanasAbiertas } from '../dominio/ventana.js';

// El día de hoy en la zona del cliente, no en Greenwich.
//
// `toISOString()` siempre contesta en UTC, pase lo que pase con TZ. Aquí son
// seis horas menos, así que de las 18:00 en adelante este valor por omisión
// apuntaba a mañana y las consultas contestaban vacío justo cuando alguien
// revisaba la tarde. 'en-CA' es el truco para que salga AAAA-MM-DD; el
// contenedor ya corre con TZ=America/Mexico_City.
const hoyLocal = () => new Date().toLocaleDateString('en-CA');

export default async function operacion(app) {
  app.addHook('preHandler', app.autenticar);

  // ── Tablero ───────────────────────────────────────────────────────────────
  app.get('/tablero', async (req) => {
    const fecha = req.query.fecha ?? hoyLocal();

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
    const fecha = req.query.fecha ?? hoyLocal();
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
              --
              -- 'ubicacion' es para no tener que decir disyuntivas. El amarillo
              -- del filtro sale por dos motivos distintos —contestó tarde, o
              -- contestó sin mandar el punto— y sin este dato el tablero se veía
              -- obligado a escribir «tarde o sin comprobar la ubicación», que es
              -- justo la pregunta que el monitorista tenía que contestar.
              (SELECT json_agg(json_build_object(
                        'id', m.id,
                        'numero', m.numero, 'estado', m.estado, 'semaforo', m.semaforo,
                        'programado', m.programado_para, 'enviado', m.enviado_en,
                        'respondido', m.respondido_en,
                        'fuente', m.fuente, 'nota', m.nota,
                        'ubicacion', m.latitud IS NOT NULL,
                        'dentro', m.dentro_geocerca, 'metros', m.distancia_m)
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
  // El Tablero contesta "¿cómo va la ruta?" —hoy, en vivo, para levantar el
  // teléfono ahora—. Esto contesta "¿qué pasó?": la pregunta que llega tres
  // días después, cuando el cliente reclama y hay que reconstruir la mañana con
  // horas y ubicaciones en la mano.
  //
  // Sólo lo que ya ocurrió: un marcaje que todavía no se envía no es historia,
  // es agenda, y mezclarlos haría que la lista de las 5 a.m. ya estuviera llena
  // de cosas que no han pasado.
  //
  // Y aquí SÍ entran las asignaciones 'reemplazada', al revés que en el Tablero.
  // Una recarga del Excel marca así las filas viejas, y eso está bien para el
  // Tablero —esa asignación ya no opera—, pero es un desastre para el historial:
  // los mensajes ya salieron, el conductor ya contestó, y al subir el Excel
  // corregido de media mañana el día entero desaparecía de la pantalla. Lo que
  // pasó, pasó, y la evidencia no se borra porque se haya recargado un archivo.
  // El filtro de 'enviado_en' basta: lo reemplazado que nunca se envió no sale.
  app.get('/historial', async (req) => {
    const fecha = req.query.fecha ?? hoyLocal();
    return filas(
      `SELECT m.id, m.numero, m.estado, m.semaforo, m.fuente, m.nota, m.respuesta,
              m.programado_para, m.enviado_en, m.respondido_en,
              m.latitud, m.longitud, m.distancia_m, m.dentro_geocerca,
              g.nombre AS geocerca,
              -- La pantalla agrupa por ruta y necesita por cuál agrupar. El
              -- nombre no sirve de llave: la misma ruta puede ir dos veces el
              -- mismo día, con distinta unidad y distinto conductor.
              a.id AS asignacion, a.estado AS asignacion_estado,
              r.nombre AS ruta, r.turno, r.encargado, r.hora_monitoreo,
              v.clave  AS unidad,
              c.nombre AS conductor
         FROM marcaje m
         JOIN asignacion a ON a.id = m.asignacion_id
         JOIN ruta r       ON r.id = a.ruta_id
         LEFT JOIN vehiculo  v ON v.id = a.vehiculo_id
         LEFT JOIN conductor c ON c.id = a.conductor_id
         LEFT JOIN geocerca  g ON g.id = m.geocerca_id
        WHERE a.fecha = $1
          AND (m.enviado_en IS NOT NULL OR m.respondido_en IS NOT NULL)
        -- Lo último arriba: un historial se lee empezando por lo que acaba de
        -- pasar, no por lo de hace ocho horas.
        ORDER BY COALESCE(m.respondido_en, m.enviado_en) DESC, m.numero DESC`,
      [fecha],
    );
  });

  // ── Marcajes ──────────────────────────────────────────────────────────────
  app.get('/marcajes', async (req) => {
    const fecha = req.query.fecha ?? hoyLocal();
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

  // Registro manual: se le habló por teléfono o radio y sí estaba. Cubre los
  // DOS motivos de rojo (geocerca.js semaforoDe): no contestó, o contestó el
  // filtro desde fuera de la geocerca. El marcaje se cierra desde el tablero
  // con sólo palomita/tachita, sin escribir nada.
  //
  // Queda en AMARILLO a propósito, nunca en verde. Verde quiere decir una cosa
  // concreta —el conductor contestó él solo, por WhatsApp, dentro de la
  // tolerancia y, si aplica, dentro del filtro—, y si hubo que perseguirlo o
  // corregirlo por teléfono eso no pasó. Amarillo lo deja registrado y
  // visible sin mentir que salió limpio.
  //
  // respondido_en se conserva con COALESCE si ya existía (contestó, sólo que
  // desde fuera del filtro): ese es el momento real en que contestó, la
  // llamada del monitorista no lo cambia. La nota se AGREGA, no se reemplaza
  // —si el conductor sí contestó, notaDe() ya dejó algo escrito ("fuera del
  // filtro, a X m") y eso no se debe perder—.
  app.post('/marcajes/:id/manual', { preHandler: [app.exigirRol('admin', 'operador')] }, async (req, reply) => {
    const nota = String(req.body?.nota ?? '').trim().slice(0, 500) || 'Confirmado desde el tablero';

    // Sólo los que están en rojo: uno ya resuelto (amarillo o verde) no se
    // reescribe desde aquí.
    const m = await unaFila(
      `UPDATE marcaje
          SET estado = 'respondido', respondido_en = COALESCE(respondido_en, now()),
              semaforo = 'amarillo', fuente = 'manual',
              nota = CASE WHEN nota IS NULL OR nota = '' THEN $2 ELSE nota || E'\n' || $2 END
        WHERE id = $1 AND semaforo = 'rojo' RETURNING *`,
      [req.params.id, nota],
    );
    if (!m) return reply.code(404).send({ error: 'Ese marcaje ya no está en rojo' });
    await auditar({
      usuarioId: req.user.id, accion: 'marcaje_manual', entidad: 'marcaje', entidadId: m.id,
      detalle: { numero: m.numero, nota }, ip: req.ip,
    });
    return m;
  });

  // Comentario sobre un marcaje que YA se contestó —el filtro cayó fuera de la
  // geocerca, o no hay ninguna geocerca activa contra qué comparar—. A
  // diferencia del registro manual de arriba, esto NUNCA toca semáforo,
  // estado ni la ubicación: el conductor sí contestó y esa ubicación es la
  // evidencia real, correcta o no. Esto sólo deja escrito el porqué —"se
  // confirmó por teléfono que sí llegó, la geocerca está mal puesta"— sin
  // reescribir lo que pasó. Se agrega, no se reemplaza: si ya había una nota
  // (la que arma notaDe() en el webhook, por ejemplo), no se pierde.
  app.post('/marcajes/:id/comentario', { preHandler: [app.exigirRol('admin', 'operador')] }, async (req, reply) => {
    const comentario = String(req.body?.nota ?? '').trim().slice(0, 500);
    if (comentario.length < 3) {
      return reply.code(400).send({ error: 'Escribe el comentario' });
    }

    const m = await unaFila(
      `UPDATE marcaje
          SET nota = CASE WHEN nota IS NULL OR nota = '' THEN $2 ELSE nota || E'\n' || $2 END
        WHERE id = $1 AND enviado_en IS NOT NULL
        RETURNING *`,
      [req.params.id, comentario],
    );
    if (!m) return reply.code(404).send({ error: 'Ese marcaje todavía no se ha enviado' });
    await auditar({
      usuarioId: req.user.id, accion: 'marcaje_comentario', entidad: 'marcaje', entidadId: m.id,
      detalle: { numero: m.numero, comentario }, ip: req.ip,
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
