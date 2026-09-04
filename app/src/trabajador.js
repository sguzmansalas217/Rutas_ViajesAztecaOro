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
import { enviarAConductor, pedirUbicacion, enviarAviso } from './infra/whatsapp.js';

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
                r.nombre AS ruta, r.hora_monitoreo, v.clave AS unidad`,
  );

  for (const p of pendientes) {
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
  const telefonoAviso = String(await parametro('aviso.encargado_telefono', '') || '');

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
                (SELECT c.nombre FROM conductor c WHERE c.id = a.conductor_id) AS conductor`,
    [String(espera)],
  );

  if (!vencidos.length) return;
  log.warn({ n: vencidos.length }, '🔴 marcajes sin respuesta');

  if (!telefonoAviso) {
    // Sin número configurado el rojo sólo existe en el Tablero. Se dice en el
    // log: es la diferencia entre "no hubo rojos" y "hubo y nadie se enteró".
    log.warn('sin aviso.encargado_telefono: los rojos no se avisan a nadie');
    return;
  }

  // Dos formas de la misma lista. La de renglones es la que se lee bien en el
  // celular; la de una línea es para la plantilla, porque Meta rechaza el envío
  // entero si un parámetro trae saltos de línea.
  const items = vencidos
    .slice(0, 15)
    .map((v) => `${v.conductor ?? '?'} — ${v.ruta} (${NOMBRE_MARCAJE[v.numero] ?? `marcaje ${v.numero}`})`);
  const extra = vencidos.length > 15 ? ` …y ${vencidos.length - 15} más` : '';

  const r = await enviarAviso(
    telefonoAviso,
    `🔴 Sin respuesta (${vencidos.length}):\n${items.map((i) => `• ${i}`).join('\n')}${extra}`,
    {
      plantilla: String(await parametro('wa.plantilla_alerta', 'alerta_sin_respuesta')),
      variables: [String(vencidos.length), items.join(' · ') + extra],
    },
  );

  if (r.ok) {
    // Cuando el aviso sale por plantilla se está pagando por avisar. Con un
    // encargado que no escribe nunca eso son 30 pesos al mes por nada: si
    // contesta el aviso, el resto del día sale gratis. Queda en el log para
    // que se note antes de que aparezca en el corte.
    if (r.canal === 'plantilla') {
      log.warn({ costoUsd: r.costoUsd }, 'aviso por plantilla: el encargado no tiene ventana abierta');
    }
    return;
  }
  log.error(
    { codigo: r.codigo, canal: r.canal, telefono: telefonoAviso },
    '🔴 el aviso NO llegó al encargado',
  );
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

    if (m.numero === 3) {
      const t = texto(await parametro('texto.marcaje3', 'Comparte tu ubicación.'), datos);
      return pedirUbicacion({
        conductorId: m.conductor_id, telefono: m.telefono_e164, texto: t, marcajeId: m.id,
      });
    }

    const t = texto(await parametro(`texto.marcaje${m.numero}`, 'Confirma por favor.'), datos);

    // Botones sólo en el marcaje 1: hacen que conteste de un toque y con eso
    // abre la ventana de 24 h. Los marcajes 2, 3 y 4 del día salen gratis.
    const botones = m.numero === 1
      ? [{ id: `m1-si-${m.id}`, titulo: 'Listo ✅' }, { id: `m1-no-${m.id}`, titulo: 'Problema' }]
      : null;

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
