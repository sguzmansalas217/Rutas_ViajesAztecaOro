-- ============================================================================
--  016 · Qué contestarle al que insiste
--
--  El conductor toca un botón que ya se resolvió —porque lo tocó dos veces, o
--  porque el monitorista ya lo registró por teléfono mientras él manejaba—.
--  Antes eso era silencio absoluto, y el silencio se lee como "no llegó": lo
--  toca otra vez, y otra.
--
--  Un renglón corto cierra el asunto. Nunca cuesta: acaba de escribir, así que
--  la ventana de 24 h está abierta.
-- ============================================================================
INSERT INTO parametro (clave, valor, descripcion) VALUES
  ('acuse.repetido', '"✅ Ya lo teníamos registrado, {nombre}. Gracias."',
   'Respuesta a un botón de un marcaje que ya estaba cerrado')
ON CONFLICT (clave) DO NOTHING;
