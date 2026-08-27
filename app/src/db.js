import pg from 'pg';
import { config } from './config.js';

// numeric de Postgres llega como string para no perder precisión. Para los
// montos de facturación eso es lo correcto, pero aquí convertimos los que sí
// queremos como número en JS.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

export const pool = new pg.Pool({
  connectionString: config.db.url,
  max: config.db.maxConexiones,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on('error', (err) => {
  console.error('[db] error en cliente inactivo:', err.message);
});

export function consultar(sql, params = []) {
  return pool.query(sql, params);
}

export async function unaFila(sql, params = []) {
  const { rows } = await pool.query(sql, params);
  return rows[0] ?? null;
}

export async function filas(sql, params = []) {
  const { rows } = await pool.query(sql, params);
  return rows;
}

/** Ejecuta `fn` dentro de una transacción y hace rollback ante cualquier error. */
export async function enTransaccion(fn) {
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    const resultado = await fn(cliente);
    await cliente.query('COMMIT');
    return resultado;
  } catch (err) {
    await cliente.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    cliente.release();
  }
}

// ── Parámetros ──────────────────────────────────────────────────────────────
// Caché corta: se consultan en cada envío, pero deben poder cambiar en caliente
// desde el portal sin reiniciar nada.
const CACHE_MS = 15_000;
let cache = null;
let cacheEn = 0;

export async function parametros() {
  const ahora = Date.now();
  if (cache && ahora - cacheEn < CACHE_MS) return cache;
  const rows = await filas('SELECT clave, valor FROM parametro');
  cache = Object.fromEntries(rows.map((r) => [r.clave, r.valor]));
  cacheEn = ahora;
  return cache;
}

export async function parametro(clave, porDefecto = null) {
  const p = await parametros();
  return p[clave] ?? porDefecto;
}

export async function fijarParametro(clave, valor, usuarioId = null) {
  await consultar(
    `INSERT INTO parametro (clave, valor, actualizado_por)
     VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (clave) DO UPDATE
       SET valor = EXCLUDED.valor,
           actualizado_en = now(),
           actualizado_por = EXCLUDED.actualizado_por`,
    [clave, JSON.stringify(valor), usuarioId],
  );
  cache = null;
}

export function invalidarCacheParametros() {
  cache = null;
}

// ── Bitácora de auditoría ───────────────────────────────────────────────────
export async function auditar({ usuarioId = null, accion, entidad = null, entidadId = null, detalle = null, ip = null }) {
  await consultar(
    `INSERT INTO bitacora (usuario_id, accion, entidad, entidad_id, detalle, ip)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
    [usuarioId, accion, entidad, entidadId != null ? String(entidadId) : null,
     detalle ? JSON.stringify(detalle) : null, ip],
  );
}
