// ============================================================================
//  VENTANA DE SERVICIO DE 24 HORAS  —  ESTE ARCHIVO ES EL MARGEN DEL NEGOCIO
//
//  Meta sólo cobra las PLANTILLAS. Los mensajes libres dentro de la ventana de
//  servicio salen gratis, y la ventana la abre el CONDUCTOR al responder
//  cualquier cosa. La ventana es por número de teléfono, no por viaje:
//
//     marcaje 1  → plantilla        💰 se cobra
//     responde   → ventana abierta 24 h
//     marcajes 2, 3, 4              ✅ gratis
//     2º y 3er viaje del mismo día  ✅ gratis
//
//  Bien hecho: ~4,500 plantillas/mes (~$700 MXN).
//  Mal hecho:  ~32,000 plantillas/mes (~$5,000 MXN).
//  Sobre una facturación de ~$6,800 al mes, esa diferencia es el negocio.
// ============================================================================
import { consultar, unaFila, parametro } from '../db.js';

/** ¿Podemos mandarle texto libre (gratis) a este conductor ahora mismo? */
export async function ventanaAbierta(conductorId) {
  const fila = await unaFila(
    `SELECT abierta_hasta > now() AS abierta
       FROM ventana_servicio
      WHERE conductor_id = $1`,
    [conductorId],
  );
  return Boolean(fila?.abierta);
}

/** El conductor escribió: se abre (o extiende) la ventana. */
export async function abrirVentana(conductorId, desde = new Date()) {
  const horas = Number(await parametro('wa.ventana_horas', 24));
  const hasta = new Date(desde.getTime() + horas * 3600_000);

  await consultar(
    `INSERT INTO ventana_servicio (conductor_id, abierta_hasta)
     VALUES ($1, $2)
     ON CONFLICT (conductor_id) DO UPDATE
       SET abierta_hasta  = GREATEST(ventana_servicio.abierta_hasta, EXCLUDED.abierta_hasta),
           actualizado_en = now()`,
    [conductorId, hasta],
  );
  return hasta;
}

/**
 * Decide cómo mandar el mensaje. Es el único punto del sistema que elige entre
 * plantilla (con costo) y texto libre (gratis): centralizarlo evita que alguien
 * mande una plantilla por descuido desde otro módulo.
 */
export async function decidirCanal(conductorId) {
  return (await ventanaAbierta(conductorId)) ? 'libre' : 'plantilla';
}

/** Cuántos conductores tienen ventana abierta ahora (indicador del tablero). */
export async function ventanasAbiertas() {
  const fila = await unaFila(
    'SELECT count(*)::int AS n FROM ventana_servicio WHERE abierta_hasta > now()',
  );
  return fila?.n ?? 0;
}
