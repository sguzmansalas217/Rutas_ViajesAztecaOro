-- ============================================================================
--  013 · Botones en los marcajes 2, 3 y 4; el 1 se contesta escribiendo
--
--  Hasta aquí los botones estaban sólo en el despertar, y por una razón de
--  costo: un toque abre la ventana de 24 h y el resto del día sale gratis. Pero
--  el despertar casi siempre sale por PLANTILLA —a las cinco de la mañana nadie
--  tiene ventana abierta— y los botones de una plantilla se definen en Meta,
--  no aquí. O sea que ese caso no lo resolvía el código.
--
--  Donde los botones sí sirven es en los tres siguientes, que ya salen dentro
--  de la ventana: el conductor va manejando y un toque es la diferencia entre
--  que conteste y que no.
--
--  El filtro cambia de forma: en vez de pedir la ubicación de golpe —cuando a
--  lo mejor todavía va llegando—, primero pregunta si ya llegó. Al tocar el
--  botón se le pide la ubicación, que es lo único que se compara contra la
--  geocerca. El texto suelto («ya llegué al alcoholímetro») hace lo mismo.
-- ============================================================================
INSERT INTO parametro (clave, valor, descripcion) VALUES
  -- El primer mensaje del filtro. El de pedir la ubicación sigue siendo
  -- texto.marcaje3, que ahora sale en el segundo paso.
  ('texto.marcaje3_llegada', '"{nombre}, ¿ya llegaste al filtro de la ruta {ruta}?"',
   'Marcaje 3, primer mensaje: pregunta si ya llegó al filtro'),

  -- WhatsApp corta los títulos a 20 caracteres. Se guardan como parámetro
  -- porque la palabra que usa la operación no es la que uno supone: aquí le
  -- dicen «filtro», en otra ruta le dirán «alcoholímetro».
  ('boton.marcaje2_si',     '"Todo bien ✅"',   'Marcaje 2: la unidad está en condiciones'),
  ('boton.marcaje2_no',     '"Hay una falla"',  'Marcaje 2: la unidad trae algo mal'),
  ('boton.marcaje3_llegue', '"Ya llegué 📍"',   'Marcaje 3: avisa que está en el filtro'),
  ('boton.marcaje4_si',     '"Ya salí 🚌"',     'Marcaje 4: ya arrancó la ruta')
ON CONFLICT (clave) DO NOTHING;

-- El 2 ya no cuelga de la hora del Excel sino del despertar, que es como se
-- explica y como se entiende: «X minutos después del primero». Con los valores
-- de producción (despertar en 0) el resultado es idéntico, pero deja de ser
-- posible que la revisión salga antes que el despertar.
UPDATE parametro
   SET descripcion = 'Minutos después del marcaje 1 (despertar). Marcaje 2: revisión de la unidad',
       actualizado_en = now()
 WHERE clave = 'marcaje2.retraso_min';
