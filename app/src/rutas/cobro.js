// Cobro. TODO lo de esta ruta es del proveedor del servicio: el conteo por
// unidad, la estructura del precio, el margen y el cierre del periodo.
//
// El administrador del cliente no entra aquí. Lo único que le toca es saber
// cuántas unidades tiene contratadas y cuánto paga al mes por ellas, y eso se
// sirve aparte en /mi-plan: un solo número, sin la fórmula que lo produce.
//
// El corte es por cuenta, no por rol: el cliente tiene su propio administrador
// —es su sistema y da de alta a su gente— y si esto colgara del rol, el día
// que se le da 'admin' se le abriría de paso la estructura comercial.
import {
  calcularMensualidad, calcularPeriodo, cerrarPeriodo, margenPeriodo, periodoDe,
} from '../dominio/cobro.js';
import { filas, unaFila, parametros, auditar } from '../db.js';

export default async function cobro(app) {
  app.addHook('preHandler', app.autenticar);

  // ── Lo único que ve el cliente ────────────────────────────────────────────
  // Se calcula sobre las unidades del CONTRATO, no sobre las que hoy están
  // activas. La mensualidad las cubre todas aunque falte cargar un teléfono, y
  // si dependiera de las activas el número le bailaría cada semana sin que
  // nada haya cambiado en su acuerdo.
  //
  // Sale el total y nada más. Renta base, cuántas van incluidas, cuánto cuesta
  // la que se pasa y el IVA por separado son la estructura comercial: con esos
  // cuatro datos se reconstruye el precio de cualquier otro contrato.
  app.get('/mi-plan', async () => {
    const p = await parametros();
    const contratadas = Number(p['limite.vehiculos'] ?? 30);
    const { total } = calcularMensualidad({
      vehiculosActivos: contratadas,
      rentaBase: p['precio.renta_base'] ?? 1900,
      incluidas: p['precio.incluidas'] ?? 30,
      precioExtra: p['precio.extra'] ?? 50,
      iva: p['precio.iva'] ?? 0.16,
    });
    return { unidadesContratadas: contratadas, total };
  });

  // ── De aquí para abajo, sólo el proveedor ─────────────────────────────────
  app.get('/periodo', { preHandler: [app.exigirProveedor] }, async (req) =>
    calcularPeriodo(req.query.periodo ?? periodoDe()));

  app.get('/cortes', { preHandler: [app.exigirProveedor] }, async () =>
    filas(
      `SELECT periodo, vehiculos_activos, renta_base, incluidas, precio_extra,
              subtotal_mxn, cerrado_en
         FROM corte_mensual ORDER BY periodo DESC`,
    ));

  app.get('/cortes/:periodo', { preHandler: [app.exigirProveedor] }, async (req, reply) => {
    const c = await unaFila('SELECT * FROM corte_mensual WHERE periodo = $1', [req.params.periodo]);
    if (!c) return reply.code(404).send({ error: 'Ese periodo no está cerrado' });
    return c;
  });

  // Cerrar congela el conteo. A partir de aquí la factura ya no se mueve
  // aunque después se fusionen unidades o se corrijan alias.
  app.post('/cerrar', { preHandler: [app.exigirProveedor] }, async (req) => {
    const periodo = req.body?.periodo ?? periodoDe();
    const c = await cerrarPeriodo(periodo, req.user.id);
    await auditar({
      usuarioId: req.user.id, accion: 'cierra_periodo', entidad: 'corte_mensual',
      detalle: { periodo, vehiculos: c.vehiculosActivos, subtotal: c.subtotal }, ip: req.ip,
    });
    return c;
  });

  app.get('/margen', { preHandler: [app.exigirProveedor] }, async (req) =>
    margenPeriodo(req.query.periodo ?? periodoDe()));

  app.get('/mensajes', { preHandler: [app.exigirProveedor] }, async (req) => {
    const periodo = req.query.periodo ?? periodoDe();
    return filas(
      `SELECT date_trunc('day', enviado_en)::date AS dia,
              count(*) FILTER (WHERE tipo = 'plantilla')::int AS plantillas,
              count(*) FILTER (WHERE tipo = 'libre')::int     AS libres,
              coalesce(sum(costo_usd), 0)                     AS costo_usd
         FROM mensaje_saliente
        WHERE enviado_en >= $1::date AND enviado_en < ($1::date + interval '1 month')
        GROUP BY 1 ORDER BY 1`,
      [periodo],
    );
  });
}
