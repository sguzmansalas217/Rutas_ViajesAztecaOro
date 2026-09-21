-- ============================================================================
--  019 · El texto del marcaje 3 (filtro) deja de mencionar la ruta
--
--  Los dos mensajes del filtro —"¿ya llegaste?" y, tras el botón, "comparte tu
--  ubicación"— traían "de la ruta {ruta}". Se quita: al conductor no le hace
--  falta ese dato ahí y sólo alargaba el mensaje.
-- ============================================================================
UPDATE parametro
   SET valor = '"{nombre}, ¿ya llegaste al filtro?"',
       actualizado_en = now()
 WHERE clave = 'texto.marcaje3_llegada';

UPDATE parametro
   SET valor = '"📍 {nombre}, comparte tu ubicación para registrar el filtro.\n\nSi no ves el botón: 📎 → Ubicación → Enviar ubicación actual."',
       actualizado_en = now()
 WHERE clave = 'texto.marcaje3';
