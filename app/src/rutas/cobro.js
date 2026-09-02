// Cobro. El detalle por unidad es lo que se le enseña al cliente cuando
// pregunte por la factura; el margen es pantalla interna y NO se comparte.
import { calcularPeriodo, cerrarPeriodo, margenPeriodo, periodoDe } from '../dominio/cobro.js';
import { filas, unaFila, auditar } from '../db.js';

export default async function cobro(app) {
  app.addHook('preHandler', app.autenticar);

  app.get('/periodo', async (req) => calcularPeriodo(req.query.periodo ?? periodoDe()));

  app.get('/cortes', async () =>
    filas(
      `SELECT periodo, vehiculos_activos, renta_base, incluidas, precio_extra,
              subtotal_mxn, cerrado_en
         FROM corte_mensual ORDER BY periodo DESC`,
    ));

  app.get('/cortes/:periodo', async (req, reply) => {
    const c = await unaFila('SELECT * FROM corte_mensual WHERE periodo = $1', [req.params.periodo]);
    if (!c) return reply.code(404).send({ error: 'Ese periodo no está cerrado' });
    return c;
  });

  // Cerrar congela el conteo. A partir de aquí la factura ya no se mueve
  // aunque después se fusionen unidades o se corrijan alias.
  app.post('/cerrar', { preHandler: [app.exigirRol('admin')] }, async (req) => {
    const periodo = req.body?.periodo ?? periodoDe();
    const c = await cerrarPeriodo(periodo, req.user.id);
    await auditar({
      usuarioId: req.user.id, accion: 'cierra_periodo', entidad: 'corte_mensual',
      detalle: { periodo, vehiculos: c.vehiculosActivos, subtotal: c.subtotal }, ip: req.ip,
    });
    return c;
  });

  // Estas dos NO son de 'admin', son del proveedor: enseñan lo que le pagamos
  // a Meta y el margen del servicio. El administrador del cliente no las ve
  // —la vista de Cobro se pinta igual, nada más sin ese bloque—.
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
