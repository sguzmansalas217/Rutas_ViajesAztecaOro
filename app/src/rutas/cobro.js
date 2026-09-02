// Cobro. El detalle por unidad es lo que se le enseña al cliente cuando
// pregunte por la factura; el margen es pantalla interna y NO se comparte.
import { calcularPeriodo, cerrarPeriodo, margenPeriodo, periodoDe } from '../dominio/cobro.js';
import { esProveedor } from '../dominio/proveedor.js';
import { filas, unaFila, auditar } from '../db.js';

// Al administrador del cliente se le dice cuántas unidades trae el periodo, a
// cómo le sale cada una y cuánto paga. Cómo se arma ese precio por dentro
// —renta base, cuántas van incluidas, cuánto cuesta la que se pasa, el IVA por
// separado, a cuánto llegaría con el archivo completo— es del proveedor: de
// ahí se lee la estructura comercial. No basta con no pintarlo en la pantalla;
// si viaja en la respuesta está a un clic en las herramientas del navegador.
function paraElCliente(c) {
  return {
    periodo: c.periodo,
    vehiculosActivos: c.vehiculosActivos,
    unidadesContratadas: c.limiteContrato,
    // Se divide entre las unidades del contrato, no entre las que hoy están
    // activas: la mensualidad las cubre todas aunque falte cargar teléfonos, y
    // si se dividiera entre las activas el precio por unidad se dispararía en
    // cuanto hubiera un hueco —lectura falsa de encarecimiento—. Si algún mes
    // se pasan del contrato, manda ese número mayor y sigue cuadrando.
    precioUnitario: Math.round(
      (c.subtotal / Math.max(c.vehiculosActivos, c.limiteContrato, 1)) * 100,
    ) / 100,
    total: c.total,
    // Esto no es costo, es la promesa de venta hecha número: las rutas de más
    // no se cobran. Se queda.
    unidadesConVariasRutas: c.unidadesConVariasRutas,
    rutasTotales: c.rutasTotales,
    detalle: c.detalle,
  };
}

export default async function cobro(app) {
  app.addHook('preHandler', app.autenticar);

  app.get('/periodo', async (req) => {
    const c = await calcularPeriodo(req.query.periodo ?? periodoDe());
    return esProveedor(req) ? c : paraElCliente(c);
  });

  app.get('/cortes', async (req) =>
    filas(
      esProveedor(req)
        ? `SELECT periodo, vehiculos_activos, renta_base, incluidas, precio_extra,
                  subtotal_mxn, cerrado_en
             FROM corte_mensual ORDER BY periodo DESC`
        : `SELECT periodo, vehiculos_activos, cerrado_en
             FROM corte_mensual ORDER BY periodo DESC`,
    ));

  app.get('/cortes/:periodo', async (req, reply) => {
    const c = await unaFila('SELECT * FROM corte_mensual WHERE periodo = $1', [req.params.periodo]);
    if (!c) return reply.code(404).send({ error: 'Ese periodo no está cerrado' });
    if (esProveedor(req)) return c;
    const unidades = Math.max(Number(c.vehiculos_activos), 1);
    return {
      periodo: c.periodo,
      vehiculos_activos: c.vehiculos_activos,
      precio_unitario: Math.round((Number(c.subtotal_mxn) / unidades) * 100) / 100,
      cerrado_en: c.cerrado_en,
      detalle: c.detalle,
    };
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
    return esProveedor(req) ? c : paraElCliente(c);
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
