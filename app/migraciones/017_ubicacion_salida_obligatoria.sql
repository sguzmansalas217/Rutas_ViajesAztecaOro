-- ============================================================================
--  017 · La ubicación de salida pasa a ser obligatoria
--
--  En la 015 el punto de la salida era un extra: si llegaba, se guardaba. Pero
--  un botón no prueba desde dónde arrancó la unidad —se toca desde donde sea—,
--  y ése es justo el dato que se enseña cuando el cliente reclama un retraso de
--  hace tres días.
--
--  Obligatorio, pero sin candado. La salida se registra con el botón —«la ruta
--  salió» es el dato más importante del día y no se puede perder por un GPS
--  apagado— y se queda en amarillo hasta que llegue el punto. El día no cierra
--  en verde sin él.
--
--  Sigue SIN compararse contra ninguna geocerca: cada ruta arranca donde
--  arranca y no hay filtro contra el cual estar lejos. Se exige el dato, no la
--  posición.
--
--  En false, la 015 tal como era: se pide, y si no llega, no pasa nada.
-- ============================================================================
INSERT INTO parametro (clave, valor, descripcion) VALUES
  ('ubicacion_salida.obligatoria', 'true',
   'Sin la ubicación de salida el marcaje 4 se queda en amarillo. No compara contra geocercas: sólo exige que el punto exista')
ON CONFLICT (clave) DO NOTHING;
