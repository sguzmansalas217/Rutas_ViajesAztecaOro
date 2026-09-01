// Pone la contraseña del .env en el usuario que YA existe.
//
// Hace falta porque migrar.js siembra el administrador una sola vez, cuando la
// tabla de usuarios está vacía. Es a propósito: si en cada arranque escribiera
// la contraseña del .env, cualquier cambio hecho desde el portal se perdería y
// el archivo del servidor mandaría por encima de la base. El efecto secundario
// es que cambiar ADMIN_CLAVE después no hace nada, y desde afuera parece que
// la contraseña buena no sirve.
//
//   node herramientas/clave-admin.js               (usa ADMIN_CORREO/ADMIN_CLAVE)
//   node herramientas/clave-admin.js otro@correo   (a otro usuario, misma clave)
//
// La contraseña no se imprime ni se registra en la bitácora en ningún momento.
import { config } from '../src/config.js';
import { hashClave } from '../src/dominio/claves.js';
import { pool, unaFila } from '../src/db.js';

const correo = (process.argv[2] ?? config.admin.correo ?? '').toLowerCase();
const clave = config.admin.clave;

if (!correo || !clave) {
  console.error('Faltan ADMIN_CORREO o ADMIN_CLAVE en el .env.');
  process.exit(1);
}
// Un mínimo, nada más. Si el .env trae una clave de tres letras es mejor
// enterarse aquí que después de no poder entrar.
if (clave.length < 8) {
  console.error(`La clave del .env tiene ${clave.length} caracteres. Mínimo 8.`);
  process.exit(1);
}

const u = await unaFila(
  `UPDATE usuario SET hash_clave = $2 WHERE correo = $1
   RETURNING id, correo, rol, activo`,
  [correo, hashClave(clave)],
);

if (!u) {
  const otros = await unaFila(`SELECT string_agg(correo, ', ') AS lista FROM usuario`);
  console.error(`No hay ningún usuario con el correo ${correo}.`);
  console.error(`En la base están: ${otros?.lista ?? 'ninguno'}`);
  process.exit(1);
}

console.log(`Listo. ${u.correo} (${u.rol}) ya usa la clave del .env.`);
if (!u.activo) console.log('OJO: el usuario está inactivo, no va a poder entrar.');

await pool.end();
