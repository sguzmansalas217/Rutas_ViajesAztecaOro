-- ============================================================================
--  001 · Esquema base — Monitoreo de Rutas (Nexori System)
--  Regla de negocio: SE COBRA POR VEHICULO. Las rutas no entran en la formula.
-- ============================================================================

-- ── Configuración editable desde el portal ──────────────────────────────────
CREATE TABLE parametro (
  clave           text PRIMARY KEY,
  valor           jsonb       NOT NULL,
  descripcion     text,
  actualizado_en  timestamptz NOT NULL DEFAULT now(),
  actualizado_por bigint
);

-- ── Usuarios del sistema ────────────────────────────────────────────────────
CREATE TABLE usuario (
  id            bigserial PRIMARY KEY,
  correo        text NOT NULL UNIQUE CHECK (correo = lower(correo)),
  nombre        text NOT NULL,
  hash_clave    text NOT NULL,
  rol           text NOT NULL DEFAULT 'consulta'
                CHECK (rol IN ('admin', 'operador', 'consulta')),
  activo        boolean NOT NULL DEFAULT true,
  ultimo_acceso timestamptz,
  creado_en     timestamptz NOT NULL DEFAULT now()
);

-- ── Vehículos ───────────────────────────────────────────────────────────────
-- La UNIDAD es lo que se factura. Un vehículo puede cubrir N rutas sin costo extra.
CREATE TABLE vehiculo (
  id        bigserial PRIMARY KEY,
  clave     text NOT NULL UNIQUE,          -- clave canónica: '21', 'V-40', 'C-03'
  notas     text,
  activo    boolean NOT NULL DEFAULT true,
  creado_en timestamptz NOT NULL DEFAULT now()
);

-- CONTROL CONTABLE: resuelve que '21' y 'V-21' son la MISMA unidad.
-- Sin esto se facturan unidades fantasma.
CREATE TABLE vehiculo_alias (
  alias       text PRIMARY KEY,            -- normalizado: mayúsculas sin acentos
  vehiculo_id bigint NOT NULL REFERENCES vehiculo(id) ON DELETE CASCADE,
  origen      text NOT NULL DEFAULT 'importador'
              CHECK (origen IN ('importador', 'manual')),
  creado_en   timestamptz NOT NULL DEFAULT now(),
  creado_por  bigint REFERENCES usuario(id)
);
CREATE INDEX ix_vehiculo_alias_vehiculo ON vehiculo_alias (vehiculo_id);

-- ── Conductores ─────────────────────────────────────────────────────────────
CREATE TABLE conductor (
  id            bigserial PRIMARY KEY,
  nombre        text NOT NULL,
  telefono_e164 text UNIQUE CHECK (telefono_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  activo        boolean NOT NULL DEFAULT true,
  creado_en     timestamptz NOT NULL DEFAULT now(),
  actualizado_en timestamptz NOT NULL DEFAULT now()
);

-- Resuelve alias y dedazos: 'MIGUEL F V-43' = 'MIGUEL FLORES V-43', 'LALO 65' = 'EDUARDO 65'
CREATE TABLE conductor_alias (
  alias        text PRIMARY KEY,           -- el texto tal cual viene del Excel
  conductor_id bigint NOT NULL REFERENCES conductor(id) ON DELETE CASCADE,
  origen       text NOT NULL DEFAULT 'importador'
               CHECK (origen IN ('importador', 'manual')),
  creado_en    timestamptz NOT NULL DEFAULT now(),
  creado_por   bigint REFERENCES usuario(id)
);
CREATE INDEX ix_conductor_alias_conductor ON conductor_alias (conductor_id);

-- ── Rutas ───────────────────────────────────────────────────────────────────
CREATE TABLE ruta (
  id             bigserial PRIMARY KEY,
  nombre         text NOT NULL,
  turno          text NOT NULL
                 CHECK (turno IN ('MANANA','TARDE','NOCHE','ENTRADA_TA','ENTRADA_TB')),
  hora_monitoreo time NOT NULL,            -- ya desambiguada AM/PM según el turno
  hora_salida    time,
  parada_inicial text,
  seccion        text,                     -- 'FRESNILLO PLC', 'EXTRAS JUANICIPIO (VAO)'…
  encargado      text,
  activo         boolean NOT NULL DEFAULT true,
  UNIQUE (nombre, turno, hora_monitoreo)
);
CREATE INDEX ix_ruta_turno ON ruta (turno);

-- ── Geocercas (los 3 puntos de filtro) ──────────────────────────────────────
CREATE TABLE geocerca (
  id        bigserial PRIMARY KEY,
  nombre    text NOT NULL,
  latitud   numeric(10,7) NOT NULL CHECK (latitud  BETWEEN  -90 AND  90),
  longitud  numeric(10,7) NOT NULL CHECK (longitud BETWEEN -180 AND 180),
  radio_m   integer NOT NULL DEFAULT 300 CHECK (radio_m BETWEEN 50 AND 5000),
  activo    boolean NOT NULL DEFAULT true,
  creado_en timestamptz NOT NULL DEFAULT now()
);

-- ── Cargas del Excel ────────────────────────────────────────────────────────
CREATE TABLE carga (
  id               bigserial PRIMARY KEY,
  archivo          text NOT NULL,
  hash_archivo     text NOT NULL,          -- idempotencia: misma carga no duplica
  semana_inicio    date,
  semana_fin       date,
  filas_leidas     integer NOT NULL DEFAULT 0,
  filas_resueltas  integer NOT NULL DEFAULT 0,
  filas_pendientes integer NOT NULL DEFAULT 0,
  estado           text NOT NULL DEFAULT 'procesando'
                   CHECK (estado IN ('procesando','completada','error')),
  detalle          jsonb,
  subido_por       bigint REFERENCES usuario(id),
  creado_en        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_carga_hash ON carga (hash_archivo);

-- ── Asignaciones: una fila = una celda conductor/día del Excel ──────────────
CREATE TABLE asignacion (
  id           bigserial PRIMARY KEY,
  carga_id     bigint REFERENCES carga(id) ON DELETE SET NULL,
  fecha        date   NOT NULL,
  ruta_id      bigint NOT NULL REFERENCES ruta(id),
  vehiculo_id  bigint REFERENCES vehiculo(id),
  conductor_id bigint REFERENCES conductor(id),
  texto_origen text   NOT NULL,            -- 'JUAN CARLOS V-22' — evidencia cruda
  hoja         text   NOT NULL,
  celda        text,
  estado       text   NOT NULL DEFAULT 'programada'
               CHECK (estado IN ('programada','cancelada','vacaciones','por_resolver')),
  creado_en    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (fecha, ruta_id, texto_origen)
);
CREATE INDEX ix_asignacion_fecha     ON asignacion (fecha);
CREATE INDEX ix_asignacion_vehiculo  ON asignacion (vehiculo_id);
CREATE INDEX ix_asignacion_conductor ON asignacion (conductor_id);
-- bandeja "por resolver": la carga nunca falla, deja pendiente lo que no reconoce
CREATE INDEX ix_asignacion_pendiente ON asignacion (fecha)
       WHERE estado = 'por_resolver';

-- ── Marcajes: los 4 por asignación ──────────────────────────────────────────
CREATE TABLE marcaje (
  id              bigserial PRIMARY KEY,
  asignacion_id   bigint   NOT NULL REFERENCES asignacion(id) ON DELETE CASCADE,
  numero          smallint NOT NULL CHECK (numero BETWEEN 1 AND 4),
  programado_para timestamptz NOT NULL,
  estado          text NOT NULL DEFAULT 'pendiente'
                  CHECK (estado IN ('pendiente','enviado','respondido','vencido','cancelado')),
  enviado_en      timestamptz,
  intentos        smallint NOT NULL DEFAULT 0,
  respondido_en   timestamptz,
  -- 'whatsapp' = evidencia automática · 'manual' = lo capturó el operador
  fuente          text CHECK (fuente IN ('whatsapp','manual')),
  nota            text,
  respuesta       text,
  latitud         numeric(10,7),
  longitud        numeric(10,7),
  geocerca_id     bigint REFERENCES geocerca(id),
  distancia_m     numeric(10,2),
  dentro_geocerca boolean,
  semaforo        text NOT NULL DEFAULT 'pendiente'
                  CHECK (semaforo IN ('pendiente','verde','amarillo','rojo')),
  alertado_en     timestamptz,
  UNIQUE (asignacion_id, numero)
);
CREATE INDEX ix_marcaje_por_enviar ON marcaje (programado_para)
       WHERE enviado_en IS NULL;
CREATE INDEX ix_marcaje_semaforo   ON marcaje (semaforo, programado_para);

-- ── Ventana de servicio de 24 h ─────────────────────────────────────────────
-- CONTROL DE COSTO: si está abierta, el mensaje va como texto libre (GRATIS).
-- Si está cerrada, hay que mandar plantilla (SE COBRA).
CREATE TABLE ventana_servicio (
  conductor_id   bigint PRIMARY KEY REFERENCES conductor(id) ON DELETE CASCADE,
  abierta_hasta  timestamptz NOT NULL,
  actualizado_en timestamptz NOT NULL DEFAULT now()
);

-- ── Mensajería y costo ──────────────────────────────────────────────────────
CREATE TABLE mensaje_saliente (
  id            bigserial PRIMARY KEY,
  conductor_id  bigint REFERENCES conductor(id),
  marcaje_id    bigint REFERENCES marcaje(id) ON DELETE SET NULL,
  enviado_en    timestamptz NOT NULL DEFAULT now(),
  tipo          text NOT NULL CHECK (tipo IN ('plantilla','libre')),
  plantilla     text,
  cuerpo        text,
  wa_message_id text,
  costo_usd     numeric(10,6) NOT NULL DEFAULT 0,
  estado        text NOT NULL DEFAULT 'enviado'
                CHECK (estado IN ('enviado','entregado','leido','fallido','simulado')),
  error          text,
  actualizado_en timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_mensaje_saliente_wa ON mensaje_saliente (wa_message_id);
CREATE INDEX ix_mensaje_saliente_fecha ON mensaje_saliente (enviado_en);
CREATE INDEX ix_mensaje_saliente_tipo  ON mensaje_saliente (tipo, enviado_en);

CREATE TABLE mensaje_entrante (
  id            bigserial PRIMARY KEY,
  wa_message_id text UNIQUE,               -- idempotencia: Meta reintenta webhooks
  telefono_e164 text NOT NULL,
  conductor_id  bigint REFERENCES conductor(id),
  recibido_en   timestamptz NOT NULL DEFAULT now(),
  tipo          text,
  texto         text,
  latitud       numeric(10,7),
  longitud      numeric(10,7),
  crudo         jsonb NOT NULL
);
CREATE INDEX ix_mensaje_entrante_fecha ON mensaje_entrante (recibido_en);

-- ── Corte mensual congelado (evidencia de facturación) ──────────────────────
CREATE TABLE corte_mensual (
  periodo           date PRIMARY KEY,      -- primer día del mes
  vehiculos_activos integer NOT NULL,
  renta_base        numeric(12,2) NOT NULL,
  incluidas         integer NOT NULL,
  precio_extra      numeric(12,2) NOT NULL,
  subtotal_mxn      numeric(12,2) NOT NULL,
  detalle           jsonb NOT NULL,        -- unidad por unidad: rutas, días
  cerrado_en        timestamptz NOT NULL DEFAULT now(),
  cerrado_por       bigint REFERENCES usuario(id)
);

-- ── Bitácora de auditoría (LFPDPPP: somos ENCARGADO del tratamiento) ────────
CREATE TABLE bitacora (
  id         bigserial PRIMARY KEY,
  usuario_id bigint REFERENCES usuario(id),
  accion     text NOT NULL,
  entidad    text,
  entidad_id text,
  detalle    jsonb,
  ip         inet,
  creado_en  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_bitacora_fecha   ON bitacora (creado_en);
CREATE INDEX ix_bitacora_usuario ON bitacora (usuario_id, creado_en);

-- ============================================================================
--  VISTAS DE COBRO
--  El cobro es POR VEHICULO. `rutas_distintas` es informativo: se muestra en el
--  tablero para hacer visible que N rutas no cuestan más.
-- ============================================================================
CREATE VIEW vehiculo_activo_mes AS
SELECT date_trunc('month', a.fecha)::date AS periodo,
       a.vehiculo_id,
       v.clave                            AS vehiculo,
       count(*)                           AS asignaciones,
       count(DISTINCT a.ruta_id)          AS rutas_distintas,
       count(DISTINCT a.fecha)            AS dias_activos,
       min(a.fecha)                       AS primer_dia,
       max(a.fecha)                       AS ultimo_dia
FROM   asignacion a
JOIN   vehiculo   v ON v.id = a.vehiculo_id
WHERE  a.vehiculo_id IS NOT NULL
  AND  a.estado = 'programada'
GROUP  BY 1, 2, 3;

CREATE VIEW costo_meta_mes AS
SELECT date_trunc('month', enviado_en)::date               AS periodo,
       count(*) FILTER (WHERE tipo = 'plantilla')          AS plantillas,
       count(*) FILTER (WHERE tipo = 'libre')              AS libres,
       coalesce(sum(costo_usd), 0)                         AS costo_usd
FROM   mensaje_saliente
WHERE  estado <> 'fallido'
GROUP  BY 1;
