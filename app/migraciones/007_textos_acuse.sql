-- ============================================================================
--  007 · Redacción de los marcajes y acuse de recibo
--
--  Los textos de 003 eran los mínimos para probar el circuito. En operación el
--  conductor recibe cuatro mensajes al día durante meses: si son secos y todos
--  iguales, deja de leerlos. El emoji al inicio no es adorno —es lo único que
--  distingue un marcaje de otro de un vistazo en la lista de chats—.
--
--  El marcaje 3 lleva la instrucción de cómo compartir ubicación: llega con el
--  botón nativo, pero en Android viejo a veces no se pinta y el conductor se
--  queda sin saber qué hacer.
--
--  ⚠️ texto.marcaje1 tiene que decir lo mismo que la plantilla aprobada en
--  Meta (wa.plantilla_marcaje1). Es el mismo mensaje por dos caminos: libre si
--  la ventana está abierta, plantilla si no. Que digan cosas distintas confunde
--  al conductor y no hay forma de que él sepa por qué.
-- ============================================================================
INSERT INTO parametro (clave, valor, descripcion) VALUES
  ('texto.marcaje1', '"☀️ Buenos días {nombre}. Ruta {ruta}, salida {hora}. ¿Ya estás despierto?"',
                     'Cuerpo del marcaje 1 cuando la ventana está abierta'),
  ('texto.marcaje2', '"🚌 {nombre}, ¿ya vas en camino a la unidad {unidad}?"',
                     'Marcaje 2: en camino'),
  ('texto.marcaje3', '"📍 {nombre}, comparte tu ubicación para registrar el filtro de la ruta {ruta}.\n\nSi no ves el botón: 📎 → Ubicación → Enviar ubicación actual."',
                     'Marcaje 3: solicitud de ubicación en el filtro'),
  ('texto.marcaje4', '"🛣️ {nombre}, ¿ya saliste con la ruta {ruta}?"',
                     'Marcaje 4: salida')
ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor, actualizado_en = now();

-- ── Acuse de recibo ─────────────────────────────────────────────────────────
--  Sin acuse, el conductor contesta y no pasa nada visible: no sabe si su
--  respuesta contó y vuelve a escribir. Cada reintento suyo es ruido en la
--  bandeja y una respuesta que el sistema tiene que descartar.
--
--  El acuse siempre sale dentro de la ventana de 24 h —el conductor acaba de
--  escribir, por definición está abierta—, así que no cuesta nada.
INSERT INTO parametro (clave, valor, descripcion) VALUES
  ('acuse.activo', 'true',
   'Contestar al conductor confirmando que su marcaje quedó registrado'),
  ('acuse.generico', '"✅ Registrado, {nombre}. Gracias."',
   'Acuse cuando el marcaje se registra a tiempo'),
  ('acuse.ubicacion', '"📍 Ubicación recibida, {nombre}. Filtro registrado."',
   'Acuse del marcaje 3 cuando llega con ubicación'),
  ('acuse.tarde', '"✅ Registrado, {nombre}, pero llegó tarde. Contesta en cuanto te llegue el mensaje, por favor."',
   'Acuse cuando la respuesta pasó la tolerancia (semáforo amarillo)'),
  ('acuse.sin_ubicacion', '"⚠️ {nombre}, para el filtro necesito tu ubicación, no un mensaje. Toca 📎 → Ubicación → Enviar ubicación actual."',
   'Acuse del marcaje 3 cuando el conductor contestó con texto en vez de ubicación')
ON CONFLICT (clave) DO NOTHING;
