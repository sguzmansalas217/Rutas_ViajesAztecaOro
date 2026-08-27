import { createRequire } from 'node:module';
import pino from 'pino';
import { config } from './config.js';

// pino-pretty es devDependency: la imagen de Docker se construye con
// --omit=dev y no lo trae. Si se pide el transport y el paquete no está,
// pino revienta al arrancar. Por eso se comprueba antes de pedirlo:
// sin pino-pretty simplemente salen logs en JSON, que igual sirven.
function transportBonito() {
  if (config.produccion) return undefined;
  try {
    createRequire(import.meta.url).resolve('pino-pretty');
  } catch {
    return undefined;
  }
  return { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } };
}

export const log = pino({
  level: process.env.LOG_NIVEL ?? (config.produccion ? 'info' : 'debug'),
  // Nunca dejar que un teléfono o un token acabe en los logs.
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-hub-signature-256"]',
      '*.telefono_e164',
      '*.token',
      '*.clave',
      '*.hash_clave',
    ],
    censor: '***',
  },
  transport: transportBonito(),
});
