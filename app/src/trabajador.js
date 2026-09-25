// ============================================================================
//  TRABAJADOR
//
//  Dispara los marcajes y levanta las alertas. Corre como un segundo proceso
//  del mismo contenedor-imagen (npm run trabajador).
//
//  Diseño deliberado: NO se crea un job de BullMQ por cada uno de los ~1,200
//  marcajes diarios. Un tic cada 30 s consulta la tabla y toma lo que ya venció.
//  Es más simple, sobrevive a un Redis vacío y la base es la única verdad.
//  BullMQ se usa sólo para lo que sí necesita cola: el envío en sí, con
//  reintentos y control de concurrencia contra el rate limit de Meta.
// ============================================================================
import { writeFile } from 'node:fs/promises';

import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';

import { config } from './config.js';
import { log } from './log.js';
import { filas, consultar, unaFila, parametro, pool } from './db.js';
import { enviarAConductor } from './infra/whatsapp.js';
import { decidirCanal } from './dominio/ventana.js';
import { partirCelda } from './dominio/normalizar.js';
import { avisarEncargados } from './dominio/avisos.js';

const conexion = new IORedis(config.redis.url, { maxRetriesPerRequest: null });
const colaEnvios = new Queue('envios', { connection: conexion });

function texto(plantilla, datos) {
  return String(plantilla).replace(/\{(\w+)\}/g, (_, k) => datos[k] ?? '');
}

// El aviso lo lee un encargado en su celular, no un programador. "marcaje 3"
// lo obliga a acordarse de cuál es; "filtro" lo dice.
const NOMBRE_MARCAJE = { 1: 'despertar', 2: 'revisión', 3: 'filtro', 4: 'salida' };

// ── Tic: toma los marcajes vencidos y los encola ────────────────────────────
async function tic() {
  // Ventana de 15 minutos hacia atrás: si el worker estuvo caído no se dispara
  // un marcaje de hace tres horas — a esa hora ya no sirve y sólo cuesta.
  const pendientes = await filas(
    `UPDATE marcaje m
        SET estado = 'enviado', enviado_en = now(), intentos = m.intentos + 1
       FROM asignacion a, ruta r, conductor c, vehiculo v
      WHERE m.asignacion_id = a.id
        AND a.ruta_id = r.id
        AND a.conductor_id = c.id
        AND a.vehiculo_id = v.id
        AND m.estado = 'pendiente'
        AND a.estado = 'programada'
        AND c.activo AND c.telefono_e164 IS NOT NULL
        -- El contrato cubre un número fijo de unidades. Aquí es donde de
        -- verdad importa: cada mensaje cuesta, y el Excel trae muchas más
        -- unidades de las contratadas. Sin este filtro se pagan mensajes
        -- de unidades que nadie contrató.
        AND v.contratado
        AND m.programado_para <= now()
        AND m.programado_para >  now() - interval '15 minutes'
      RETURNING m.id, m.numero, c.id AS conductor_id, c.nombre, c.telefono_e164,
                r.nombre AS ruta, r.hora_monitoreo, v.clave AS unidad, a.texto_origen`,
  );

  for (const p of pendientes) {
    // Al conductor se le habla como el Excel de esta semana escribió su
    // unidad (V-5), no con la clave fusionada que usa la factura (5): son
    // la misma unidad física, pero "V-5" es lo que él reconoce, y fusionar
    // V-5 con 5 es un tema de cobro, no de a quién le está hablando el
    // sistema. Si por algo no se puede sacar del texto de la celda, se cae
    // en la clave de siempre.
    p.unidad = partirCelda(p.texto_origen ?? '').unidad || p.unidad;
    await colaEnvios.add('marcaje', p, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 20_000 },
      removeOnComplete: 1000,
      removeOnFail: 500,
    });
  }
  if (pendientes.length) log.info({ n: pendientes.length }, 'marcajes encolados');

  await vencerYAlertar();
}

// ── Vencimientos y alertas ──────────────────────────────────────────────────
async function vencerYAlertar() {
  const espera = Number(await parametro('alerta.espera_min', 5));

  const vencidos = await filas(
    `UPDATE marcaje m
        SET estado = 'vencido', semaforo = 'rojo', alertado_en = now()
       FROM asignacion a, ruta r
      WHERE m.asignacion_id = a.id AND a.ruta_id = r.id
        AND m.estado = 'enviado'
        AND m.respondido_en IS NULL
        AND m.alertado_en IS NULL
        AND m.enviado_en < now() - ($1 || ' minutes')::interval
      RETURNING m.numero, r.nombre AS ruta, r.encargado,
                (SELECT c.nombre FROM conductor c WHERE c.id = a.conductor_id) AS conductor,
                (SELECT c.telefono_e164 FROM conductor c WHERE c.id = a.conductor_id) AS telefono`,
    [String(espera)],
  );

  if (!vencidos.length) return;
  log.warn({ n: vencidos.length }, '🔴 marcajes sin respuesta');

  // Dos formas de la misma lista. La de renglones es la que se lee bien en el
  // celular; la de una línea es para la plantilla, porque Meta rechaza el envío
  // entero si un parámetro trae saltos de línea.
  //
  // El teléfono en formato +52... WhatsApp lo detecta solo y lo pinta como
  // enlace tocable —es el "botón de llamada" sin necesitar una plantilla
  // nueva con componente de llamada aprobado en Meta—.
  const items = vencidos
    .slice(0, 15)
    .map((v) => `${v.conductor ?? '?'} — ${v.ruta} (${NOMBRE_MARCAJE[v.numero] ?? `marcaje ${v.numero}`})${v.telefono ? ` · 📞 ${v.telefono}` : ''}`);
  const extra = vencidos.length > 15 ? ` …y ${vencidos.length - 15} más` : '';
  const texto = `🔴 Sin respuesta (${vencidos.length}):\n${items.map((i) => `• ${i}`).join('\n')}${extra}`;

  await avisarEncargados(texto, [String(vencidos.length), items.join(' · ') + extra]);
}

// ── Procesador de la cola de envíos ─────────────────────────────────────────
const trabajadorEnvios = new Worker(
  'envios',
  async (job) => {
    const m = job.data;
    const datos = {
      nombre: (m.nombre ?? '').split(' ')[0],
      ruta: m.ruta,
      unidad: m.unidad ?? '',
      hora: String(m.hora_monitoreo ?? '').slice(0, 5),
    };

    // El único texto que tiene plantilla aprobada es el despertar. Si el
    // conductor no contestó el 1 a tiempo, la ventana sigue cerrada cuando
    // toca mandar el 2, el 3 o el 4 — y sin esta guarda, infra/whatsapp.js
    // cae al mismo default (marcaje_despertar) diga lo que diga el marcaje:
    // «¿ya estás despierto?» en vez de «¿la unidad está bien?». No se manda
    // nada; el marcaje ya quedó 'enviado' desde el tic() y el aviso de rojo
    // (vencerYAlertar) es quien le avisa al encargado que ese no contestó.
    if (m.numero !== 1 && (await decidirCanal(m.conductor_id)) === 'plantilla') {
      await consultar(
        `INSERT INTO mensaje_saliente (conductor_id, marcaje_id, tipo, cuerpo, estado, costo_usd, error)
         VALUES ($1, $2, 'libre', $3, 'fallido', 0, $4)`,
        [
          m.conductor_id, m.id, `marcaje ${m.numero} sin enviar`,
          'Ventana cerrada: no se manda por plantilla equivocada (no hay plantilla aprobada para este marcaje). Se avisa al encargado si no contesta.',
        ],
      );
      log.warn(
        { conductor: m.nombre, marcaje: m.id, numero: m.numero },
        'ventana cerrada: marcaje 2/3/4 no se manda, queda para el aviso de rojo',
      );
      return;
    }

    // El filtro ya no pide la ubicación de golpe: primero pregunta si llegó.
    // Cuando sale, el conductor muchas veces va todavía en camino, y el botón
    // nativo de ubicación en ese momento sólo sirve para mandar el punto
    // equivocado. Al tocar «Ya llegué» se le pide la ubicación (webhook.js).
    if (m.numero === 3) {
      const t = texto(await parametro('texto.marcaje3_llegada', '{nombre}, ¿ya llegaste al filtro?'), datos);
      return enviarAConductor({
        conductorId: m.conductor_id,
        telefono: m.telefono_e164,
        texto: t,
        variables: [datos.nombre, datos.ruta, datos.hora],
        marcajeId: m.id,
        botones: [{ id: `m3-llegue-${m.id}`, titulo: String(await parametro('boton.marcaje3_llegue', 'Ya llegué 📍')) }],
      });
    }

    const t = texto(await parametro(`texto.marcaje${m.numero}`, 'Confirma por favor.'), datos);

    // El despertar va sin botones a propósito: casi siempre sale por plantilla
    // —a esa hora nadie tiene ventana abierta— y los botones de una plantilla
    // se definen en Meta, no aquí, así que ponerlos sólo servía el día que la
    // ventana ya estaba abierta. Se contesta escribiendo.
    //
    // Donde sí sirven es en el 2 y el 4, que salen con el conductor despierto y
    // muchas veces al volante: un toque es la diferencia entre que conteste y
    // que no. Y no cuestan: para entonces la ventana está abierta.
    let botones = null;
    if (m.numero === 2) {
      botones = [
        { id: `m2-si-${m.id}`, titulo: String(await parametro('boton.marcaje2_si', 'Todo bien ✅')) },
        { id: `m2-no-${m.id}`, titulo: String(await parametro('boton.marcaje2_no', 'Hay una falla')) },
      ];
    } else if (m.numero === 4) {
      // Un solo botón. Uno de «todavía no» sería una respuesta que cierra el
      // marcaje diciendo que no salió: si no ha salido, lo honesto es que se
      // quede abierto y se ponga en rojo.
      botones = [{ id: `m4-si-${m.id}`, titulo: String(await parametro('boton.marcaje4_si', 'Ya salí 🚌')) }];
    }

    return enviarAConductor({
      conductorId: m.conductor_id,
      telefono: m.telefono_e164,
      texto: t,
      variables: [datos.nombre, datos.ruta, datos.hora],
      marcajeId: m.id,
      botones,
    });
  },
  {
    connection: conexion,
    concurrency: 5, // no atropellar el rate limit de Meta
    limiter: { max: 40, duration: 1000 },
  },
);

trabajadorEnvios.on('failed', (job, err) => {
  log.error({ err, marcaje: job?.data?.id, intento: job?.attemptsMade }, 'envío fallido');
});

// ── Cierre de mes automático (informativo, no factura) ──────────────────────
async function avisoDeCorte() {
  const hoy = new Date();
  if (hoy.getDate() !== 1) return;
  const anterior = new Date(hoy.getFullYear(), hoy.getMonth() - 1, 1);
  const periodo = `${anterior.getFullYear()}-${String(anterior.getMonth() + 1).padStart(2, '0')}-01`;
  const ya = await unaFila('SELECT periodo FROM corte_mensual WHERE periodo = $1', [periodo]);
  if (!ya) log.warn({ periodo }, '📄 el periodo anterior sigue sin cerrar');
}

// ── Latido ──────────────────────────────────────────────────────────────────
//  El trabajador no escucha ningún puerto, así que no puede compartir el
//  healthcheck de la API (curl a /salud): Docker lo daba por enfermo siempre.
//  En vez de eso deja una marca de tiempo cada vez que el tic TERMINA BIEN.
//  Que el proceso siga vivo no basta: si el tic revienta cada 30 s el bucle
//  sigue girando, nadie manda nada y por fuera se vería sano.
const LATIDO = '/tmp/latido-trabajador';

async function latir() {
  try {
    await writeFile(LATIDO, new Date().toISOString());
  } catch (e) {
    log.warn({ err: e }, 'no se pudo escribir el latido');
  }
}

// ── Arranque ────────────────────────────────────────────────────────────────
let corriendo = true;

async function principal() {
  const intervalo = Number(await parametro('worker.intervalo_seg', 30)) * 1000;
  log.info({ intervalo, simulado: config.whatsapp.simulado }, 'trabajador arriba');

  while (corriendo) {
    try {
      await tic();
      await avisoDeCorte();
      await latir();
    } catch (e) {
      log.error({ err: e }, 'error en el tic del trabajador');
    }
    await new Promise((r) => setTimeout(r, intervalo));
  }
}

const cerrar = async (senal) => {
  log.info({ senal }, 'cerrando el trabajador');
  corriendo = false;
  try {
    await trabajadorEnvios.close();
    await colaEnvios.close();
    await conexion.quit();
    await pool.end();
  } finally {
    process.exit(0);
  }
};
process.on('SIGTERM', () => cerrar('SIGTERM'));
process.on('SIGINT', () => cerrar('SIGINT'));

principal().catch((e) => {
  log.error({ err: e }, 'el trabajador no pudo arrancar');
  process.exit(1);
});
