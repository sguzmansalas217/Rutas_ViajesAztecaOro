// ============================================================================
//  API — Fastify
//  Arranca migrando la base. Un contenedor recién levantado queda operativo
//  sin pasos manuales: es lo que hace que el despliegue sea un solo comando.
// ============================================================================
import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';

import { config } from './config.js';
import { esProveedor } from './dominio/proveedor.js';
import { log } from './log.js';
import { pool } from './db.js';
import { migrar } from './migrar.js';

import salud from './rutas/salud.js';
import auth from './rutas/auth.js';
import catalogos from './rutas/catalogos.js';
import operacion from './rutas/operacion.js';
import cobro from './rutas/cobro.js';
import importacion from './rutas/importacion.js';
import webhook from './rutas/webhook.js';

export async function construirServidor() {
  const app = Fastify({
    loggerInstance: log,
    trustProxy: true, // vamos detrás de Nginx
    bodyLimit: 2 * 1024 * 1024,
  });

  await app.register(helmet, { contentSecurityPolicy: false }); // el CSP lo pone Nginx
  await app.register(cors, {
    origin: config.produccion ? [config.urlPublica] : true,
    credentials: true,
    // Sin esto el navegador esconde el encabezado del token renovado y la
    // sesión se seguiría cayendo en desarrollo, donde el portal y la API están
    // en puertos distintos. En producción van tras el mismo Nginx y no aplica.
    exposedHeaders: ['x-token-nuevo'],
  });
  await app.register(cookie, { secret: config.jwt.secreto });
  await app.register(jwt, {
    secret: config.jwt.secreto,
    sign: { expiresIn: config.jwt.expira },
  });
  await app.register(rateLimit, {
    max: 300,
    timeWindow: '1 minute',
    // El webhook de Meta puede llegar en ráfagas legítimas y ya va firmado.
    allowList: (req) => req.url.startsWith('/webhook'),
  });
  await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024, files: 1 } });

  // ── Autenticación ─────────────────────────────────────────────────────────
  //
  //  El token se renueva solo. Antes duraba lo que durara y ya: a los treinta
  //  minutos exactos la sesión moría aunque se estuviera capturando en ese
  //  momento, y lo que se llevaba por delante era el formulario a medias.
  //
  //  Ahora, pasada la mitad de su vida, cada petición devuelve uno nuevo. Para
  //  quien usa el portal la sesión no se acaba nunca; para quien deja el
  //  navegador abierto y se va, se acaba igual que antes. Eso es lo que se
  //  quiere medir: inactividad, no el reloj desde que entró.
  //
  //  Viaja en un encabezado y no sólo en la cookie porque la autenticación de
  //  verdad va por 'Authorization: Bearer' —la cookie no está conectada al
  //  verificador—, así que renovar sólo la cookie no habría servido de nada.
  async function verificarYRenovar(req, reply) {
    await req.jwtVerify();

    const vida = req.user.exp - req.user.iat;
    const resta = req.user.exp - Math.floor(Date.now() / 1000);
    if (!(vida > 0) || resta > vida / 2) return;

    const token = app.jwt.sign({ id: req.user.id, correo: req.user.correo, rol: req.user.rol });
    reply.header('x-token-nuevo', token);
    reply.setCookie('token', token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.produccion,
      path: '/',
      maxAge: vida,
    });
  }

  app.decorate('autenticar', async (req, reply) => {
    try {
      await verificarYRenovar(req, reply);
    } catch {
      return reply.code(401).send({ error: 'No autenticado' });
    }
  });

  app.decorate('exigirRol', (...roles) => async (req, reply) => {
    try {
      await verificarYRenovar(req, reply);
    } catch {
      return reply.code(401).send({ error: 'No autenticado' });
    }
    if (!roles.includes(req.user.rol)) {
      return reply.code(403).send({ error: 'Sin permisos para esta operación' });
    }
  });

  // Hay cosas que no son de 'admin', son del proveedor. El porqué está en
  // dominio/proveedor.js.
  app.decorate('exigirProveedor', async (req, reply) => {
    try {
      await verificarYRenovar(req, reply);
    } catch {
      return reply.code(401).send({ error: 'No autenticado' });
    }
    if (!esProveedor(req)) {
      return reply.code(403).send({ error: 'Sin permisos para esta operación' });
    }
  });

  // ── Manejo de errores: nunca filtrar internals al cliente ─────────────────
  app.setErrorHandler((err, req, reply) => {
    const codigo = err.statusCode && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500;
    if (codigo >= 500) req.log.error({ err }, 'error no controlado');
    reply.code(codigo).send({
      error: codigo >= 500 ? 'Error interno' : err.message,
    });
  });

  app.setNotFoundHandler((req, reply) => reply.code(404).send({ error: 'No encontrado' }));

  // ── Rutas ─────────────────────────────────────────────────────────────────
  await app.register(salud);
  await app.register(webhook, { prefix: '/webhook' });
  await app.register(auth, { prefix: '/api/auth' });
  await app.register(catalogos, { prefix: '/api/catalogos' });
  await app.register(operacion, { prefix: '/api/operacion' });
  await app.register(cobro, { prefix: '/api/cobro' });
  await app.register(importacion, { prefix: '/api/carga' });

  return app;
}

async function principal() {
  await migrar();
  const app = await construirServidor();

  const cerrar = async (senal) => {
    log.info({ senal }, 'cerrando el servidor');
    try {
      await app.close();
      await pool.end();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => cerrar('SIGTERM'));
  process.on('SIGINT', () => cerrar('SIGINT'));

  await app.listen({ port: config.puerto, host: '0.0.0.0' });
  log.info({ puerto: config.puerto, simulado: config.whatsapp.simulado }, 'API arriba');
}

if (process.argv[1]?.endsWith('servidor.js')) {
  principal().catch((e) => {
    log.error({ err: e }, 'no se pudo arrancar la API');
    process.exit(1);
  });
}
