-- ============================================================================
--  015 · La salida también pide ubicación, pero sólo para el registro
--
--  El marcaje 3 pide la ubicación porque la compara: si el punto cae fuera del
--  filtro, el marcaje se va a rojo. Ésa es la mitad del servicio y no cambia.
--
--  La salida es otra cosa. Saber desde dónde arrancó la ruta vale —para
--  reconstruir una queja del cliente, para ver que la unidad no salió del patio
--  equivocado—, pero no hay contra qué compararlo: cada ruta arranca donde
--  arranca. Así que el punto se guarda y se enseña, y NO toca el semáforo.
--
--  Por eso se pide DESPUÉS de que el botón cerró el marcaje, no antes. Si la
--  ubicación fuera la condición para cerrarlo, el conductor con el GPS apagado
--  o el que no sabe compartirla se iría a rojo por un dato informativo.
-- ============================================================================
INSERT INTO parametro (clave, valor, descripcion) VALUES
  ('ubicacion_salida.activo', 'true',
   'Pedir la ubicación al arrancar la ruta (marcaje 4). Sólo informativa: no se compara contra ningún filtro ni cambia el semáforo'),

  -- Hace las veces de acuse: el conductor acaba de tocar «Ya salí» y este es el
  -- mensaje que le contesta. Mandarle "gracias" y luego "tu ubicación" serían
  -- dos mensajes para lo mismo.
  ('texto.marcaje4_ubicacion',
   '"✅ Registrado, {nombre}. Comparte tu ubicación para dejar anotado desde dónde saliste."',
   'Marcaje 4, segundo mensaje: le pide la ubicación de salida'),

  ('acuse.ubicacion_salida', '"📍 Anotado, {nombre}. Buen viaje."',
   'Respuesta a la ubicación de salida')
ON CONFLICT (clave) DO NOTHING;
