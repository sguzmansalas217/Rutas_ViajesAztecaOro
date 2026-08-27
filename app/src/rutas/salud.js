import { unaFila } from '../db.js';

export default async function salud(app) {
  // Lo usa el healthcheck de Docker y el monitoreo del droplet.
  app.get('/salud', async (req, reply) => {
    try {
      await unaFila('SELECT 1 AS ok');
      return { ok: true, hora: new Date().toISOString() };
    } catch {
      return reply.code(503).send({ ok: false, error: 'base de datos no disponible' });
    }
  });
}
