import pino from 'pino';
import { config } from './config.js';

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
  transport: config.produccion
    ? undefined
    : { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } },
});
