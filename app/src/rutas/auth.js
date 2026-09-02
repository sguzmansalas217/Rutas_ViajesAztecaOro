import { z } from 'zod';
import { filas, unaFila, consultar, auditar } from '../db.js';
import { verificarClave, hashClave } from '../dominio/claves.js';
import { esProveedor } from '../dominio/proveedor.js';
import { config } from '../config.js';

// La cuenta del proveedor no se toca desde el portal: es la del despliegue y
// la que puede ver el margen. Si el administrador del cliente pudiera
// desactivarla o cambiarle la contraseña, se quedaría con el sistema entero.
function esLaCuentaDelProveedor(correo) {
  const proveedor = (config.admin.correo ?? '').trim().toLowerCase();
  return Boolean(proveedor) && correo?.trim().toLowerCase() === proveedor;
}

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

  app.get('/usuarios', { preHandler: [app.exigirRol('admin')] }, async () =>
    filas(
      `SELECT id, correo, nombre, rol, activo, ultimo_acceso, creado_en
         FROM usuario ORDER BY activo DESC, nombre`,
    ));

  // Alta de usuarios: sólo admin.
  app.post('/usuarios', { preHandler: [app.exigirRol('admin')] }, async (req, reply) => {
    const datos = z.object({
      correo: z.string().email(),
      nombre: z.string().min(2),
      clave: z.string().min(10),
      rol: z.enum(['admin', 'operador', 'consulta']),
    }).safeParse(req.body);
    if (!datos.success) return reply.code(400).send({ error: 'Datos inválidos' });

    // A la baja desde aquí: la tabla tiene CHECK (correo = lower(correo)) y
    // quien teclea el correo en el portal lo escribe como se le da la gana.
    const correo = datos.data.correo.trim().toLowerCase();
    const { nombre, clave, rol } = datos.data;
    const ya = await unaFila('SELECT id FROM usuario WHERE correo = $1', [correo]);
    if (ya) return reply.code(409).send({ error: 'Ese correo ya está registrado' });

    const nuevo = await unaFila(
      `INSERT INTO usuario (correo, nombre, hash_clave, rol) VALUES ($1, $2, $3, $4)
       RETURNING id, correo, nombre, rol, activo`,
      [correo, nombre.trim(), hashClave(clave), rol],
    );
    await auditar({ usuarioId: req.user.id, accion: 'alta_usuario', entidad: 'usuario', entidadId: nuevo.id, ip: req.ip });
    return nuevo;
  });

  // Dar de baja no borra: la bitácora y las cargas apuntan al usuario y hay
  // que poder seguir diciendo quién hizo qué. Se apaga y ya no entra.
  app.post('/usuarios/:id/activo', { preHandler: [app.exigirRol('admin')] }, async (req, reply) => {
    const activo = req.body?.activo;
    if (typeof activo !== 'boolean') return reply.code(400).send({ error: 'Falta activo' });

    const u = await unaFila('SELECT id, correo, nombre FROM usuario WHERE id = $1', [req.params.id]);
    if (!u) return reply.code(404).send({ error: 'No existe ese usuario' });
    if (String(u.id) === String(req.user.id)) {
      return reply.code(400).send({ error: 'No puedes darte de baja a ti mismo' });
    }
    if (esLaCuentaDelProveedor(u.correo) && !esProveedor(req)) {
      return reply.code(403).send({ error: 'Esa cuenta es la del proveedor del servicio' });
    }

    await consultar('UPDATE usuario SET activo = $2 WHERE id = $1', [u.id, activo]);
    await auditar({
      usuarioId: req.user.id, accion: activo ? 'alta_baja_usuario' : 'baja_usuario',
      entidad: 'usuario', entidadId: u.id, detalle: { activo }, ip: req.ip,
    });
    return { ok: true };
  });

  // Restablecer la contraseña de otro. No pide la actual —el administrador no
  // la sabe, para eso está— y por lo mismo queda en bitácora.
  app.post('/usuarios/:id/clave', { preHandler: [app.exigirRol('admin')] }, async (req, reply) => {
    const datos = z.object({ nueva: z.string().min(10) }).safeParse(req.body);
    if (!datos.success) {
      return reply.code(400).send({ error: 'La contraseña nueva debe tener al menos 10 caracteres' });
    }
    const u = await unaFila('SELECT id, correo FROM usuario WHERE id = $1', [req.params.id]);
    if (!u) return reply.code(404).send({ error: 'No existe ese usuario' });
    if (esLaCuentaDelProveedor(u.correo) && !esProveedor(req)) {
      return reply.code(403).send({ error: 'Esa cuenta es la del proveedor del servicio' });
    }

    await consultar('UPDATE usuario SET hash_clave = $2 WHERE id = $1', [u.id, hashClave(datos.data.nueva)]);
    await auditar({
      usuarioId: req.user.id, accion: 'restablece_clave', entidad: 'usuario',
      entidadId: u.id, ip: req.ip,
    });
    return { ok: true };
  });
}
