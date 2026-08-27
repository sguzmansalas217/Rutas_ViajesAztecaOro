// ============================================================================
//  WHATSAPP CLOUD API
//
//  Todo el gasto con Meta pasa por aquí. Reglas:
//   1. El canal (plantilla con costo / libre gratis) lo decide decidirCanal(),
//      nunca quien llama a esta función.
//   2. Cada envío se registra en mensaje_saliente con su costo. Sin registro
//      no hay medidor de margen ni evidencia para la Cláusula Cuarta.
//   3. En desarrollo WA_SIMULADO=1 escribe al log en vez de llamar a Meta.
// ============================================================================
import { config } from '../config.js';
import { consultar, parametro } from '../db.js';
import { log } from '../log.js';
import { decidirCanal } from '../dominio/ventana.js';

const BASE = 'https://graph.facebook.com/v21.0';

async function llamarMeta(cuerpo) {
  if (config.whatsapp.simulado) {
    log.info({ wa: cuerpo }, 'WhatsApp SIMULADO (no se envió nada a Meta)');
    return { messages: [{ id: `simulado-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }] };
  }

  const r = await fetch(`${BASE}/${config.whatsapp.idNumero}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.whatsapp.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(cuerpo),
  });

  const datos = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(datos?.error?.message ?? `Meta respondió ${r.status}`);
    err.detalleMeta = datos;
    throw err;
  }
  return datos;
}

/**
 * Envía un mensaje al conductor eligiendo automáticamente el canal más barato.
 *
 * @param {object} opciones
 * @param {number} opciones.conductorId
 * @param {string} opciones.telefono      E.164 (+52...)
 * @param {string} opciones.texto         cuerpo para el mensaje libre
 * @param {string} [opciones.plantilla]   nombre de la plantilla aprobada
 * @param {string[]} [opciones.variables] parámetros de la plantilla
 * @param {number} [opciones.marcajeId]
 * @param {object[]} [opciones.botones]   [{id, titulo}] respuestas rápidas
 */
export async function enviarAConductor({
  conductorId, telefono, texto, plantilla, variables = [], marcajeId = null, botones = null,
}) {
  const canal = await decidirCanal(conductorId);
  const costoPlantilla = Number(await parametro('tarifa.meta_utility_usd', 0.0085));

  let cuerpo;
  if (canal === 'plantilla') {
    cuerpo = {
      messaging_product: 'whatsapp',
      to: telefono,
      type: 'template',
      template: {
        name: plantilla ?? (await parametro('wa.plantilla_marcaje1', 'marcaje_despertar')),
        language: { code: 'es_MX' },
        ...(variables.length
          ? { components: [{ type: 'body', parameters: variables.map((t) => ({ type: 'text', text: String(t) })) }] }
          : {}),
      },
    };
  } else if (botones?.length) {
    // Los botones son una decisión de costo, no de estética: hacen que el
    // conductor conteste con un toque y así mantiene la ventana abierta.
    cuerpo = {
      messaging_product: 'whatsapp',
      to: telefono,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: texto },
        action: {
          buttons: botones.slice(0, 3).map((b) => ({
            type: 'reply',
            reply: { id: b.id, title: b.titulo.slice(0, 20) },
          })),
        },
      },
    };
  } else {
    cuerpo = { messaging_product: 'whatsapp', to: telefono, type: 'text', text: { body: texto } };
  }

  let estado = 'enviado';
  let waId = null;
  let error = null;
  try {
    const r = await llamarMeta(cuerpo);
    waId = r?.messages?.[0]?.id ?? null;
  } catch (e) {
    estado = 'fallido';
    error = e.message;
    log.error({ err: e, conductorId, canal }, 'falló el envío por WhatsApp');
  }

  await consultar(
    `INSERT INTO mensaje_saliente
       (conductor_id, marcaje_id, tipo, plantilla, cuerpo, wa_message_id, estado, costo_usd, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      conductorId, marcajeId, canal, canal === 'plantilla' ? (cuerpo.template?.name ?? null) : null,
      canal === 'plantilla' ? JSON.stringify(variables) : texto,
      waId, estado, estado === 'fallido' ? 0 : (canal === 'plantilla' ? costoPlantilla : 0), error,
    ],
  );

  if (estado === 'fallido') throw new Error(error);
  return { canal, waId, costoUsd: canal === 'plantilla' ? costoPlantilla : 0 };
}

/** Pide la ubicación al conductor (marcaje 3, el del filtro). */
export async function pedirUbicacion({ conductorId, telefono, texto, marcajeId }) {
  const canal = await decidirCanal(conductorId);
  if (canal === 'plantilla') {
    // Fuera de ventana no se puede mandar el botón nativo de ubicación:
    // se manda plantilla y el conductor abre la ventana al responder.
    return enviarAConductor({ conductorId, telefono, texto, marcajeId });
  }

  if (config.whatsapp.simulado) {
    log.info({ conductorId, texto }, 'WhatsApp SIMULADO: solicitud de ubicación');
    return { canal: 'libre', waId: null, costoUsd: 0 };
  }

  const cuerpo = {
    messaging_product: 'whatsapp',
    to: telefono,
    type: 'interactive',
    interactive: {
      type: 'location_request_message',
      body: { text: texto },
      action: { name: 'send_location' },
    },
  };
  const r = await llamarMeta(cuerpo);
  await consultar(
    `INSERT INTO mensaje_saliente (conductor_id, marcaje_id, tipo, cuerpo, wa_message_id, estado, costo_usd)
     VALUES ($1, $2, 'libre', $3, $4, 'enviado', 0)`,
    [conductorId, marcajeId, texto, r?.messages?.[0]?.id ?? null],
  );
  return { canal: 'libre', waId: r?.messages?.[0]?.id ?? null, costoUsd: 0 };
}

/** Aviso a un encargado o al operador. Va al número que traiga configurado. */
export async function enviarAviso(telefono, texto) {
  if (!telefono) return;
  try {
    await llamarMeta({
      messaging_product: 'whatsapp', to: telefono, type: 'text', text: { body: texto },
    });
  } catch (e) {
    log.error({ err: e }, 'no se pudo enviar el aviso al encargado');
  }
}
