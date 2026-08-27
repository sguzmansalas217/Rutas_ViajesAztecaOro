// ============================================================================
//  COBRO
//
//  Regla acordada con el cliente el 2026-08-27:
//      El precio es POR VEHICULO. Una unidad que cubre 1, 2, 3 o 4 rutas
//      paga exactamente lo mismo. El número de rutas NO entra en la fórmula.
//
//      mensualidad = renta_base + max(vehiculos_activos - incluidas, 0) * extra
//
//  `rutas_distintas` se calcula y se muestra sólo como evidencia para el
//  cliente de que las rutas de más no le cuestan.
// ============================================================================
import { filas, unaFila, parametros, enTransaccion } from '../db.js';

/** Primer día del mes de una fecha cualquiera, en formato YYYY-MM-DD. */
export function periodoDe(fecha = new Date()) {
  const d = new Date(fecha);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

export function calcularMensualidad({ vehiculosActivos, rentaBase, incluidas, precioExtra, iva }) {
  const adicionales = Math.max(vehiculosActivos - incluidas, 0);
  const subtotal = Number(rentaBase) + adicionales * Number(precioExtra);
  const montoIva = subtotal * Number(iva);
  return {
    vehiculosActivos,
    incluidas,
    adicionales,
    rentaBase: Number(rentaBase),
    precioExtra: Number(precioExtra),
    subtotal: redondear(subtotal),
    iva: redondear(montoIva),
    total: redondear(subtotal + montoIva),
  };
}

function redondear(n) {
  return Math.round(n * 100) / 100;
}

/** Detalle unidad por unidad del periodo. Es lo que se le enseña al cliente. */
export async function detallePeriodo(periodo) {
  return filas(
    `SELECT vehiculo,
            vehiculo_id,
            asignaciones,
            rutas_distintas,
            dias_activos,
            primer_dia,
            ultimo_dia
       FROM vehiculo_activo_mes
      WHERE periodo = $1
      ORDER BY rutas_distintas DESC, vehiculo`,
    [periodo],
  );
}

/**
 * Unidades que aparecen en el archivo del periodo, se hayan monitoreado o no.
 * No factura: es para saber a cuánto va a llegar la mensualidad cuando el
 * padrón de teléfonos esté completo. Ver 004_proyeccion.sql.
 */
export async function proyeccionPeriodo(periodo) {
  const p = await parametros();
  const r = await unaFila(
    `SELECT count(*)::int AS unidades FROM vehiculo_en_archivo_mes WHERE periodo = $1`,
    [periodo],
  );
  return calcularMensualidad({
    vehiculosActivos: r?.unidades ?? 0,
    rentaBase: p['precio.renta_base'] ?? 1900,
    incluidas: p['precio.incluidas'] ?? 30,
    precioExtra: p['precio.extra'] ?? 50,
    iva: p['precio.iva'] ?? 0.16,
  });
}

/** Cálculo en vivo del periodo (todavía no cerrado). */
export async function calcularPeriodo(periodo) {
  const p = await parametros();
  const detalle = await detallePeriodo(periodo);

  const calculo = calcularMensualidad({
    vehiculosActivos: detalle.length,
    rentaBase: p['precio.renta_base'] ?? 1900,
    incluidas: p['precio.incluidas'] ?? 30,
    precioExtra: p['precio.extra'] ?? 50,
    iva: p['precio.iva'] ?? 0.16,
  });

  // Si hay unidades en el archivo que todavía no facturan (falta el teléfono),
  // se muestra a cuánto llegaría la mensualidad con el padrón completo.
  const proyeccion = await proyeccionPeriodo(periodo);

  return {
    periodo,
    ...calculo,
    proyeccion: proyeccion.vehiculosActivos > calculo.vehiculosActivos ? proyeccion : null,
    // Prueba visual de la promesa comercial: unidades que cubren más de una ruta.
    unidadesConVariasRutas: detalle.filter((d) => d.rutas_distintas > 1).length,
    rutasTotales: detalle.reduce((s, d) => s + Number(d.rutas_distintas), 0),
    detalle,
  };
}

/**
 * Congela el periodo. Una vez cerrado, el conteo no se recalcula aunque cambien
 * los datos: es la evidencia de la factura. Si en marzo reclaman enero, se
 * enseña este renglón.
 */
export async function cerrarPeriodo(periodo, usuarioId = null) {
  const ya = await unaFila('SELECT periodo FROM corte_mensual WHERE periodo = $1', [periodo]);
  if (ya) {
    const err = new Error(`El periodo ${periodo} ya está cerrado`);
    err.statusCode = 409;
    throw err;
  }

  const c = await calcularPeriodo(periodo);

  return enTransaccion(async (cliente) => {
    await cliente.query(
      `INSERT INTO corte_mensual
         (periodo, vehiculos_activos, renta_base, incluidas, precio_extra,
          subtotal_mxn, detalle, cerrado_por)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
      [periodo, c.vehiculosActivos, c.rentaBase, c.incluidas, c.precioExtra,
       c.subtotal, JSON.stringify(c.detalle), usuarioId],
    );
    return c;
  });
}

// ── Medidor de margen (pantalla interna, NO del cliente) ────────────────────
export async function margenPeriodo(periodo) {
  const p = await parametros();
  const cobro = await calcularPeriodo(periodo);

  const costo = await unaFila(
    `SELECT coalesce(plantillas, 0) AS plantillas,
            coalesce(libres, 0)     AS libres,
            coalesce(costo_usd, 0)  AS costo_usd
       FROM costo_meta_mes WHERE periodo = $1`,
    [periodo],
  ) ?? { plantillas: 0, libres: 0, costo_usd: 0 };

  const tipoCambio = Number(p['tarifa.tipo_cambio'] ?? 18.5);
  const costoMetaMxn = redondear(Number(costo.costo_usd) * tipoCambio);
  const totalMensajes = Number(costo.plantillas) + Number(costo.libres);

  return {
    periodo,
    ingreso: cobro.subtotal,
    vehiculosActivos: cobro.vehiculosActivos,
    plantillas: Number(costo.plantillas),
    libres: Number(costo.libres),
    // Qué tan bien está funcionando la ventana de 24 h. Arriba de 80% es sano.
    porcentajeGratis: totalMensajes ? Math.round((Number(costo.libres) / totalMensajes) * 100) : 0,
    costoMetaUsd: redondear(Number(costo.costo_usd)),
    costoMetaMxn,
    margenMxn: redondear(cobro.subtotal - costoMetaMxn),
    umbralUsd: Number(p['tarifa.umbral_alerta_usd'] ?? 120),
    excedeUmbral: Number(costo.costo_usd) > Number(p['tarifa.umbral_alerta_usd'] ?? 120),
  };
}
