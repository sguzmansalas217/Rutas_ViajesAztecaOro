// Configuración leída del entorno. Falla temprano y ruidosamente si falta algo
// crítico: es preferible no arrancar que arrancar a medias a las 3:30 AM.

function requerido(clave) {
  const v = process.env[clave];
  if (!v || !v.trim()) {
    throw new Error(`Falta la variable de entorno obligatoria: ${clave}`);
  }
  return v.trim();
}

function opcional(clave, porDefecto = '') {
  const v = process.env[clave];
  return v === undefined || v === '' ? porDefecto : v.trim();
}

const produccion = opcional('NODE_ENV', 'development') === 'production';

export const config = {
  produccion,
  puerto: Number(opcional('PUERTO', '3000')),
  zonaHoraria: opcional('TZ', 'America/Mexico_City'),
  urlPublica: opcional('URL_PUBLICA', 'http://localhost:5173'),

  db: {
    url: requerido('DATABASE_URL'),
    maxConexiones: Number(opcional('DB_MAX_CONEXIONES', '10')),
  },

  redis: {
    url: opcional('REDIS_URL', 'redis://redis:6379'),
  },

  jwt: {
    // En producción exigimos un secreto real; en desarrollo permitimos uno fijo.
    secreto: produccion ? requerido('JWT_SECRETO') : opcional('JWT_SECRETO', 'secreto-de-desarrollo'),
    expira: opcional('JWT_EXPIRA', '30m'),
    expiraRefresco: opcional('JWT_EXPIRA_REFRESCO', '7d'),
  },

  admin: {
    correo: opcional('ADMIN_CORREO', ''),
    clave: opcional('ADMIN_CLAVE', ''),
    nombre: opcional('ADMIN_NOMBRE', 'Administrador'),
  },

  whatsapp: {
    // WA_SIMULADO=1 registra los mensajes en base sin llamar a Meta.
    simulado: opcional('WA_SIMULADO', '1') === '1',
    idNumero: opcional('WA_ID_NUMERO'),
    idCuenta: opcional('WA_ID_CUENTA'),
    token: opcional('WA_TOKEN'),
    verifyToken: opcional('WA_VERIFY_TOKEN'),
    appSecret: opcional('WA_APP_SECRET'),
    version: opcional('WA_VERSION', 'v21.0'),
  },
};

// El webhook sin firma verificada es una puerta abierta para inyectar
// ubicaciones falsas. En producción no se arranca sin app secret.
if (config.produccion && !config.whatsapp.simulado && !config.whatsapp.appSecret) {
  throw new Error(
    'WA_APP_SECRET es obligatorio en producción: sin él no se puede validar la ' +
      'firma X-Hub-Signature-256 de los webhooks de Meta.',
  );
}
