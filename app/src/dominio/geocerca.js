// ============================================================================
//  GEOCERCAS
//
//  Con tres puntos fijos, Haversine en JavaScript basta y evita PostGIS.
//
//  ⚠️ Límite conocido, ya reconocido en la Cláusula Sexta del contrato:
//  el payload de ubicación de la WhatsApp Cloud API trae SÓLO latitud y
//  longitud, sin campo de precisión. No hay forma programática de distinguir
//  un GPS bueno de uno malo. Un Android con permiso "Aproximada" reporta con
//  1–3 km de error y se ve idéntico a un fix exacto.
//
//  Por eso el resultado de la validación es un semáforo, no un veredicto:
//  el sistema es herramienta de apoyo, no sustituye la supervisión.
// ============================================================================
import { filas, parametro } from '../db.js';

const RADIO_TIERRA_M = 6_371_000;

export function distanciaMetros(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * RADIO_TIERRA_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Evalúa una ubicación contra todas las geocercas activas y devuelve la más
 * cercana. `dentro` es true si cae en su radio configurado.
 */
export async function evaluarUbicacion(latitud, longitud) {
  const cercas = await filas(
    'SELECT id, nombre, latitud, longitud, radio_m FROM geocerca WHERE activo',
  );
  if (cercas.length === 0) {
    return { geocercaId: null, nombre: null, distanciaM: null, dentro: null, sinConfigurar: true };
  }

  let mejor = null;
  for (const c of cercas) {
    const d = distanciaMetros(Number(latitud), Number(longitud), Number(c.latitud), Number(c.longitud));
    if (!mejor || d < mejor.distanciaM) {
      mejor = { geocercaId: c.id, nombre: c.nombre, distanciaM: Math.round(d * 100) / 100, radioM: c.radio_m };
    }
  }
  return { ...mejor, dentro: mejor.distanciaM <= mejor.radioM, sinConfigurar: false };
}

/**
 * Semáforo del marcaje.
 *   verde    → respondió a tiempo (y si aplica geocerca, dentro)
 *   amarillo → respondió tarde, o fuera de la geocerca
 *   rojo     → no respondió dentro de la tolerancia
 */
export async function semaforoDe({ numero, respondidoEn, programadoPara, evaluacion }) {
  const tolerancia = Number(await parametro('marcaje.tolerancia_min', 15));

  if (!respondidoEn) return 'rojo';

  const retrasoMin = (new Date(respondidoEn) - new Date(programadoPara)) / 60_000;
  if (retrasoMin > tolerancia) return 'amarillo';

  // El marcaje 3 es el filtro/alcoholímetro: es el único con geocerca validada.
  if (numero === 3 && evaluacion && !evaluacion.sinConfigurar && evaluacion.dentro === false) {
    return 'amarillo';
  }
  return 'verde';
}
