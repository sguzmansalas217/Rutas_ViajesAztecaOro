-- ============================================================================
--  LÍMITE DE VEHÍCULOS CONTRATADOS
--
--  El contrato arranca con 30 unidades. En el archivo del cliente hay 113,
--  así que el sistema tiene que saber cuáles 30 son y no tocar las otras 83.
--
--  Esto no es cosmético. Cada mensaje de WhatsApp cuesta dinero: si el
--  trabajador le manda marcajes a las 113, se pagan mensajes de 83 unidades
--  que nadie contrató. Por eso el límite se hace cumplir en tres lugares:
--
--    1. Alta      → un trigger impide marcar más de `limite.vehiculos`.
--                   No hay ruta de código que lo pueda saltar, ni un UPDATE
--                   a mano desde psql.
--    2. Envío     → el trabajador sólo agarra marcajes de unidades
--                   contratadas (ver trabajador.js). Ahí está el gasto.
--    3. Factura   → vehiculo_activo_mes ya sólo cuenta contratadas, así que
--                   es imposible facturar de más aunque el Excel traiga 113.
--
--  Subir el límite es cambiar un parámetro, no tocar código:
--      UPDATE parametro SET valor = '50' WHERE clave = 'limite.vehiculos';
-- ============================================================================

ALTER TABLE vehiculo
  ADD COLUMN contratado    boolean NOT NULL DEFAULT false,
  ADD COLUMN contratado_en timestamptz;

COMMENT ON COLUMN vehiculo.contratado IS
  'Dentro del alcance del contrato. Sólo estas unidades reciben mensajes y '
  'sólo estas se facturan. El tope lo pone el parámetro limite.vehiculos.';

CREATE INDEX ix_vehiculo_contratado ON vehiculo (contratado) WHERE contratado;

INSERT INTO parametro (clave, valor, descripcion) VALUES
  ('limite.vehiculos', '30',
   'Unidades que cubre el contrato. Ninguna unidad de más recibe mensajes ni se factura.')
ON CONFLICT (clave) DO NOTHING;

-- ── El tope, garantizado por la base ────────────────────────────────────────
CREATE FUNCTION verificar_limite_vehiculos() RETURNS trigger AS $$
DECLARE
  tope      int;
  contratados int;
BEGIN
  IF NOT NEW.contratado THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.contratado THEN
    RETURN NEW;                      -- ya estaba dentro: no cambia el conteo
  END IF;

  -- Serializa los conteos: sin esto, dos altas simultáneas podrían pasar
  -- el límite las dos. Es un candado barato y sólo se toma al dar de alta.
  PERFORM pg_advisory_xact_lock(hashtext('limite.vehiculos'));

  SELECT coalesce(valor::int, 30) INTO tope
    FROM parametro WHERE clave = 'limite.vehiculos';
  tope := coalesce(tope, 30);

  SELECT count(*) INTO contratados FROM vehiculo WHERE contratado;

  IF contratados >= tope THEN
    RAISE EXCEPTION
      'El contrato cubre % unidades y ya hay % dadas de alta. Da de baja una antes de agregar "%".',
      tope, contratados, NEW.clave
      USING ERRCODE = 'check_violation';
  END IF;

  NEW.contratado_en := coalesce(NEW.contratado_en, now());
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tg_limite_vehiculos
  BEFORE INSERT OR UPDATE OF contratado ON vehiculo
  FOR EACH ROW EXECUTE FUNCTION verificar_limite_vehiculos();

-- ── Las asignaciones de unidades fuera del contrato se ven, pero no corren ──
ALTER TABLE asignacion DROP CONSTRAINT asignacion_estado_check;
ALTER TABLE asignacion ADD CONSTRAINT asignacion_estado_check
  CHECK (estado IN ('programada','cancelada','vacaciones','por_resolver','fuera_contrato'));

COMMENT ON COLUMN asignacion.estado IS
  'fuera_contrato = la unidad aparece en el Excel pero no está en las '
  'contratadas. Se guarda para que el cliente vea el dato, pero no genera '
  'marcajes ni mensajes ni cobro.';

-- ── La factura no puede pasarse del contrato ────────────────────────────────
DROP VIEW vehiculo_activo_mes;
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
  AND  v.contratado                       -- el tope, también del lado del cobro
GROUP  BY 1, 2, 3;

COMMENT ON VIEW vehiculo_activo_mes IS
  'Base de la factura: unidades contratadas que sí se monitorearon. '
  'Para ver todas las del archivo, incluidas las de fuera, usar '
  'vehiculo_en_archivo_mes.';
