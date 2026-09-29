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
import { enviarAviso, enviarContactos } from '../infra/whatsapp.js';

/**
 * +524491119269 → +52 449 111 9269. WhatsApp detecta solo un número escrito
 * así —subrayado, toca y da la opción de llamar— y con espacios lo reconoce
 * mejor que pegado. Todos los conductores del cliente son +52 de 10 dígitos;
 * si algún día hay otro país, se devuelve tal cual en vez de partir mal.
 */
export function telefonoLegible(e164) {
  const m = String(e164 ?? '').match(/^\+52(\d{3})(\d{3})(\d{4})$/);
  return m ? `+52 ${m[1]} ${m[2]} ${m[3]}` : e164;
}

/**
 * Manda `texto` a cada número de aviso.encargado_telefono, uno por uno: el
 * fallo de uno (número mal capturado, ventana cerrada y sin plantilla) no debe
 * tumbar el aviso a los demás.
 *
 * `claveplantilla` + `variables` son el respaldo de plantilla para el PRIMERO
 * —el principal— nada más: es al único al que se le garantiza que le llegue,
 * pagando si hace falta. Si el parámetro de esa clave está vacío (plantilla
 * todavía no aprobada en Meta) no hay respaldo: se manda sólo si la ventana
 * de 24 h de ese número está abierta.
 *
 * `contactos` se mandan como tarjeta (botón «Llamar») sólo a quien recibió el
 * aviso como texto libre: tras una plantilla la ventana sigue cerrada y Meta
 * descartaría la tarjeta sin avisar.
 */
export async function avisarEncargados(textoBase, { claveplantilla = null, variables = null, contactos = [] } = {}) {
  // Toda alerta arranca con 🔴 para distinguirla a simple vista en el chat.
  // La plantilla ya lo trae en su cuerpo, por eso va aquí y no en las variables.
  const texto = textoBase.startsWith('🔴') ? textoBase : `🔴 ${textoBase}`;
  const telefonosAviso = listaDeTelefonos(await parametro('aviso.encargado_telefono', []));
  if (!telefonosAviso.length) {
    log.warn('sin aviso.encargado_telefono: el aviso no se manda a nadie');
    return;
  }

  const plantilla = claveplantilla && variables ? String(await parametro(claveplantilla, '') ?? '').trim() : '';

  for (const [i, telefonoAviso] of telefonosAviso.entries()) {
    const respaldo = i === 0 && plantilla ? { plantilla, variables } : null;
    const r = await enviarAviso(telefonoAviso, texto, respaldo);

    if (r.ok) {
      if (r.canal === 'plantilla') {
        log.warn({ telefono: telefonoAviso, costoUsd: r.costoUsd }, 'aviso por plantilla: el encargado no tiene ventana abierta');
      } else if (contactos.length) {
        await enviarContactos(telefonoAviso, contactos);
      }
      continue;
    }
    log.error({ codigo: r.codigo, canal: r.canal, telefono: telefonoAviso }, '🔴 el aviso NO llegó al encargado');
  }
}
