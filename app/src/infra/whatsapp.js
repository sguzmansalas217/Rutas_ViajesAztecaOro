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

// La versión sale de WA_VERSION. Estaba clavada en v21.0 y la variable no
// servía de nada: cuando Meta deprecara esa versión habría que tocar código.
const BASE = `https://graph.facebook.com/${config.whatsapp.version}`;

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

// El "re-engagement message" de Meta: la ventana de 24 h de ese número está
// cerrada. No es una falla del sistema ni del token, y no se arregla
// reintentando lo mismo: hay que cambiar de canal.
const VENTANA_CERRADA = 131047;

// Meta rechaza el envío COMPLETO si un parámetro de plantilla trae un salto de
// línea, un tabulador o cuatro espacios seguidos. La lista de conductores es
// justo eso —un renglón por conductor—, así que se aplana antes de mandarla.
function aplanar(v) {
  const t = String(v ?? '')
    .replace(/\s*[\r\n]+\s*/g, ' · ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
    .slice(0, 900);
  return t || '—';
}

// Regla 2 de este archivo: todo envío se registra con su costo. El aviso no es
// excepción —el respaldo por plantilla se paga igual que el de un conductor—,
// y la vista costo_meta_mes es la que alimenta el medidor de margen: un aviso
// sin registrar es dinero que sale sin aparecer en ninguna cuenta.
async function registrarAviso({ tipo, plantilla = null, cuerpo, r = null, costoUsd = 0, estado = 'enviado', error = null }) {
  try {
    await consultar(
      `INSERT INTO mensaje_saliente
         (conductor_id, tipo, plantilla, cuerpo, wa_message_id, estado, costo_usd, error)
       VALUES (NULL, $1, $2, $3, $4, $5, $6, $7)`,
      [tipo, plantilla, cuerpo, r?.messages?.[0]?.id ?? null, estado,
       estado === 'fallido' ? 0 : costoUsd, error],
    );
  } catch (e) {
    // Que falle la bitácora no puede impedir que el aviso salga: el rojo que
    // avisa vale más que el renglón que lo contabiliza.
    log.error({ err: e }, 'no se pudo registrar el aviso en mensaje_saliente');
  }
}

/**
 * Aviso a un encargado o al operador. Va al número que traiga configurado.
 *
 * WhatsApp no deja escribirle primero a nadie: el texto libre sólo se entrega
 * si ESE número escribió al del sistema en las últimas 24 h. Un encargado no
 * escribe nunca, así que el aviso llegaba el primer día y al siguiente se
 * apagaba solo, con el error enterrado en el log. De ahí el respaldo: si Meta
 * contesta 131047 el mismo aviso se reintenta por plantilla, que entra tenga
 * o no ventana.
 *
 * Se intenta primero el texto libre a propósito, aunque casi siempre falle: es
 * gratis y la plantilla no. Un rechazo no cuesta nada, así que el orden es
 * "gratis primero, y se paga sólo cuando no queda de otra".
 *
 * @param {string} telefono            E.164
 * @param {string} texto               cuerpo del mensaje libre
 * @param {object} [respaldo]          {plantilla, variables, idioma} para cuando no hay ventana
 * @returns {Promise<{ok, canal, costoUsd, waId?, error?, codigo?}>}
 */
export async function enviarAviso(telefono, texto, respaldo = null) {
  if (!telefono) return { ok: false, canal: null, costoUsd: 0, error: 'No hay número configurado' };

  try {
    const r = await llamarMeta({
      messaging_product: 'whatsapp', to: telefono, type: 'text', text: { body: texto },
    });
    await registrarAviso({ tipo: 'libre', cuerpo: texto, r });
    return { ok: true, canal: 'libre', costoUsd: 0, waId: r?.messages?.[0]?.id ?? null };
  } catch (e) {
    const codigo = e.detalleMeta?.error?.code ?? null;
    if (codigo !== VENTANA_CERRADA || !respaldo?.plantilla) {
      log.error({ err: e, telefono, codigo }, 'no se pudo enviar el aviso al encargado');
      await registrarAviso({ tipo: 'libre', cuerpo: texto, estado: 'fallido', error: e.message });
      return { ok: false, canal: 'libre', costoUsd: 0, error: e.message, codigo };
    }
    log.info({ telefono }, 'ventana cerrada para el aviso: se manda por plantilla');
  }

  const costoUsd = Number(await parametro('tarifa.meta_utility_usd', 0.0085));
  const variables = (respaldo.variables ?? []).map(aplanar);
  const resumen = variables.join(' | ');
  try {
    const r = await llamarMeta({
      messaging_product: 'whatsapp',
      to: telefono,
      type: 'template',
      template: {
        name: respaldo.plantilla,
        language: { code: respaldo.idioma ?? 'es_MX' },
        components: variables.length
          ? [{ type: 'body', parameters: variables.map((t) => ({ type: 'text', text: t })) }]
          : [],
      },
    });
    await registrarAviso({ tipo: 'plantilla', plantilla: respaldo.plantilla, cuerpo: resumen, r, costoUsd });
    return { ok: true, canal: 'plantilla', costoUsd, waId: r?.messages?.[0]?.id ?? null };
  } catch (e) {
    log.error({ err: e, telefono, plantilla: respaldo.plantilla }, 'el aviso tampoco salió por plantilla');
    await registrarAviso({
      tipo: 'plantilla', plantilla: respaldo.plantilla, cuerpo: resumen,
      estado: 'fallido', error: e.message,
    });
    return {
      ok: false, canal: 'plantilla', costoUsd: 0,
      error: e.message, codigo: e.detalleMeta?.error?.code ?? null,
    };
  }
}
