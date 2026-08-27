// Catálogos: conductores (y sus teléfonos), vehículos, alias y geocercas.
// Aquí es donde se resuelve la basura que dejó el importador.
import { z } from 'zod';
import { filas, unaFila, consultar, auditar, parametros, fijarParametro } from '../db.js';
import { aE164, normalizar } from '../dominio/normalizar.js';
import {
  estadoContrato, listarVehiculos, fijarContratado,
  proponerContratados, resincronizarAsignaciones,
} from '../dominio/contrato.js';

export default async function catalogos(app) {
  app.addHook('preHandler', app.autenticar);
  const editar = app.exigirRol('admin', 'operador');

  // ── Conductores ───────────────────────────────────────────────────────────
  app.get('/conductores', async (req) => {
    const { buscar = '', sinTelefono } = req.query;
    return filas(
      `SELECT c.id, c.nombre, c.telefono_e164, c.activo,
              (SELECT count(*)::int FROM conductor_alias a WHERE a.conductor_id = c.id) AS alias,
              (SELECT string_agg(a.alias, ' | ') FROM conductor_alias a WHERE a.conductor_id = c.id) AS como_aparece
         FROM conductor c
        WHERE ($1 = '' OR c.nombre ILIKE '%' || $1 || '%'
               OR EXISTS (SELECT 1 FROM conductor_alias a WHERE a.conductor_id = c.id AND a.alias ILIKE '%' || $1 || '%'))
          AND ($2::bool IS NOT TRUE OR c.telefono_e164 IS NULL)
        ORDER BY c.telefono_e164 IS NULL DESC, c.nombre
        LIMIT 500`,
      [String(buscar), sinTelefono === '1' || sinTelefono === 'true'],
    );
  });

  app.put('/conductores/:id', { preHandler: [editar] }, async (req, reply) => {
    const datos = z.object({
      nombre: z.string().min(2).optional(),
      telefono: z.string().optional().nullable(),
      activo: z.boolean().optional(),
    }).safeParse(req.body);
    if (!datos.success) return reply.code(400).send({ error: 'Datos inválidos' });

    let e164 = null;
    if (datos.data.telefono) {
      e164 = aE164(datos.data.telefono);
      if (!e164) return reply.code(400).send({ error: 'Teléfono inválido: se esperan 10 dígitos' });
      const ocupado = await unaFila(
        'SELECT id, nombre FROM conductor WHERE telefono_e164 = $1 AND id <> $2',
        [e164, req.params.id],
      );
      if (ocupado) {
        return reply.code(409).send({ error: `Ese teléfono ya es de ${ocupado.nombre}` });
      }
    }

    const c = await unaFila(
      `UPDATE conductor
          SET nombre        = COALESCE($2, nombre),
              telefono_e164 = CASE WHEN $4 THEN $3 ELSE telefono_e164 END,
              activo        = COALESCE($5, activo),
              actualizado_en = now()
        WHERE id = $1
        RETURNING id, nombre, telefono_e164, activo`,
      [req.params.id, datos.data.nombre ?? null, e164,
       Object.hasOwn(datos.data, 'telefono'), datos.data.activo ?? null],
    );
    if (!c) return reply.code(404).send({ error: 'Conductor no encontrado' });

    // Al capturar el teléfono, las asignaciones pendientes de ese conductor
    // se activan solas. Es el flujo natural: llega el dato, arranca el servicio.
    let reactivadas = 0;
    if (c.telefono_e164) {
      const r = await consultar(
        `UPDATE asignacion SET estado = 'programada'
          WHERE conductor_id = $1 AND estado = 'por_resolver' AND fecha >= current_date`,
        [c.id],
      );
      reactivadas = r.rowCount;
    }

    await auditar({ usuarioId: req.user.id, accion: 'edita_conductor', entidad: 'conductor', entidadId: c.id, detalle: { reactivadas }, ip: req.ip });
    return { ...c, reactivadas };
  });

  // Fusionar dos conductores que resultaron ser la misma persona
  // (JEOVANI 47 = YOVANNY 47, ERIK 59 = ERI9K 59, LALO 65 = EDUARDO 65).
  app.post('/conductores/:id/fusionar', { preHandler: [editar] }, async (req, reply) => {
    const otro = Number(req.body?.absorberId);
    const id = Number(req.params.id);
    if (!otro || otro === id) return reply.code(400).send({ error: 'absorberId inválido' });

    await consultar('UPDATE conductor_alias SET conductor_id = $1 WHERE conductor_id = $2', [id, otro]);
    await consultar('UPDATE asignacion SET conductor_id = $1 WHERE conductor_id = $2', [id, otro]);
    await consultar('UPDATE conductor SET activo = false WHERE id = $1', [otro]);
    await auditar({ usuarioId: req.user.id, accion: 'fusiona_conductor', entidad: 'conductor', entidadId: id, detalle: { absorbio: otro }, ip: req.ip });
    return { ok: true };
  });

  app.post('/conductores/:id/alias', { preHandler: [editar] }, async (req, reply) => {
    const alias = normalizar(req.body?.alias ?? '');
    if (!alias) return reply.code(400).send({ error: 'Alias vacío' });
    await consultar(
      `INSERT INTO conductor_alias (alias, conductor_id, origen) VALUES ($1, $2, 'manual')
       ON CONFLICT (alias) DO UPDATE SET conductor_id = EXCLUDED.conductor_id`,
      [alias, req.params.id],
    );
    return { ok: true, alias };
  });

  // ── Vehículos ─────────────────────────────────────────────────────────────
  // Los alias de vehículo deciden la factura: '21' y 'V-21' juntos o separados
  // son ~$1,250 al mes de diferencia. Por eso quedan auditados.
  app.get('/vehiculos', async () =>
    filas(
      `SELECT v.id, v.clave, v.activo, v.contratado, v.contratado_en,
              (SELECT string_agg(a.alias, ' | ' ORDER BY a.alias) FROM vehiculo_alias a WHERE a.vehiculo_id = v.id) AS alias
         FROM vehiculo v ORDER BY v.clave`,
    ));

  // ── Alcance del contrato ──────────────────────────────────────────────────
  // El contrato cubre un número fijo de unidades (hoy 30) y el Excel del
  // cliente trae muchas más. Aquí se decide cuáles entran.

  app.get('/contrato', async () => ({
    ...(await estadoContrato()),
    vehiculos: await listarVehiculos(),
  }));

  app.post('/contrato/vehiculos/:id', { preHandler: [editar] }, async (req, reply) => {
    const contratado = z.boolean().parse(req.body?.contratado);
    let v;
    try {
      v = await fijarContratado(Number(req.params.id), contratado);
    } catch (e) {
      // El trigger de la base es quien impone el tope; su mensaje ya viene
      // redactado para el operador ("El contrato cubre 30 unidades y ya…").
      if (e.code === '23514') return reply.code(409).send({ error: e.message });
      throw e;
    }
    if (!v) return reply.code(404).send({ error: 'No encontrado' });

    // Meter o sacar una unidad cambia qué asignaciones corren.
    const movidas = await resincronizarAsignaciones();
    await auditar({
      usuarioId: req.user.id,
      accion: contratado ? 'contrato_alta' : 'contrato_baja',
      entidad: 'vehiculo',
      entidadId: v.id,
      detalle: { clave: v.clave, ...movidas },
      ip: req.ip,
    });
    return { ...v, ...movidas, contrato: await estadoContrato() };
  });

  // Llena los lugares libres con las unidades que más trabajan en el archivo.
  // Es una propuesta para no arrancar sin monitorear nada: el operador la
  // revisa y la cambia. Nunca da de baja lo que alguien ya eligió.
  app.post('/contrato/proponer', { preHandler: [editar] }, async (req) => {
    const r = await proponerContratados();
    const movidas = await resincronizarAsignaciones();
    await auditar({
      usuarioId: req.user.id,
      accion: 'contrato_propuesta',
      entidad: 'vehiculo',
      detalle: { agregadas: r.agregadas.map((a) => a.clave), ...movidas },
      ip: req.ip,
    });
    return { ...r, ...movidas, contrato: await estadoContrato() };
  });

  app.post('/vehiculos/:id/alias', { preHandler: [editar] }, async (req, reply) => {
    const alias = normalizar(req.body?.alias ?? '');
    if (!alias) return reply.code(400).send({ error: 'Alias vacío' });
    await consultar(
      `INSERT INTO vehiculo_alias (alias, vehiculo_id, origen) VALUES ($1, $2, 'manual')
       ON CONFLICT (alias) DO UPDATE SET vehiculo_id = EXCLUDED.vehiculo_id`,
      [alias, req.params.id],
    );
    await auditar({ usuarioId: req.user.id, accion: 'alias_vehiculo', entidad: 'vehiculo', entidadId: Number(req.params.id), detalle: { alias }, ip: req.ip });
    return { ok: true };
  });

  app.post('/vehiculos/:id/fusionar', { preHandler: [app.exigirRol('admin')] }, async (req, reply) => {
    const otro = Number(req.body?.absorberId);
    const id = Number(req.params.id);
    if (!otro || otro === id) return reply.code(400).send({ error: 'absorberId inválido' });

    await consultar('UPDATE vehiculo_alias SET vehiculo_id = $1 WHERE vehiculo_id = $2', [id, otro]);
    await consultar('UPDATE asignacion SET vehiculo_id = $1 WHERE vehiculo_id = $2', [id, otro]);
    await consultar('UPDATE vehiculo SET activo = false WHERE id = $1', [otro]);
    await auditar({ usuarioId: req.user.id, accion: 'fusiona_vehiculo', entidad: 'vehiculo', entidadId: id, detalle: { absorbio: otro }, ip: req.ip });
    return { ok: true, aviso: 'Fusionar unidades cambia el conteo facturable del mes en curso' };
  });

  // ── Geocercas ─────────────────────────────────────────────────────────────
  app.get('/geocercas', async () => filas('SELECT * FROM geocerca ORDER BY nombre'));

  app.post('/geocercas', { preHandler: [editar] }, async (req, reply) => {
    const datos = z.object({
      nombre: z.string().min(2),
      latitud: z.number().min(-90).max(90),
      longitud: z.number().min(-180).max(180),
      radioM: z.number().int().min(50).max(5000).default(300),
    }).safeParse(req.body);
    if (!datos.success) return reply.code(400).send({ error: 'Datos inválidos' });
    const { nombre, latitud, longitud, radioM } = datos.data;
    return unaFila(
      `INSERT INTO geocerca (nombre, latitud, longitud, radio_m) VALUES ($1, $2, $3, $4)
       ON CONFLICT (nombre) DO UPDATE
         SET latitud = EXCLUDED.latitud, longitud = EXCLUDED.longitud, radio_m = EXCLUDED.radio_m
       RETURNING *`,
      [nombre, latitud, longitud, radioM],
    );
  });

  // ── Rutas ─────────────────────────────────────────────────────────────────
  app.get('/rutas', async (req) =>
    filas(
      `SELECT id, nombre, turno, hora_monitoreo, hora_salida, parada_inicial, seccion, encargado, activo
         FROM ruta WHERE ($1 = '' OR turno = $1) ORDER BY turno, hora_monitoreo, nombre`,
      [String(req.query.turno ?? '')],
    ));

  // ── Parámetros (precios, tarifas, umbrales) ───────────────────────────────
  app.get('/parametros', async () => parametros());

  app.put('/parametros/:clave', { preHandler: [app.exigirRol('admin')] }, async (req, reply) => {
    if (!Object.hasOwn(req.body ?? {}, 'valor')) {
      return reply.code(400).send({ error: 'Falta el valor' });
    }
    // Cambiar precio.* es ejercer la Cláusula Cuarta: queda en bitácora.
    await fijarParametro(req.params.clave, req.body.valor);
    await auditar({
      usuarioId: req.user.id, accion: 'cambia_parametro', entidad: 'parametro',
      detalle: { clave: req.params.clave, valor: req.body.valor }, ip: req.ip,
    });
    return { ok: true };
  });
}
