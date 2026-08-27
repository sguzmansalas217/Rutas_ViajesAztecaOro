// Aplica las migraciones .sql en orden alfabético, una sola vez cada una.
// Se ejecuta en cada despliegue: es idempotente.
import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pool } from './db.js';
import { log } from './log.js';
import { config } from './config.js';
import { hashClave } from './dominio/claves.js';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migraciones');

async function asegurarTablaControl(cliente) {
  await cliente.query(`
    CREATE TABLE IF NOT EXISTS migracion (
      nombre     text PRIMARY KEY,
      hash       text NOT NULL,
      aplicada_en timestamptz NOT NULL DEFAULT now()
    )`);
}

async function sembrarAdmin(cliente) {
  const { correo, clave, nombre } = config.admin;
  if (!correo || !clave) {
    log.warn('ADMIN_CORREO/ADMIN_CLAVE no definidos: no se creó usuario administrador');
    return;
  }
  const { rowCount } = await cliente.query('SELECT 1 FROM usuario LIMIT 1');
  if (rowCount > 0) return;

  await cliente.query(
    `INSERT INTO usuario (correo, nombre, hash_clave, rol)
     VALUES ($1, $2, $3, 'admin')`,
    [correo.toLowerCase(), nombre, hashClave(clave)],
  );
  log.info({ correo }, 'usuario administrador creado');
}

export async function migrar() {
  const cliente = await pool.connect();
  try {
    await asegurarTablaControl(cliente);

    const archivos = (await readdir(DIR)).filter((f) => f.endsWith('.sql')).sort();
    const { rows } = await cliente.query('SELECT nombre, hash FROM migracion');
    const aplicadas = new Map(rows.map((r) => [r.nombre, r.hash]));

    for (const archivo of archivos) {
      const sql = await readFile(join(DIR, archivo), 'utf8');
      const hash = createHash('sha256').update(sql).digest('hex');

      if (aplicadas.has(archivo)) {
        if (aplicadas.get(archivo) !== hash) {
          // Una migración ya aplicada que cambió de contenido es un error de
          // proceso: hay que crear una migración nueva, no editar la anterior.
          throw new Error(
            `La migración ${archivo} ya fue aplicada pero su contenido cambió. ` +
              'Crea una migración nueva en lugar de editar una existente.',
          );
        }
        continue;
      }

      log.info({ archivo }, 'aplicando migración');
      await cliente.query('BEGIN');
      try {
        await cliente.query(sql);
        await cliente.query('INSERT INTO migracion (nombre, hash) VALUES ($1, $2)', [archivo, hash]);
        await cliente.query('COMMIT');
      } catch (err) {
        await cliente.query('ROLLBACK');
        throw new Error(`Falló la migración ${archivo}: ${err.message}`);
      }
    }

    await sembrarAdmin(cliente);
    log.info({ total: archivos.length }, 'migraciones al día');
  } finally {
    cliente.release();
  }
}

// Permite `node src/migrar.js` como paso independiente del despliegue.
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('migrar.js')) {
  migrar()
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch((err) => {
      log.error({ err: err.message }, 'error al migrar');
      process.exit(1);
    });
}
