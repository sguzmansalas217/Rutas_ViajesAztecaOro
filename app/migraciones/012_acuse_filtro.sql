-- ============================================================================
--  012 · El acuse del filtro dice si quedó dentro o fuera
--
--  Hasta aquí el conductor recibía "📍 Ubicación recibida. Filtro registrado."
--  estuviera donde estuviera. Eso es peor que no decir nada: le confirma que
--  cumplió cuando a lo mejor mandó la ubicación desde otro lado y el marcaje
--  salió en rojo. Se entera —si es que se entera— cuando le hablan.
--
--  Ahora son tres respuestas distintas y el conductor sabe en el momento
--  cómo quedó:
--    dentro          → confirmado, con el nombre del filtro
--    fuera           → tache, con a cuántos metros quedó del más cercano
--    sin geocercas   → el texto de antes: se recibió, no se pudo comparar
-- ============================================================================
INSERT INTO parametro (clave, valor, descripcion) VALUES
  ('acuse.dentro', '"✅ Confirmado, {nombre}. Estás en {filtro}. Filtro registrado."',
   'Acuse del marcaje 3 cuando la ubicación cae dentro de la geocerca'),

  -- Se le dice la distancia a propósito. "No estás en el filtro" a secas suena
  -- a error del sistema y contesta "sí estoy"; "a 4,200 m del más cercano" es
  -- un dato que él puede comprobar y con el que puede corregir.
  ('acuse.fuera', '"❌ {nombre}, esa ubicación no es la de ningún filtro. El más cercano es {filtro} y queda a {metros} m. El marcaje quedó en rojo; avísale a tu encargado si es un error."',
   'Acuse del marcaje 3 cuando la ubicación cae fuera de toda geocerca')
ON CONFLICT (clave) DO NOTHING;

-- El texto viejo se queda, pero ya sólo se usa cuando no hay ninguna geocerca
-- activa: ahí no se puede afirmar ni que está ni que no está.
UPDATE parametro
   SET descripcion = 'Acuse del marcaje 3 cuando no hay filtros activos contra los cuales comparar',
       actualizado_en = now()
 WHERE clave = 'acuse.ubicacion';
