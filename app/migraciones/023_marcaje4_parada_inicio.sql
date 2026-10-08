-- ============================================================================
--  023 · El marcaje 4 pregunta por la parada de inicio, no por la salida
--
--  Pedido del cliente (2026-10-08): en vez de "¿ya saliste con la ruta?" se
--  pide confirmar que el conductor ya está en la parada de inicio. Conserva el
--  nombre y la ruta, como el texto anterior.
-- ============================================================================
UPDATE parametro
   SET valor = '"🛣️ {nombre}, confirma que estás en la parada de inicio de la ruta {ruta}."',
       actualizado_en = now()
 WHERE clave = 'texto.marcaje4';
