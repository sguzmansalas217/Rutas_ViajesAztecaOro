// Hash de contraseñas con scrypt de la librería estándar de Node.
// Se elige scrypt sobre argon2 a propósito: es un KDF fuerte y con memoria
// dura, y evita una dependencia nativa que complica el build en Alpine.
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const N = 16384; // costo CPU/memoria
const r = 8;
const p = 1;
const LARGO = 64;

export function hashClave(clave) {
  const sal = randomBytes(16);
  const derivada = scryptSync(clave, sal, LARGO, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${sal.toString('base64')}$${derivada.toString('base64')}`;
}

export function verificarClave(clave, almacenada) {
  try {
    const [algo, nN, nR, nP, salB64, hashB64] = String(almacenada).split('$');
    if (algo !== 'scrypt') return false;
    const sal = Buffer.from(salB64, 'base64');
    const esperado = Buffer.from(hashB64, 'base64');
    const derivada = scryptSync(clave, sal, esperado.length, {
      N: Number(nN), r: Number(nR), p: Number(nP),
    });
    // Comparación en tiempo constante: no filtrar información por timing.
    return derivada.length === esperado.length && timingSafeEqual(derivada, esperado);
  } catch {
    return false;
  }
}
