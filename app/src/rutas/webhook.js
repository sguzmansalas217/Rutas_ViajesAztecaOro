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
import { enviarAConductor, pedirUbicacion } from '../infra/whatsapp.js';
import { avisarEncargados } from '../dominio/avisos.js';

/**
 * Frases con las que el conductor avisa POR ESCRITO que ya llegó al filtro.
 *
 * No se pretende adivinarlas todas ni hace falta: si el texto no cae en
 * ninguna, a su hora le llega igual la petición de ubicación y no se pierde
 * nada. Se prefiere quedarse corto a contestarle "manda tu ubicación" a un
 * "gracias".
 */
// 'ya estoy' a secas era demasiado ancho: agarraba «ya estoy despierto»
// —la respuesta del despertar, nada que ver con el filtro— y le robaba el
// marcaje 1 al 3. Se exige que diga DÓNDE («en», «aquí», «ahí») o que ya
// venga llegando; así sigue cazando «ya estoy en el filtro» / «ya estoy
// aquí» sin tragarse cualquier «ya estoy + lo que sea».
const AVISA_QUE_LLEGO = /alcoholim|alcohol[íi]m|filtro|ya lleg|ya estoy (en|aqu[íi]|ah[íi]|llegando)|aqu[íi] estoy/i;

/**
 * Frases con las que el conductor avisa que ya arrancó la ruta (marcaje 4).
 *
 * Se revisa ANTES que AVISA_QUE_LLEGO porque las dos se pisan: «ya estoy en
 * ruta» cae en las dos y lo que quiere decir es que ya salió, no que llegó al
 * filtro. Aquí sí se da el marcaje por cumplido —a diferencia del filtro, que
 * exige la ubicación— porque no hay nada que comprobar: la salida es un dato
 * que sólo él tiene.
 */
const SALIO_A_RUTA = /inicio (de )?ruta|ya (me )?sal[íi]|ya voy en ruta|ya estoy en ruta|arranqu[eé]|ya sali[oó]/i;

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

  // El identificador del botón, que es lo que dice QUÉ botón tocó. El título
  // no sirve para eso: es la etiqueta que se ve, y se cambia desde el portal.
  const botonId = mensaje.interactive?.button_reply?.id ?? mensaje.button?.payload ?? null;

  // El trabajador le pone al botón el id del marcaje —'m2-si-1407'— y ese id
  // regresa tal cual cuando el conductor lo toca. O sea que el propio mensaje
  // dice a cuál pregunta contesta, sin adivinar nada.
  //
  // Es lo único que aguanta al conductor que contesta tarde: adivinando por la
  // hora, el botón del despertar de las 5:00 tocado a las 9:40 se contaba como
  // la salida. Se cerraba el marcaje equivocado y quedaban mal los dos —el que
  // sí contestó, en rojo; el que no, en verde—.
  const boton = botonId?.match(/^m(\d)-([a-z]+)-(\d+)$/);
  const marcajeDelBoton = boton ? Number(boton[3]) : null;

  // Cuando el conductor usa «responder» sobre un mensaje puntual de WhatsApp,
  // Meta manda ese mensaje original en context.id. Es la misma idea que el id
  // del botón —lo dice el propio mensaje, no hay que adivinar— pero para
  // texto libre, que es justo el caso del despertar (se contesta escribiendo).
  const contextoId = mensaje.context?.id ?? null;

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

  // ⚑ El botón «Ya llegué» del filtro NO cierra el marcaje: lo único que
  //   cuenta ahí es la ubicación. Se le pide y se sale; cuando la mande entra
  //   por el camino de abajo y ahí sí se registra.
  if (boton?.[2] === 'llegue') {
    if (!await pedirleLaUbicacion(conductor, { marcajeId: marcajeDelBoton })) {
      // No se le pidió por alguna razón: ya se le había pedido hace un momento
      // (doble toque) o el filtro ya se cerró. Lo segundo sí hay que decírselo.
      await avisarSiYaEstaba(conductor, marcajeDelBoton);
    }
    return;
  }

  // ── ¿A qué marcaje contesta? ───────────────────────────────────────────────
  //
  // Si vino de un botón ya está contestado: el id lo trae el mensaje. Sólo se
  // comprueba que ese marcaje sea suyo —el id viaja por fuera y no se le cree
  // por venir— y que siga abierto.
  let marcaje = marcajeDelBoton
    ? await unaFila(
      `SELECT m.id, m.numero, m.programado_para, m.enviado_en, m.respondido_en, m.alertado_en
         FROM marcaje m
         JOIN asignacion a ON a.id = m.asignacion_id
        WHERE m.id = $1 AND a.conductor_id = $2 AND m.estado <> 'cancelado'`,
      [marcajeDelBoton, conductor.id],
    )
    : null;

  // Tocó dos veces el mismo botón, o uno que ya se había resuelto por teléfono.
  // Antes esto era silencio: él no sabía si contó y seguía picándole toda la
  // mañana. Decirle «ya lo teníamos» corta eso y no cuesta —la ventana la
  // acaba de abrir él mismo—.
  if (marcaje?.respondido_en) {
    await acusar(conductor, 'acuse.repetido', 'Ya lo teníamos registrado, {nombre}. Gracias.', marcaje.id);
    return;
  }

  // Sin botón hay que buscarlo: al último que se le PREGUNTÓ y sigue sin respuesta.
  //
  // Antes se buscaba el más cercano en el tiempo dentro de una ventana que se
  // extendía una hora hacia adelante, y eso permitía contestar algo que todavía
  // no se preguntaba: un "buenos días" a las 5:00 daba por cumplido el despertar
  // de las 5:40, que ya nunca se enviaba. El conductor quedaba en verde sin que
  // nadie le hubiera preguntado nada —justo lo contrario del servicio—.
  //
  // 'enviado_en IS NOT NULL' es la condición honesta: sólo se puede responder lo
  // que ya salió. Y de haber dos abiertos, el que vale es el más reciente.
  //
  // El conductor solo puede contestar lo que YA se le mandó, nunca algo que
  // todavía no le llega —aunque escriba o mande su ubicación por su cuenta—.
  // Antes esto tenía una excepción («adelantado»: se le creía si avisaba
  // antes de la pregunta), y esa excepción fue justo la que le robó el
  // marcaje 1 al 3 cuando el regex de «ya estoy» se confundió: encontró un
  // marcaje 3 que ni se había mandado y lo dio por bueno. 'enviado_en IS NOT
  // NULL' en las tres consultas de aquí abajo cierra esa puerta: si nadie le
  // ha preguntado nada, no hay nada que "adelantar".
  if (!marcaje && latitud != null) {
    //   El 4 entra aquí junto con el 3, pero por otra razón. El filtro pide la
    //   ubicación porque la compara; la salida la pide sólo para el registro
    //   —desde dónde arrancó— y no se juzga contra nada. El ORDER BY deja que
    //   gane el filtro si los dos estuvieran abiertos: ahí el punto sí decide.
    //
    //   'vencido' entra. Es el marcaje que ya se pintó de rojo porque se acabó
    //   la espera, y era justo el que se quedaba fuera: el conductor tardaba
    //   veinte minutos en mandar el punto del filtro, para entonces ya estaba
    //   vencido, y su ubicación —la prueba del servicio, que sí mandó— no
    //   amarraba con nada. Llegar tarde no es no llegar.
    marcaje = await unaFila(
      `SELECT m.id, m.numero, m.programado_para, m.enviado_en, m.alertado_en
         FROM marcaje m
         JOIN asignacion a ON a.id = m.asignacion_id
        WHERE a.conductor_id = $1
          AND m.numero IN (3, 4)
          AND m.respondido_en IS NULL
          AND m.enviado_en IS NOT NULL
          AND m.estado <> 'cancelado'
          AND a.estado = 'programada'
          AND m.programado_para BETWEEN now() - interval '4 hours'
                                    AND now() + interval '6 hours'
        ORDER BY m.numero, m.programado_para
        LIMIT 1`,
      [conductor.id],
    );

    //   Y el caso normal de la salida: el botón «Ya salí» ya cerró el marcaje y
    //   el punto llega detrás. No hay marcaje abierto al que amarrarlo, así que
    //   sin esto se perdía. Se le pega al que se acaba de cerrar.
    //
    //   La hora no se toca: la salida la registró el botón y ésa es la hora
    //   buena. El semáforo sí, y sólo en un sentido —quitarle el amarillo que
    //   traía por faltarle el punto—. Es lo que hace que la ubicación sea
    //   obligatoria de verdad: mientras no llegue, el día no cierra en verde.
    if (!marcaje) {
      const salida = await unaFila(
        `SELECT m.id, m.numero, m.programado_para, m.respondido_en, m.alertado_en
           FROM marcaje m
           JOIN asignacion a ON a.id = m.asignacion_id
          WHERE a.conductor_id = $1
            AND m.numero = 4
            AND m.latitud IS NULL
            AND m.respondido_en > now() - interval '30 minutes'
          ORDER BY m.respondido_en DESC
          LIMIT 1`,
        [conductor.id],
      );
      if (salida) {
        // Se recalcula con la hora en que contestó el botón, no con ahora: lo
        // que se juzga es la puntualidad de la salida, y ésa ya ocurrió. Sin
        // geocerca, que es el punto de todo esto —no hay filtro contra el cual
        // estar lejos, la ruta arranca donde arranca—.
        let semaforo = await semaforoDe({
          numero: 4,
          respondidoEn: salida.respondido_en,
          programadoPara: salida.programado_para,
          evaluacion: null,
        });
        if (salida.alertado_en && semaforo === 'verde') semaforo = 'amarillo';

        await consultar(
          'UPDATE marcaje SET latitud = $2, longitud = $3, semaforo = $4 WHERE id = $1',
          [salida.id, latitud, longitud, semaforo],
        );
        log.info({ conductor: conductor.nombre, marcaje: salida.id, semaforo }, 'ubicación de salida guardada');
        await acusar(conductor, 'acuse.ubicacion_salida', '📍 Anotado, {nombre}.', salida.id);
        return;
      }
    }
  }

  //   Lo mismo pero por escrito: «ya llegué al alcoholímetro». Va antes de la
  //   regla general a propósito. Si se dejara caer abajo, ese texto cerraría el
  //   marcaje que estuviera abierto en ese momento —la revisión, por ejemplo—
  //   y nadie le pediría nunca la ubicación del filtro. Sólo entra si el
  //   filtro YA se mandó (pedirleLaUbicacion exige enviado_en) — si no, este
  //   texto sigue de largo y cae en el respaldo general de abajo.
  if (!marcaje && texto && !SALIO_A_RUTA.test(texto) && AVISA_QUE_LLEGO.test(texto)) {
    if (await pedirleLaUbicacion(conductor)) return;
  }

  //   Y el aviso de que ya arrancó. Igual que arriba: sólo cuenta si la
  //   salida YA se le preguntó, nunca antes.
  if (!marcaje && texto && SALIO_A_RUTA.test(texto)) {
    marcaje = await unaFila(
      `SELECT m.id, m.numero, m.programado_para, m.enviado_en, m.alertado_en
         FROM marcaje m
         JOIN asignacion a ON a.id = m.asignacion_id
        WHERE a.conductor_id = $1
          AND m.numero = 4
          AND m.respondido_en IS NULL
          AND m.enviado_en IS NOT NULL
          AND m.estado <> 'cancelado'
          AND a.estado = 'programada'
          AND m.programado_para BETWEEN now() - interval '4 hours'
                                    AND now() + interval '6 hours'
        ORDER BY m.programado_para
        LIMIT 1`,
      [conductor.id],
    );
  }

  // Sin botón y sin calzar ninguna frase reconocida, si el conductor citó
  // (swipe-to-reply) un mensaje puntual de WhatsApp, Meta manda ese mensaje
  // original en context.id. Es la misma idea que el id del botón —lo dice el
  // propio mensaje, no hay que adivinar por fecha— y es exactamente lo que le
  // faltaba al despertar, que se contesta escribiendo: con más de un marcaje
  // pendiente a la vez (el conductor que se atrasa y le llegan dos o tres
  // antes de contestar cualquiera), adivinar por «el más reciente sin
  // contestar» amarraba la respuesta con el marcaje que no era.
  if (!marcaje && contextoId) {
    marcaje = await unaFila(
      `SELECT m.id, m.numero, m.programado_para, m.enviado_en, m.respondido_en, m.alertado_en
         FROM marcaje m
         JOIN asignacion a ON a.id = m.asignacion_id
         JOIN mensaje_saliente s ON s.marcaje_id = m.id
        WHERE s.wa_message_id = $1 AND a.conductor_id = $2 AND m.estado <> 'cancelado'
        ORDER BY s.enviado_en DESC
        LIMIT 1`,
      [contextoId, conductor.id],
    );
    if (marcaje?.respondido_en) {
      await acusar(conductor, 'acuse.repetido', 'Ya lo teníamos registrado, {nombre}. Gracias.', marcaje.id);
      return;
    }
  }

  const adelantado = Boolean(marcaje && !marcaje.enviado_en);

  marcaje ??= await unaFila(
    `SELECT m.id, m.numero, m.programado_para, m.alertado_en
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

  // Sólo el filtro se compara contra las geocercas. En la salida el punto es
  // informativo, y evaluarlo igual dejaría guardado un «a 14 km de OFICINA
  // DANY» que el tablero enseñaría como si algo estuviera mal: la ruta arranca
  // donde arranca, no hay filtro contra el cual estar lejos.
  const evaluacion = latitud != null && marcaje.numero === 3
    ? await evaluarUbicacion(latitud, longitud)
    : null;

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

  // La salida, igual, aunque por otro motivo.
  //
  // El punto de la salida no se compara contra nada y aun así se exige: es el
  // único dato que dice desde dónde arrancó la unidad, y cuando el cliente
  // reclama un retraso de hace tres días es lo que se enseña. Un botón sin
  // punto no lo prueba —se toca desde donde sea—.
  //
  // Bloquear el marcaje hasta que llegue sería peor: se perdería «la ruta
  // salió», que es el dato más importante del día y que sí sabemos. Así que se
  // registra la salida y se deja en amarillo, y el punto —cuando llegue, arriba
  // en el camino de la ubicación— se lo levanta. Obligatorio sin ser un
  // candado: sin ubicación el día no cierra en verde, pero nada se pierde.
  //
  // Va atado a que la petición esté encendida: castigar por un punto que nunca
  // se pidió sería dejar amarillo todo el día sin decirle a nadie por qué.
  if (marcaje.numero === 4 && latitud == null
      && await parametro('ubicacion_salida.activo', true) === true
      && await parametro('ubicacion_salida.obligatoria', true) === true) {
    semaforo = 'amarillo';
  }

  // «Hay una falla» sí es una respuesta, pero no es un sí. En rojo: es lo único
  // en el tablero que hace que alguien lo mire ya, no cuando le toque revisar
  // los amarillos. La unidad averiada no puede esperar a que otro marcaje se
  // venza para que alguien se entere.
  const esFalla = botonId?.startsWith('m2-no-');
  if (esFalla) semaforo = 'rojo';

  // El filtro contestado desde fuera de la geocerca es el otro motivo de
  // rojo con respuesta (ver geocerca.js semaforoDe): tampoco vence nunca
  // —respondido_en ya quedó puesto—, así que sin este aviso aparte nadie se
  // entera hasta que alguien revise el tablero a mano.
  const fueraDeFiltro = marcaje.numero === 3 && evaluacion && !evaluacion.sinConfigurar && evaluacion.dentro === false;

  // Lo que ya se venció no vuelve a verde, aunque la tolerancia lo permita.
  //
  // Son dos relojes distintos y hay que respetar los dos: la tolerancia dice si
  // la hora fue aceptable, y la espera dice cuándo se le avisa al encargado que
  // no hay respuesta. Si la espera es más corta que la tolerancia —que es lo
  // normal, se avisa antes de darlo por perdido—, el conductor puede contestar
  // dentro de la tolerancia pero después de que el aviso ya salió.
  //
  // Pintarlo verde ahí sería borrar lo que pasó: al encargado le sonó el
  // teléfono y el tablero le enseñaría una fila impecable. El amarillo es la
  // verdad —se resolvió, pero costó—.
  if (marcaje.alertado_en && semaforo === 'verde') semaforo = 'amarillo';

  // Al adelantado no se le pone enviado_en: nunca se le preguntó, y esa fecha
  // es la evidencia de cuándo salió el mensaje. Queda dicho en la nota. Con
  // estado='respondido' el trabajador ya no se lo manda —su tic sólo toma los
  // 'pendiente'—, que es justo lo que se quiere: llegó, avisó, no se le
  // molesta más.
  await consultar(
    `UPDATE marcaje
        SET estado = 'respondido', respondido_en = now(), fuente = 'whatsapp',
            respuesta = $2, latitud = $3, longitud = $4,
            geocerca_id = $5, distancia_m = $6, dentro_geocerca = $7,
            semaforo = $8, nota = COALESCE(nota, $9)
      WHERE id = $1`,
    [marcaje.id, texto, latitud, longitud,
     evaluacion?.geocercaId ?? null, evaluacion?.distanciaM ?? null,
     evaluacion?.dentro ?? null, semaforo, notaDe(marcaje, adelantado, latitud)],
  );

  log.info(
    { conductor: conductor.nombre, marcaje: marcaje.numero, semaforo, ubicacion: Boolean(latitud), adelantado },
    'marcaje registrado',
  );

  // Falla reportada o filtro fuera de la geocerca: los dos son rojo CON
  // respuesta, así que nunca "vencen" y vencerYAlertar() nunca los ve. Se
  // avisa aquí mismo, ya, sin esperar. Sin plantilla aprobada en Meta para
  // estos dos casos —mandar la de "sin respuesta" avisaría con las palabras
  // equivocadas—, así que sólo sale si la ventana del encargado ya está
  // abierta.
  if (esFalla || fueraDeFiltro) {
    const r = await unaFila(
      `SELECT ru.nombre FROM marcaje m
         JOIN asignacion a ON a.id = m.asignacion_id
         JOIN ruta ru ON ru.id = a.ruta_id
        WHERE m.id = $1`,
      [marcaje.id],
    );
    const tel = conductor.telefono_e164 ? ` · 📞 ${conductor.telefono_e164}` : '';
    const motivo = esFalla
      ? '🔧 Falla reportada'
      : `📍 Filtro fuera de ubicación (${Math.round(evaluacion.distanciaM)} m de ${evaluacion.nombre})`;
    await avisarEncargados(`${motivo} — ${conductor.nombre ?? '?'} · ${r?.nombre ?? '?'}${tel}`);
  }

  // La salida cerrada con el botón todavía no dice desde dónde. Pedirlo aquí
  // hace las veces de acuse —el mensaje empieza con «Registrado»—, así que no
  // se manda además el genérico: serían dos mensajes para lo mismo.
  if (marcaje.numero === 4 && latitud == null && await pedirUbicacionDeSalida(conductor, marcaje)) return;

  await acusarRecibo({ conductor, marcaje, semaforo, evaluacion, tieneUbicacion: latitud != null });
}

/**
 * Lo que hay que dejar escrito de cómo llegó esta respuesta.
 *
 * Dos casos, y los dos importan al revisar el día:
 *
 *   · Se adelantó: contestó antes de que se le preguntara.
 *   · Llegó tarde, después de que el rojo ya se avisó al encargado. El semáforo
 *     pasa a amarillo y sin la nota el tablero acabaría contando la misma
 *     historia que el que sólo se demoró un poco. No es lo mismo: por éste ya
 *     sonó un teléfono y alguien dejó lo que estaba haciendo.
 */
function notaDe(marcaje, adelantado, latitud) {
  if (adelantado) {
    return `El conductor avisó antes de que se le preguntara (${latitud != null ? 'mandó su ubicación' : 'dijo que ya salió'})`;
  }
  if (marcaje.alertado_en) {
    const h = new Date(marcaje.alertado_en)
      .toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Mexico_City' });
    return `Contestó después del rojo; el aviso al encargado ya había salido a las ${h}`;
  }
  return null;
}

/**
 * El conductor toca «Ya llegué» de un filtro que ya se cerró. Se lo decimos.
 *
 * Sin esto le toca el silencio exacto del que se equivoca de botón, y como no
 * pasa nada visible vuelve a tocarlo. La causa normal es que el monitorista ya
 * lo registró por teléfono mientras él iba manejando.
 */
async function avisarSiYaEstaba(conductor, marcajeId) {
  const m = await unaFila(
    `SELECT m.id FROM marcaje m
       JOIN asignacion a ON a.id = m.asignacion_id
      WHERE m.id = $1 AND a.conductor_id = $2 AND m.respondido_en IS NOT NULL`,
    [marcajeId, conductor.id],
  );
  if (m) await acusar(conductor, 'acuse.repetido', 'Ya lo teníamos registrado, {nombre}. Gracias.', m.id);
}

/**
 * Le pide al conductor desde dónde salió. Devuelve true si salió el mensaje.
 *
 * Va DESPUÉS de que el marcaje quedó cerrado, nunca antes. La diferencia con el
 * filtro es todo el punto: allá la ubicación es la prueba y el marcaje no se
 * cierra sin ella; aquí es un dato de más, y si fuera la condición para cerrar,
 * el conductor con el GPS apagado acabaría en rojo por algo informativo.
 *
 * Nunca por plantilla. Pagar por un dato que no cambia ningún semáforo sería
 * gastar el margen del servicio en curiosidad.
 */
async function pedirUbicacionDeSalida(conductor, marcaje) {
  try {
    if (await parametro('ubicacion_salida.activo', true) !== true) return false;
    if (await decidirCanal(conductor.id) !== 'libre') return false;

    const cuerpo = interpolar(
      await parametro(
        'texto.marcaje4_ubicacion',
        '✅ Registrado, {nombre}. Comparte tu ubicación para dejar anotado desde dónde saliste.',
      ),
      { nombre: (conductor.nombre ?? '').split(' ')[0] },
    );

    await pedirUbicacion({
      conductorId: conductor.id,
      telefono: conductor.telefono_e164,
      texto: cuerpo,
      marcajeId: marcaje.id,
    });
    return true;
  } catch (e) {
    // Que falle no puede tirar el marcaje, que ya quedó cerrado arriba. Como
    // mucho se queda sin el punto y el conductor sin acuse.
    log.warn({ err: e, conductor: conductor.nombre }, 'no se pudo pedir la ubicación de salida');
    return false;
  }
}

/** Un mensaje corto de vuelta, siempre gratis o nada. */
async function acusar(conductor, clave, porOmision, marcajeId, datos = {}) {
  try {
    if (await parametro('acuse.activo', true) !== true) return;
    if (await decidirCanal(conductor.id) !== 'libre') return;
    await enviarAConductor({
      conductorId: conductor.id,
      telefono: conductor.telefono_e164,
      texto: interpolar(await parametro(clave, porOmision), {
        nombre: (conductor.nombre ?? '').split(' ')[0], ...datos,
      }),
      marcajeId,
    });
  } catch (e) {
    log.warn({ err: e, conductor: conductor.nombre }, 'no se pudo acusar recibo');
  }
}

/**
 * Le pide al conductor la ubicación del filtro. Devuelve true si salió.
 *
 * Se llega aquí por dos caminos: tocó el botón «Ya llegué» (viene marcajeId) o
 * lo escribió (no viene, y entonces hay que buscar cuál es su filtro de hoy).
 *
 * En los dos casos el marcaje NO se da por cumplido. El texto y el botón no
 * prueban nada —lo mismo se tocan desde su casa—; lo único que se puede
 * comparar contra la geocerca es la ubicación. Cuando la mande, entra por el
 * camino de la ubicación (más arriba en procesarMensaje) y ahí sí cuenta —
 * siempre que el filtro ya se le haya preguntado; nunca antes.
 *
 * Quedarse callado sería lo peor de los dos mundos: avisó, no pasó nada
 * visible, y veinte minutos después le llega la petición de algo que él ya da
 * por hecho.
 *
 * Nunca cuesta: acaba de escribir, así que la ventana está abierta.
 */
async function pedirleLaUbicacion(conductor, { marcajeId = null } = {}) {
  try {
    // Con el botón viene el marcaje y no hay que adivinar cuál es.
    //
    // Las dos consultas llevan la misma guarda de no repetir, y en las dos la
    // línea que importa es «s.enviado_en > m.enviado_en + 30 s». El único
    // mensaje que sale a la vez que el marcaje es la pregunta misma —«¿ya
    // llegaste?»—, y ésa no cuenta como haberle pedido la ubicación. Sin ese
    // matiz la pregunta se bloqueaba a sí misma: quien contestara en los diez
    // minutos siguientes no recibía nada.
    const m = marcajeId
      ? await unaFila(
        `SELECT m.id, r.nombre AS ruta
           FROM marcaje m
           JOIN asignacion a ON a.id = m.asignacion_id
           JOIN ruta r ON r.id = a.ruta_id
          WHERE m.id = $1
            AND a.conductor_id = $2
            AND m.numero = 3
            AND m.respondido_en IS NULL
            -- Un toque es deliberado, así que aquí basta un minuto: sólo
            -- protege del doble clic, no del conductor que insiste.
            AND NOT EXISTS (
              SELECT 1 FROM mensaje_saliente s
               WHERE s.marcaje_id = m.id
                 AND s.estado <> 'fallido'
                 AND s.enviado_en > m.enviado_en + interval '30 seconds'
                 AND s.enviado_en > now() - interval '1 minute'
            )`,
        [marcajeId, conductor.id],
      )
      : await unaFila(
        `SELECT m.id, r.nombre AS ruta
           FROM marcaje m
           JOIN asignacion a ON a.id = m.asignacion_id
           JOIN ruta r ON r.id = a.ruta_id
          WHERE a.conductor_id = $1
            AND m.numero = 3
            AND m.respondido_en IS NULL
            -- Sólo el filtro que YA se mandó. Si el conductor escribe «ya
            -- llegué» antes de que le toque el marcaje 3, no hay nada que
            -- adelantarle: el mensaje se ignora aquí y sigue de largo hasta
            -- el respaldo general, que no encuentra nada abierto tampoco.
            AND m.enviado_en IS NOT NULL
            -- 'vencido' también: el filtro que ya se pintó de rojo sigue siendo
            -- el filtro, y si el conductor avisa tarde hay que pedirle el punto
            -- igual. Es la única forma de que ese rojo pase a amarillo con la
            -- prueba encima, en vez de quedarse rojo con el conductor gritando.
            AND m.estado <> 'cancelado'
            AND a.estado = 'programada'
            AND m.programado_para BETWEEN now() - interval '4 hours'
                                      AND now() + interval '6 hours'
            -- Si ya se le pidió hace poco no se le repite. Sin esto, tres
            -- mensajes seguidos suyos le devuelven tres peticiones iguales.
            AND NOT EXISTS (
              SELECT 1 FROM mensaje_saliente s
               WHERE s.marcaje_id = m.id
                 AND s.estado <> 'fallido'
                 AND s.enviado_en > m.enviado_en + interval '30 seconds'
                 AND s.enviado_en > now() - interval '10 minutes'
            )
          ORDER BY m.programado_para
          LIMIT 1`,
        [conductor.id],
      );
    if (!m) return false;
    if (await decidirCanal(conductor.id) !== 'libre') return false;

    const cuerpo = interpolar(
      await parametro('texto.marcaje3', '📍 {nombre}, comparte tu ubicación para registrar el filtro.'),
      { nombre: (conductor.nombre ?? '').split(' ')[0], ruta: m.ruta },
    );

    await pedirUbicacion({
      conductorId: conductor.id,
      telefono: conductor.telefono_e164,
      texto: cuerpo,
      marcajeId: m.id,
    });
    log.info(
      { conductor: conductor.nombre, marcaje: m.id, via: marcajeId ? 'botón' : 'texto' },
      'avisó que llegó al filtro: se le pidió la ubicación',
    );
    return true;
  } catch (e) {
    log.warn({ err: e, conductor: conductor.nombre }, 'no se pudo pedir la ubicación');
    return false;
  }
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
async function acusarRecibo({ conductor, marcaje, semaforo, evaluacion, tieneUbicacion }) {
  // El filtro tiene acuse propio según cómo haya quedado. Decirle "filtro
  // registrado" a quien mandó la ubicación desde otro lado es peor que no
  // contestarle: se va tranquilo con un marcaje en rojo.
  //
  // 'acuse.ubicacion' quedó para el caso en que no hay geocercas activas:
  // ahí no se puede afirmar ni que está ni que no está.
  const clave = marcaje.numero !== 3 ? (semaforo === 'amarillo' ? 'acuse.tarde' : 'acuse.generico')
    : !tieneUbicacion ? 'acuse.sin_ubicacion'
    : evaluacion?.dentro === true ? 'acuse.dentro'
    : evaluacion?.dentro === false ? 'acuse.fuera'
    : 'acuse.ubicacion';

  await acusar(conductor, clave, '✅ Registrado, {nombre}.', marcaje.id, {
    filtro: evaluacion?.nombre ?? '',
    metros: evaluacion?.distanciaM != null ? Math.round(evaluacion.distanciaM) : '',
  });
}
