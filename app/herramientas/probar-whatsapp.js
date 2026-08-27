#!/usr/bin/env node
// ============================================================================
//  DIAGNÓSTICO DE WHATSAPP CLOUD API
//
//  Revisa de una sola pasada todo lo que tiene que estar bien para que el
//  monitoreo funcione, y dice cuál es el siguiente paso cuando algo falta.
//
//    npm run wa                       diagnóstico
//    npm run wa -- +524921234567      diagnóstico + mensaje de prueba
//
//  No toca la base de datos ni el resto del sistema: sólo habla con Meta.
//  Se puede correr antes de levantar nada.
//
//  El orden de las comprobaciones no es casual, va de la causa al síntoma:
//  si el token está vencido no tiene caso revisar plantillas.
// ============================================================================
const V = process.env.WA_VERSION?.trim() || 'v21.0';
const BASE = `https://graph.facebook.com/${V}`;

const TOKEN   = (process.env.WA_TOKEN ?? '').trim();
const CUENTA  = (process.env.WA_ID_CUENTA ?? '').trim();
const NUMERO  = (process.env.WA_ID_NUMERO ?? '').trim();
const APP_ID  = (process.env.WA_APP_ID ?? '').trim();
const SECRETO = (process.env.WA_APP_SECRET ?? '').trim();
const VERIFY  = (process.env.WA_VERIFY_TOKEN ?? '').trim();

const c = {
  ok:   (t) => `\x1b[32m✓\x1b[0m ${t}`,
  mal:  (t) => `\x1b[31m✗\x1b[0m ${t}`,
  ojo:  (t) => `\x1b[33m!\x1b[0m ${t}`,
  info: (t) => `\x1b[36m·\x1b[0m ${t}`,
  tit:  (t) => `\n\x1b[1m${t}\x1b[0m`,
  gris: (t) => `\x1b[90m${t}\x1b[0m`,
};

let problemas = 0;
const pendientes = [];
function falla(mensaje, comoArreglar) {
  problemas++;
  console.log(c.mal(mensaje));
  if (comoArreglar) pendientes.push(comoArreglar);
}

async function graph(ruta, opciones = {}) {
  const r = await fetch(`${BASE}/${ruta}`, {
    ...opciones,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(opciones.headers ?? {}) },
  });
  const datos = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = datos?.error ?? {};
    const err = new Error(e.message ?? `HTTP ${r.status}`);
    err.meta = e;
    throw err;
  }
  return datos;
}

// ── 0. ¿Están las variables? ───────────────────────────────────────────────
function revisarVariables() {
  console.log(c.tit('1. Variables de entorno'));
  const obligatorias = [
    ['WA_TOKEN', TOKEN, 'Token de acceso permanente del usuario del sistema'],
    ['WA_ID_CUENTA', CUENTA, 'ID de la cuenta de WhatsApp Business (WABA)'],
    ['WA_ID_NUMERO', NUMERO, 'ID del número de teléfono (NO el número en sí)'],
  ];
  for (const [clave, valor, que] of obligatorias) {
    if (valor) console.log(c.ok(`${clave} ${c.gris(`— ${que}`)}`));
    else falla(`${clave} está vacío ${c.gris(`— ${que}`)}`, `Llena ${clave} en el .env`);
  }
  if (SECRETO) console.log(c.ok(`WA_APP_SECRET ${c.gris('— firma de los webhooks')}`));
  else falla('WA_APP_SECRET está vacío', 'Llena WA_APP_SECRET: sin él el webhook acepta ubicaciones falsas y en producción el API ni arranca');

  if (VERIFY && VERIFY !== 'cambiame') console.log(c.ok('WA_VERIFY_TOKEN'));
  else console.log(c.ojo(`WA_VERIFY_TOKEN sin definir ${c.gris('— lo inventas tú, va igual aquí y en el panel de Meta')}`));

  if (!APP_ID) {
    console.log(c.info(`WA_APP_ID no está ${c.gris('— opcional, pero permite ver cuándo caduca el token')}`));
  }
  return TOKEN && CUENTA;
}

// ── 1. El token ────────────────────────────────────────────────────────────
// Es de lejos la causa más común de que esto deje de funcionar: la gente
// copia el token temporal de la pantalla de pruebas, que dura 24 horas.
async function revisarToken() {
  console.log(c.tit('2. Token de acceso'));
  try {
    const yo = await graph('me?fields=id,name');
    console.log(c.ok(`El token sirve ${c.gris(`— ${yo.name ?? yo.id}`)}`));
  } catch (e) {
    falla(`El token no sirve: ${e.message}`,
      'Genera un token nuevo. Meta Business → Usuarios del sistema → Generar token');
    return false;
  }

  if (!APP_ID || !SECRETO) {
    console.log(c.ojo('No puedo revisar la caducidad sin WA_APP_ID y WA_APP_SECRET'));
    return true;
  }
  try {
    const r = await fetch(
      `${BASE}/debug_token?input_token=${encodeURIComponent(TOKEN)}` +
      `&access_token=${encodeURIComponent(`${APP_ID}|${SECRETO}`)}`,
    );
    const d = (await r.json())?.data ?? {};
    const permisos = (d.scopes ?? []).join(', ') || '(ninguno)';
    if (d.expires_at === 0 || d.expires_at === undefined) {
      console.log(c.ok('El token no caduca (usuario del sistema)'));
    } else {
      const cuando = new Date(d.expires_at * 1000);
      const dias = Math.round((cuando - Date.now()) / 86_400_000);
      if (dias <= 2) {
        falla(`El token caduca ${cuando.toLocaleString('es-MX')} (${dias} días)`,
          'Ese es un token temporal de pruebas. Para producción usa uno de usuario del sistema, que no caduca');
      } else {
        console.log(c.ojo(`El token caduca el ${cuando.toLocaleDateString('es-MX')} (${dias} días)`));
      }
    }
    const faltan = ['whatsapp_business_messaging', 'whatsapp_business_management']
      .filter((p) => !(d.scopes ?? []).includes(p));
    if (faltan.length) {
      falla(`Al token le faltan permisos: ${faltan.join(', ')}`,
        'Al generar el token marca whatsapp_business_messaging y whatsapp_business_management');
    } else {
      console.log(c.ok(`Permisos correctos ${c.gris(`— ${permisos}`)}`));
    }
  } catch {
    console.log(c.ojo('No se pudo consultar debug_token (revisa WA_APP_ID / WA_APP_SECRET)'));
  }
  return true;
}

// ── 2. La cuenta y el número ───────────────────────────────────────────────
async function revisarNumero() {
  console.log(c.tit('3. Cuenta y número'));
  try {
    const waba = await graph(`${CUENTA}?fields=id,name,timezone_id,account_review_status`);
    console.log(c.ok(`WABA: ${waba.name} ${c.gris(`(${waba.id})`)}`));
    if (waba.account_review_status && waba.account_review_status !== 'APPROVED') {
      console.log(c.ojo(`Revisión de la cuenta: ${waba.account_review_status}`));
    }
  } catch (e) {
    falla(`No puedo leer la WABA ${CUENTA}: ${e.message}`,
      'Revisa WA_ID_CUENTA, y que el usuario del sistema tenga asignada esa cuenta de WhatsApp con acceso total');
    return null;
  }

  let numeros = [];
  try {
    const r = await graph(
      `${CUENTA}/phone_numbers?fields=id,display_phone_number,verified_name,` +
      'quality_rating,code_verification_status,throughput',
    );
    numeros = r.data ?? [];
  } catch (e) {
    falla(`No pude listar los números: ${e.message}`);
    return null;
  }

  if (!numeros.length) {
    falla('La cuenta no tiene números dados de alta', 'Agrega un número en Meta Business → Cuentas de WhatsApp');
    return null;
  }

  console.log(c.info(`${numeros.length} número(s) en la cuenta:`));
  for (const n of numeros) {
    const esteEs = n.id === NUMERO;
    const marca = esteEs ? '\x1b[32m➜\x1b[0m' : ' ';
    console.log(`   ${marca} ${n.display_phone_number}  ${c.gris(`id=${n.id}  «${n.verified_name}»  calidad=${n.quality_rating ?? '?'}`)}`);
  }

  const elegido = numeros.find((n) => n.id === NUMERO);
  if (!elegido) {
    falla(`WA_ID_NUMERO=${NUMERO || '(vacío)'} no está en esta cuenta`,
      `Pon en WA_ID_NUMERO el id de arriba del número que vas a usar, por ejemplo ${numeros[0].id}`);
    return null;
  }
  console.log(c.ok(`Vas a mandar desde ${elegido.display_phone_number} («${elegido.verified_name}»)`));
  if (elegido.quality_rating && !['GREEN', 'UNKNOWN'].includes(elegido.quality_rating)) {
    console.log(c.ojo(`Calidad del número: ${elegido.quality_rating}. Si baja a roja, Meta limita los envíos`));
  }
  return elegido;
}

// ── 3. Plantillas ──────────────────────────────────────────────────────────
// Sin plantilla aprobada no se puede iniciar una conversación, y todos los
// marcajes de la madrugada arrancan fuera de la ventana de 24 h.
async function revisarPlantillas() {
  console.log(c.tit('4. Plantillas'));
  let ps = [];
  try {
    const r = await graph(`${CUENTA}/message_templates?fields=name,status,category,language&limit=100`);
    ps = r.data ?? [];
  } catch (e) {
    falla(`No pude listar las plantillas: ${e.message}`);
    return null;
  }

  if (!ps.length) {
    falla('No hay ninguna plantilla',
      'Crea una plantilla de categoría UTILITY en es_MX. Es obligatoria: los marcajes de las 3:30 AM siempre caen fuera de la ventana de 24 h');
    return null;
  }

  const aprobadas = ps.filter((p) => p.status === 'APPROVED');
  console.log(c.info(`${ps.length} plantilla(s), ${aprobadas.length} aprobada(s):`));
  for (const p of ps.slice(0, 15)) {
    const senal = p.status === 'APPROVED' ? '\x1b[32m✓\x1b[0m'
      : p.status === 'PENDING' ? '\x1b[33m…\x1b[0m' : '\x1b[31m✗\x1b[0m';
    console.log(`   ${senal} ${p.name} ${c.gris(`${p.language} · ${p.category} · ${p.status}`)}`);
  }

  const marcaje = aprobadas.find((p) => p.name === 'marcaje_despertar' && p.language === 'es_MX');
  if (marcaje) {
    console.log(c.ok('La plantilla marcaje_despertar (es_MX) está aprobada'));
  } else {
    console.log(c.ojo('Falta la plantilla marcaje_despertar en es_MX, que es la que usa el sistema por defecto'));
    pendientes.push('Crea la plantilla UTILITY «marcaje_despertar» en es_MX, o cambia el parámetro wa.plantilla_marcaje1 al nombre que sí tengas');
  }
  return aprobadas;
}

// ── 4. Webhook ─────────────────────────────────────────────────────────────
// Sin el campo messages suscrito no llegan las respuestas de los conductores,
// y sin respuestas no hay semáforo ni ventana de 24 h: todo saldría por
// plantilla, que es la que cuesta.
async function revisarWebhook() {
  console.log(c.tit('5. Webhook'));
  try {
    const r = await graph(`${CUENTA}/subscribed_apps`);
    const apps = r.data ?? [];
    if (!apps.length) {
      falla('Ninguna app está suscrita a esta cuenta',
        'En el panel de la app: WhatsApp → Configuración → Webhooks → Administrar, y suscribe la WABA');
      return;
    }
    for (const a of apps) {
      console.log(c.ok(`App suscrita: ${a.whatsapp_business_api_data?.name ?? a.whatsapp_business_api_data?.id ?? '?'}`));
    }
    console.log(c.info('Verifica a mano que el campo «messages» esté palomeado en el panel: la API no lo reporta'));
  } catch (e) {
    console.log(c.ojo(`No pude leer las suscripciones: ${e.message}`));
  }
  console.log(c.info('El webhook necesita una URL pública con HTTPS. localhost no sirve: Meta tiene que poder llegarle'));
}

// ── 5. Envío de prueba ─────────────────────────────────────────────────────
async function enviarPrueba(destino, aprobadas, numero) {
  console.log(c.tit(`6. Mensaje de prueba a ${destino}`));

  if (!/^\+\d{10,15}$/.test(destino)) {
    falla(`«${destino}» no es un número E.164. Se escribe así: +524921234567`);
    return;
  }
  if (!numero) {
    console.log(c.ojo('No mando nada: el número de origen no quedó bien configurado'));
    return;
  }

  // Primer contacto: siempre fuera de la ventana de 24 h, así que va por
  // plantilla. hello_world es la que Meta crea sola y sirve de prueba de humo.
  const hola = (aprobadas ?? []).find((p) => p.name === 'hello_world');
  const sinVariables = (aprobadas ?? []).find((p) => p.name === 'marcaje_despertar');
  const usar = hola ?? sinVariables ?? (aprobadas ?? [])[0];
  if (!usar) {
    falla('No hay ninguna plantilla aprobada con la cual probar');
    return;
  }
  console.log(c.info(`Usando la plantilla «${usar.name}» (${usar.language})`));

  try {
    const r = await graph(`${NUMERO}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: destino,
        type: 'template',
        template: { name: usar.name, language: { code: usar.language } },
      }),
    });
    const id = r?.messages?.[0]?.id;
    console.log(c.ok(`Enviado. wa_message_id = ${id}`));
    console.log(c.info('Revisa el teléfono. Si contestas cualquier cosa, se abre la ventana de 24 h'));
    console.log(c.info('y a partir de ahí los mensajes del sistema no le cuestan nada al negocio.'));
  } catch (e) {
    falla(`Meta rechazó el envío: ${e.message}`);
    if (e.meta?.error_data?.details) console.log(c.gris(`   detalle: ${e.meta.error_data.details}`));
    if (e.meta?.code === 131030) {
      pendientes.push('Ese número no está en la lista de destinatarios de prueba. Con un número de pruebas sólo se puede escribir a 5 números dados de alta en el panel');
    }
    if (e.meta?.code === 131047 || e.meta?.code === 470) {
      pendientes.push('La ventana de 24 h está cerrada: hay que iniciar con plantilla, no con texto libre');
    }
  }
}

// ── Corrida ────────────────────────────────────────────────────────────────
const destino = process.argv[2];

console.log(`\x1b[1mDiagnóstico de WhatsApp Cloud API\x1b[0m ${c.gris(`· ${BASE}`)}`);

if (!revisarVariables()) {
  console.log(c.tit('No sigo: sin token y sin WABA no hay nada que revisar.'));
  console.log(pendientes.map((p) => `  → ${p}`).join('\n'));
  process.exit(1);
}

if (await revisarToken()) {
  const numero = await revisarNumero();
  const aprobadas = await revisarPlantillas();
  await revisarWebhook();
  if (destino) await enviarPrueba(destino, aprobadas, numero);
  else console.log(c.tit('Para mandar un mensaje de prueba: npm run wa -- +524921234567'));
}

console.log(c.tit(problemas ? `Resultado: ${problemas} cosa(s) por arreglar` : 'Resultado: todo en orden'));
if (pendientes.length) console.log(pendientes.map((p, i) => `  ${i + 1}. ${p}`).join('\n'));
console.log('');
process.exit(problemas ? 1 : 0);
