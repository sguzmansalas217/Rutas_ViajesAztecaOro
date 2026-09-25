// ============================================================================
//  AVISOS AL ENCARGADO
//
//  Punto único donde se manda un WhatsApp a la lista de aviso.encargado_telefono
//  (hasta 5 números). Lo usan trabajador.js (rojo por no contestar) y
//  webhook.js (falla reportada en el marcaje 2): dos disparadores distintos,
//  el mismo reparto.
// ============================================================================
import { log } from '../log.js';
import { parametro, listaDeTelefonos } from '../db.js';
import { enviarAviso } from '../infra/whatsapp.js';

/**
 * Manda `texto` a cada número de aviso.encargado_telefono, uno por uno: el
 * fallo de uno (número mal capturado, ventana cerrada y sin plantilla) no debe
 * tumbar el aviso a los demás.
 *
 * `variablesPlantilla`, si se da, es el respaldo de plantilla para el
 * PRIMERO —el principal— nada más: es al único al que se le garantiza que le
 * llegue, pagando si hace falta. Sin `variablesPlantilla` no hay respaldo para
 * nadie: se manda sólo si la ventana de 24 h de ese número está abierta. Úsalo
 * así cuando el texto no tenga una plantilla aprobada en Meta detrás —mandar
 * la plantilla de otro aviso sería avisar con las palabras equivocadas—.
 */
export async function avisarEncargados(texto, variablesPlantilla = null) {
  const telefonosAviso = listaDeTelefonos(await parametro('aviso.encargado_telefono', []));
  if (!telefonosAviso.length) {
    log.warn('sin aviso.encargado_telefono: el aviso no se manda a nadie');
    return;
  }

  const plantilla = variablesPlantilla ? String(await parametro('wa.plantilla_alerta', 'alerta_sin_respuesta')) : null;

  for (const [i, telefonoAviso] of telefonosAviso.entries()) {
    const respaldo = i === 0 && variablesPlantilla ? { plantilla, variables: variablesPlantilla } : null;
    const r = await enviarAviso(telefonoAviso, texto, respaldo);

    if (r.ok) {
      if (r.canal === 'plantilla') {
        log.warn({ telefono: telefonoAviso, costoUsd: r.costoUsd }, 'aviso por plantilla: el encargado no tiene ventana abierta');
      }
      continue;
    }
    log.error({ codigo: r.codigo, canal: r.canal, telefono: telefonoAviso }, '🔴 el aviso NO llegó al encargado');
  }
}
