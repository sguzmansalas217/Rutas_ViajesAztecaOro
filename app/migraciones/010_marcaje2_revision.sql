-- ============================================================================
--  010 · El marcaje 2 es la revisión de la unidad, no "¿ya vas en camino?"
--
--  Venía mal desde el principio. El marcaje 2 no pregunta si el conductor se
--  está trasladando: pregunta si el vehículo está en condiciones de salir. Son
--  dos cosas distintas y la que se estaba preguntando es la que no importa —un
--  conductor puede ir en camino en una unidad que no debería salir—.
--
--  Se cambia también la descripción del parámetro: es lo que ve quien edite
--  estos textos después, y un rótulo equivocado hace que se vuelva a escribir
--  la pregunta equivocada.
-- ============================================================================
UPDATE parametro
   SET valor = '"🔧 {nombre}, ¿la unidad {unidad} está en buenas condiciones para salir?"',
       descripcion = 'Marcaje 2: revisión de la unidad'
 WHERE clave = 'texto.marcaje2';
