-- ============================================================================
--  El límite de vehículos truena si limite.vehiculos se guardó como texto
--
--  `fijarParametro()` guarda lo que le llegue con JSON.stringify: si el valor
--  viaja como string ("10", de un <input> del portal) queda en jsonb como
--  STRING ("10", con comillas), no como número. `valor::int` sólo sabe hacer
--  ese cast cuando el jsonb es un número — con un string jsonb Postgres tira
--  "cannot cast jsonb string to type integer" y la alta/baja de una unidad
--  revienta con Error interno.
--
--  `#>>'{}'` saca el valor como texto sin importar si el jsonb es número o
--  string, y de ahí sí castea a int limpio.
-- ============================================================================
CREATE OR REPLACE FUNCTION verificar_limite_vehiculos() RETURNS trigger AS $$
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

  SELECT coalesce((valor #>> '{}')::int, 30) INTO tope
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

-- Deja el valor ya guardado como número real, para que un SELECT directo
-- (o cualquier otro sitio que haga valor::int) no tropiece con lo mismo.
UPDATE parametro SET valor = to_jsonb((valor #>> '{}')::int)
 WHERE clave = 'limite.vehiculos' AND jsonb_typeof(valor) = 'string';
