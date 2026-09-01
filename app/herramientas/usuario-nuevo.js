// Da de alta un usuario del portal desde la línea de comandos.
//
//   node herramientas/usuario-nuevo.js <correo> "<Nombre completo>" [rol]
//
// El rol es 'operador' si no se dice otra cosa. Los tres que hay:
//
//   admin     todo, incluido Cobro y la bitácora. Es el del proveedor.
//   operador  la operación diaria: cargar el Excel, resolver, marcar a mano.
//   consulta  sólo mirar.
//
// El cliente va de 'operador' a propósito: Cobro enseña el margen del
// servicio (app/src/rutas/cobro.js, GET /margen) y eso no lo ve quien paga.
//
// La contraseña se inventa aquí y se imprime UNA vez, porque no hay otro modo
// de entregarla. No queda en la bitácora ni en ningún archivo: de la base sólo
// sale el hash. Quien la reciba la cambia desde el portal, en Mi cuenta.
import { randomInt } from 'node:crypto';

import { hashClave } from '../src/dominio/claves.js';
import { pool, unaFila } from '../src/db.js';

const ROLES = ['admin', 'operador', 'consulta'];

const correo = (process.argv[2] ?? '').trim().toLowerCase();
const nombre = (process.argv[3] ?? '').trim();
const rol = (process.argv[4] ?? 'operador').trim();

function salir(mensaje) {
  console.error(mensaje);
  process.exit(1);
}

if (!correo || !nombre) {
  salir('Uso: node herramientas/usuario-nuevo.js <correo> "<Nombre completo>" [rol]');
}
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) salir(`"${correo}" no parece un correo.`);
if (nombre.length < 2) salir('El nombre está demasiado corto.');
if (!ROLES.includes(rol)) salir(`El rol tiene que ser uno de: ${ROLES.join(', ')}.`);

// Sin l/I/1 ni O/0: esta contraseña se dicta o se copia de una pantalla y esos
// pares se confunden. Sale de randomInt, que es el generador criptográfico.
const ALFABETO = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const clave = Array.from({ length: 14 }, () => ALFABETO[randomInt(ALFABETO.length)]).join('');

const ya = await unaFila('SELECT correo, rol FROM usuario WHERE lower(correo) = lower($1)', [correo]);
if (ya) {
  console.error(`${ya.correo} ya existe (${ya.rol}).`);
  console.error('Para cambiarle la contraseña: node herramientas/clave-admin.js ' + correo);
  process.exit(1);
}

const u = await unaFila(
  `INSERT INTO usuario (correo, nombre, hash_clave, rol) VALUES ($1, $2, $3, $4)
   RETURNING id, correo, nombre, rol`,
  [correo, nombre, hashClave(clave), rol],
);

console.log('');
console.log(`Usuario dado de alta: ${u.nombre}`);
console.log(`  Correo      ${u.correo}`);
console.log(`  Rol         ${u.rol}`);
console.log(`  Contraseña  ${clave}`);
console.log('');
console.log('Anótala ahora: no se vuelve a mostrar. Que la cambie al entrar,');
console.log('en Mi cuenta (su nombre, abajo del menú).');

await pool.end();
