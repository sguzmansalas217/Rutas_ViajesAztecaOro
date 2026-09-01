import { z } from 'zod';
import { unaFila, consultar, auditar } from '../db.js';
import { verificarClave, hashClave } from '../dominio/claves.js';
import { config } from '../config.js';

const esquemaLogin = z.object({
  correo: z.string().email(),
  clave: z.string().min(8),
});

export default async function auth(app) {
  // Límite propio y estrecho: el login es el blanco natural de fuerza bruta.
  app.post('/login', {
    config: { rateLimit: { max: 10, timeWindow: '5 minutes' } },
  }, async (req, reply) => {
    const datos = esquemaLogin.safeParse(req.body);
    if (!datos.success) return reply.code(400).send({ error: 'Datos inválidos' });

    const { correo, clave } = datos.data;
    const usuario = await unaFila(
      'SELECT id, correo, nombre, rol, hash_clave, activo FROM usuario WHERE lower(correo) = lower($1)',
      [correo],
    );

    // Mismo mensaje y mismo costo en ambos casos: no revelar si el correo existe.
    if (!usuario || !usuario.activo || !verificarClave(clave, usuario.hash_clave)) {
      req.log.warn({ correo, ip: req.ip }, 'intento de login fallido');
      return reply.code(401).send({ error: 'Credenciales incorrectas' });
    }

    const token = app.jwt.sign({ id: usuario.id, correo: usuario.correo, rol: usuario.rol });

    await consultar('UPDATE usuario SET ultimo_acceso = now() WHERE id = $1', [usuario.id]);
    await auditar({ usuarioId: usuario.id, accion: 'login', entidad: 'usuario', entidadId: usuario.id, ip: req.ip });

    reply.setCookie('token', token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.produccion,
      path: '/',
      maxAge: 60 * 60 * 8,
    });

    return {
      token,
      usuario: { id: usuario.id, correo: usuario.correo, nombre: usuario.nombre, rol: usuario.rol },
    };
  });

  app.post('/salir', async (req, reply) => {
    reply.clearCookie('token', { path: '/' });
    return { ok: true };
  });

  app.get('/yo', { preHandler: [app.autenticar] }, async (req) => {
    const u = await unaFila('SELECT id, correo, nombre, rol FROM usuario WHERE id = $1', [req.user.id]);
    return { usuario: u };
  });

  app.post('/clave', { preHandler: [app.autenticar] }, async (req, reply) => {
    const datos = z.object({ actual: z.string(), nueva: z.string().min(10) }).safeParse(req.body);
    if (!datos.success) {
      return reply.code(400).send({ error: 'La contraseña nueva debe tener al menos 10 caracteres' });
    }
    const u = await unaFila('SELECT hash_clave FROM usuario WHERE id = $1', [req.user.id]);
    if (!verificarClave(datos.data.actual, u.hash_clave)) {
      // 400 y no 401: la sesión es válida —lo que viene mal es un campo del
      // cuerpo—. Con 401 el cliente entiende "se te venció la sesión", cierra
      // y manda al login, y quien se equivoca al teclear su contraseña actual
      // acaba fuera del sistema sin saber por qué.
      return reply.code(400).send({ error: 'La contraseña actual no coincide' });
    }
    await consultar('UPDATE usuario SET hash_clave = $2 WHERE id = $1', [req.user.id, hashClave(datos.data.nueva)]);
    await auditar({ usuarioId: req.user.id, accion: 'cambio_clave', entidad: 'usuario', entidadId: req.user.id, ip: req.ip });
    return { ok: true };
  });

  // Alta de usuarios: sólo admin.
  app.post('/usuarios', { preHandler: [app.exigirRol('admin')] }, async (req, reply) => {
    const datos = z.object({
      correo: z.string().email(),
      nombre: z.string().min(2),
      clave: z.string().min(10),
      rol: z.enum(['admin', 'operador', 'consulta']),
    }).safeParse(req.body);
    if (!datos.success) return reply.code(400).send({ error: 'Datos inválidos' });

    const { correo, nombre, clave, rol } = datos.data;
    const ya = await unaFila('SELECT id FROM usuario WHERE lower(correo) = lower($1)', [correo]);
    if (ya) return reply.code(409).send({ error: 'Ese correo ya está registrado' });

    const nuevo = await unaFila(
      `INSERT INTO usuario (correo, nombre, hash_clave, rol) VALUES ($1, $2, $3, $4)
       RETURNING id, correo, nombre, rol`,
      [correo, nombre, hashClave(clave), rol],
    );
    await auditar({ usuarioId: req.user.id, accion: 'alta_usuario', entidad: 'usuario', entidadId: nuevo.id, ip: req.ip });
    return nuevo;
  });
}
