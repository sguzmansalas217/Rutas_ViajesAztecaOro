-- ============================================================================
--  ASIGNACIONES REEMPLAZADAS
--
--  El Excel se carga TODOS LOS DÍAS, siempre el mismo archivo de la semana con
--  los cambios que haya habido. La carga es idempotente por celda: la llave
--  UNIQUE (fecha, ruta_id, texto_origen) hace que volver a subir lo mismo
--  actualice la fila en su sitio, sin duplicar ni tirar los marcajes ya
--  mandados. Eso ya funcionaba.
--
--  Lo que faltaba es lo contrario: cuando el cliente CAMBIA un conductor, el
--  texto de la celda cambia y esa llave ya no casa con nada. Se insertaba una
--  fila nueva y LA VIEJA SE QUEDABA VIVA Y PROGRAMADA, con sus cuatro marcajes.
--  Resultado: el conductor que ya no maneja esa ruta seguía recibiendo el
--  WhatsApp, y encima se pagaba la plantilla.
--
--  De ahí este estado. No es 'cancelada' —esa la escribe el cliente en su
--  archivo y significa otra cosa, que el viaje no salió— sino "esta fila la
--  reemplazó una carga posterior". Se conserva en vez de borrarse porque es
--  evidencia: si el conductor alcanzó a contestar un marcaje antes del cambio,
--  esa respuesta tiene que seguir estando.
--
--  Queda fuera de vehiculo_activo_mes por sí sola: esa vista sólo cuenta
--  'programada'. Y el trabajador ya exige a.estado = 'programada' para mandar,
--  así que en cuanto una fila pasa a 'reemplazada' deja de gastar mensajes.
-- ============================================================================

-- Se reescribe la lista completa, no sólo el estado nuevo: la 005 ya había
-- agregado 'fuera_contrato' y omitirlo aquí dejaría fuera de la ley a filas
-- que ya existen en la tabla.
ALTER TABLE asignacion DROP CONSTRAINT asignacion_estado_check;

ALTER TABLE asignacion ADD CONSTRAINT asignacion_estado_check
  CHECK (estado IN ('programada','cancelada','vacaciones','por_resolver',
                    'fuera_contrato','reemplazada'));

COMMENT ON COLUMN asignacion.estado IS
  'fuera_contrato = la unidad aparece en el Excel pero no está contratada. '
  'reemplazada = una carga posterior del mismo día dejó esta fila fuera; se '
  'conserva como evidencia pero no genera marcajes ni mensajes ni cobro.';

-- Las consultas del día (tablero, lista de asignaciones) ahora piden
-- estado <> 'reemplazada'. Sin este índice, una semana recargada siete veces
-- obliga a leer las descartadas para tirarlas.
CREATE INDEX ix_asignacion_vigente ON asignacion (fecha)
       WHERE estado <> 'reemplazada';
