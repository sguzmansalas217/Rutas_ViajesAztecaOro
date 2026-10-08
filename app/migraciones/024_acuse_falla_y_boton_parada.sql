-- ============================================================================
--  024 · Respuesta al conductor que reporta falla, y botón del marcaje 4
--
--  Pedidos del cliente (2026-10-08):
--   - Quien toca «Hay una falla» recibía el mismo "✅ Registrado" que cualquier
--     marcaje. Ahora se le indica contactar al coordinador.
--   - El marcaje 4 ya pide confirmar la parada de inicio (023); el botón decía
--     «Ya salí», que ya no corresponde. WhatsApp corta el botón a 20
--     caracteres.
--   - El mensaje que pide la ubicación tras el botón decía "desde dónde
--     saliste"; se alinea con la parada de inicio.
-- ============================================================================
INSERT INTO parametro (clave, valor, descripcion) VALUES
  ('acuse.falla',
   '"🔧 Falla registrada, {nombre}. Ponte en contacto con el coordinador para tener indicaciones."',
   'Respuesta al conductor cuando reporta una falla en la revisión (marcaje 2)')
ON CONFLICT (clave) DO NOTHING;

UPDATE parametro SET valor = '"Estoy en la parada"', actualizado_en = now()
 WHERE clave = 'boton.marcaje4_si';

UPDATE parametro
   SET valor = '"✅ Registrado, {nombre}. Comparte tu ubicación para dejar anotada la parada de inicio."',
       actualizado_en = now()
 WHERE clave = 'texto.marcaje4_ubicacion';
