// ============================================================================
//  WEBHOOK DE META  —  PUNTO MÁS SENSIBLE DE TODO EL SISTEMA
//
//  Sin verificar la firma X-Hub-Signature-256, cualquiera que conozca la URL
//  puede inyectar ubicaciones y respuestas falsas y contaminar la evidencia
//  que sostiene el servicio. La verificación NO es opcional en producción
//  (config.js se niega a arrancar sin WA_APP_SECRET).
//
//  La firma se calcula sobre el cuerpo CRUDO, byte por byte. Por eso este
//  plugin registra su propio parser de JSON que conserva el raw body: si se
//  usa el parser normal de Fastify, el re-serializado ya no coincide.
// ============================================================================
import { createHmac, timingSafeEqual } from 'node:crypto';

import { config } from '../config.js';
import { consultar, unaFila, parametro } from '../db.js';
import { log } from '../log.js';
import { abrirVentana, decidirCanal } from '../dominio/ventana.js';
import { evaluarUbicacion, semaforoDe } from '../dominio/geocerca.js';
import { enviarAConductor } from '../infra/whatsapp.js';

/**
 * Formas equivalentes de un mismo celular mexicano.
 *
 * Meta entrega el remitente como 521 + 10 dígitos (el '1' de móvil), pero el
 * directorio del cliente y el importador guardan 52 + 10. Buscar por igualdad
 * exacta hacía que NINGUNA respuesta amarrara con su conductor: el mensaje
 * entraba, no encontraba a nadie y la ventana de 24 h no se abría nunca. Con la
 * ventana cerrada todo el día siguiente sale por plantilla, o sea de golpe todo
 * el margen del servicio. Por eso se buscan las dos formas.
 */
export function variantesTelefono(e164) {
  const d = String(e164 ?? '').replace(/\D/g, '');
  if (!d) return [];
  const v = new Set([`+${d}`]);
  if (d.length === 13 && d.startsWith('521')) v.add(`+52${d.slice(3)}`);
  else if (d.length === 12 && d.startsWith('52')) v.add(`+521${d.slice(2)}`);
  return [...v];
}

function interpolar(plantilla, datos) {
  return String(plantilla).replace(/\{(\w+)\}/g, (_, k) => datos[k] ?? '');
}

function firmaValida(raw, cabecera, secreto) {
  if (!cabecera?.startsWith('sha256=')) return false;
  const esperado = createHmac('sha256', secreto).update(raw).digest('hex');
  const recibido = cabecera.slice(7);
  if (recibido.length !== esperado.length) return false;
  return timingSafeEqual(Buffer.from(recibido, 'utf8'), Buffer.from(esperado, 'utf8'));
}

export default async function webhook(app) {
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, cuerpo, hecho) => {
    req.rawBody = cuerpo;
    try {
      hecho(null, cuerpo.length ? JSON.parse(cuerpo.toString('utf8')) : {});
    } catch (e) {
      e.statusCode = 400;
      hecho(e, undefined);
    }
  });

  // Verificación del endpoint al darlo de alta en el panel de Meta.
  app.get('/whatsapp', async (req, reply) => {
    const modo = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    if (modo === 'subscribe' && token && token === config.whatsapp.verifyToken) {
      return reply.code(200).type('text/plain').send(String(req.query['hub.challenge'] ?? ''));
    }
    return reply.code(403).send({ error: 'Verificación rechazada' });
  });

  app.post('/whatsapp', async (req, reply) => {
    if (config.whatsapp.appSecret) {
      if (!firmaValida(req.rawBody, req.headers['x-hub-signature-256'], config.whatsapp.appSecret)) {
        log.warn({ ip: req.ip }, '🚨 webhook con firma inválida: descartado');
        return reply.code(401).send({ error: 'Firma inválida' });
      }
    } else if (config.produccion) {
      return reply.code(503).send({ error: 'Webhook sin app secret configurado' });
    }

    // A Meta se le contesta 200 de inmediato; si tarda, reintenta y duplica.
    reply.code(200).send({ recibido: true });

    try {
      await procesar(req.body);
    } catch (e) {
      log.error({ err: e }, 'error procesando el webhook');
    }
  });
}

async function procesar(cuerpo) {
  for (const entrada of cuerpo?.entry ?? []) {
    for (const cambio of entrada.changes ?? []) {
      const valor = cambio.value ?? {};
      for (const mensaje of valor.messages ?? []) {
        await procesarMensaje(mensaje, valor);
      }
      for (const estado of valor.statuses ?? []) {
        await consultar(
          `UPDATE mensaje_saliente SET estado = $2, actualizado_en = now() WHERE wa_message_id = $1`,
          [estado.id, estado.status],
        );
      }
    }
  }
}

async function procesarMensaje(mensaje, valor) {
  const telefonoBruto = mensaje.from;                  // llega sin '+'
  const telefono = `+${String(telefonoBruto).replace(/\D/g, '')}`;

  const texto = mensaje.text?.body
    ?? mensaje.interactive?.button_reply?.title
    ?? mensaje.button?.text
    ?? null;
  const latitud = mensaje.location?.latitude ?? null;
  const longitud = mensaje.location?.longitude ?? null;

  // Idempotencia: Meta reintenta. wa_message_id es UNIQUE.
  const nuevo = await unaFila(
    `INSERT INTO mensaje_entrante
       (wa_message_id, telefono_e164, tipo, texto, latitud, longitud, crudo, recibido_en)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, to_timestamp($8))
     ON CONFLICT (wa_message_id) DO NOTHING
     RETURNING id`,
    [mensaje.id, telefono, mensaje.type, texto, latitud, longitud,
     JSON.stringify(mensaje), Number(mensaje.timestamp ?? Date.now() / 1000)],
  );
  if (!nuevo) return; // repetido

  // El ANY cubre las dos formas del número; el ORDER BY prefiere la coincidencia
  // exacta por si el catálogo llegara a tener las dos dadas de alta.
  const conductor = await unaFila(
    `SELECT id, nombre, telefono_e164 FROM conductor
      WHERE telefono_e164 = ANY($1)
      ORDER BY (telefono_e164 = $2) DESC, id
      LIMIT 1`,
    [variantesTelefono(telefono), telefono],
  );
  if (!conductor) {
    log.warn({ telefono }, 'mensaje de un número que no está en el catálogo');
    return;
  }
  await consultar('UPDATE mensaje_entrante SET conductor_id = $2 WHERE id = $1', [nuevo.id, conductor.id]);

  // ⚑ Lo primero y más importante: el conductor escribió, la ventana de 24 h
  //   queda abierta y todo lo que le mandemos hoy sale gratis.
  await abrirVentana(conductor.id, new Date(Number(mensaje.timestamp ?? Date.now() / 1000) * 1000));

  // ¿A qué marcaje contesta? Al último que se le PREGUNTÓ y sigue sin respuesta.
  //
  // Antes se buscaba el más cercano en el tiempo dentro de una ventana que se
  // extendía una hora hacia adelante, y eso permitía contestar algo que todavía
  // no se preguntaba: un "buenos días" a las 5:00 daba por cumplido el despertar
  // de las 5:40, que ya nunca se enviaba. El conductor quedaba en verde sin que
  // nadie le hubiera preguntado nada —justo lo contrario del servicio—.
  //
  // 'enviado_en IS NOT NULL' es la condición honesta: sólo se puede responder lo
  // que ya salió. Y de haber dos abiertos, el que vale es el más reciente.
  const marcaje = await unaFila(
    `SELECT m.id, m.numero, m.programado_para
       FROM marcaje m
       JOIN asignacion a ON a.id = m.asignacion_id
      WHERE a.conductor_id = $1
        AND m.respondido_en IS NULL
        AND m.enviado_en IS NOT NULL
        AND m.enviado_en > now() - interval '4 hours'
      ORDER BY m.enviado_en DESC
      LIMIT 1`,
    [conductor.id],
  );
  if (!marcaje) {
    log.info({ conductor: conductor.nombre }, 'respuesta sin marcaje pendiente (ventana abierta de todos modos)');
    return;
  }

  const evaluacion = latitud != null ? await evaluarUbicacion(latitud, longitud) : null;

  let semaforo = await semaforoDe({
    numero: marcaje.numero,
    respondidoEn: new Date(),
    programadoPara: marcaje.programado_para,
    evaluacion,
  });

  // El marcaje 3 es el filtro: lo que se pide es la ubicación, no un "sí". Si
  // contesta con texto queda registrado —no se le va a dejar el marcaje abierto
  // por un celular que no comparte ubicación—, pero en amarillo, que es la
  // verdad: hubo respuesta y no hubo comprobación.
  if (marcaje.numero === 3 && latitud == null) semaforo = 'amarillo';

  await consultar(
    `UPDATE marcaje
        SET estado = 'respondido', respondido_en = now(), fuente = 'whatsapp',
            respuesta = $2, latitud = $3, longitud = $4,
            geocerca_id = $5, distancia_m = $6, dentro_geocerca = $7,
            semaforo = $8
      WHERE id = $1`,
    [marcaje.id, texto, latitud, longitud,
     evaluacion?.geocercaId ?? null, evaluacion?.distanciaM ?? null,
     evaluacion?.dentro ?? null, semaforo],
  );

  log.info(
    { conductor: conductor.nombre, marcaje: marcaje.numero, semaforo, ubicacion: Boolean(latitud) },
    'marcaje registrado',
  );

  await acusarRecibo({ conductor, marcaje, semaforo, tieneUbicacion: latitud != null });
}

/**
 * Le confirma al conductor que su respuesta contó.
 *
 * Sin esto contesta y no pasa nada visible: no sabe si le llegó al sistema y
 * vuelve a escribir. Cada reintento suyo es una respuesta que ya no amarra con
 * ningún marcaje y ruido para él.
 *
 * Nunca puede costar: el conductor acaba de escribir, así que la ventana de 24 h
 * está abierta y el mensaje sale libre. Aun así se comprueba el canal antes de
 * mandar —si algún día abrirVentana fallara, un acuse por plantilla sería pagar
 * por decir "gracias"—.
 */
async function acusarRecibo({ conductor, marcaje, semaforo, tieneUbicacion }) {
  try {
    if (await parametro('acuse.activo', true) !== true) return;
    if (await decidirCanal(conductor.id) !== 'libre') return;

    const clave = marcaje.numero === 3 && !tieneUbicacion ? 'acuse.sin_ubicacion'
      : marcaje.numero === 3 ? 'acuse.ubicacion'
      : semaforo === 'amarillo' ? 'acuse.tarde'
      : 'acuse.generico';

    const cuerpo = interpolar(
      await parametro(clave, '✅ Registrado, {nombre}.'),
      { nombre: (conductor.nombre ?? '').split(' ')[0] },
    );

    await enviarAConductor({
      conductorId: conductor.id,
      telefono: conductor.telefono_e164,
      texto: cuerpo,
      marcajeId: marcaje.id,
    });
  } catch (e) {
    // El acuse es cortesía: que falle no puede tirar el registro del marcaje,
    // que ya quedó guardado arriba.
    log.warn({ err: e, conductor: conductor.nombre }, 'no se pudo acusar recibo');
  }
}
