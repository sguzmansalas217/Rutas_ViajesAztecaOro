-- ============================================================================
--  003 · Desfases y textos de los 4 marcajes
--  El Excel trae una sola hora por ruta; los cuatro marcajes se derivan de ella.
--  Todo es parametrizable para poder ajustar la operación sin tocar código.
-- ============================================================================
INSERT INTO parametro (clave, valor, descripcion) VALUES
  ('marcaje1.desfase_min', '0',   'Minutos respecto a HORA MONITOREO. Marcaje 1: despertar'),
  ('marcaje3.desfase_min', '-20', 'Minutos respecto a HORA SALIDA. Marcaje 3: filtro/alcoholímetro'),
  ('marcaje4.desfase_min', '0',   'Minutos respecto a HORA SALIDA. Marcaje 4: salida de la ruta'),

  ('texto.marcaje1', '"Buenos días {nombre}. Monitoreo de la ruta {ruta} ({hora}). ¿Confirmas que estás despierto?"',
                     'Cuerpo del marcaje 1 cuando la ventana está abierta'),
  ('texto.marcaje2', '"{nombre}, ¿ya vas en camino a la unidad {unidad}?"', 'Marcaje 2: en camino'),
  ('texto.marcaje3', '"{nombre}, comparte tu ubicación para registrar el filtro de la ruta {ruta}."',
                     'Marcaje 3: solicitud de ubicación en el filtro'),
  ('texto.marcaje4', '"{nombre}, ¿ya saliste con la ruta {ruta}?"', 'Marcaje 4: salida'),

  ('aviso.encargado_telefono', '""', 'WhatsApp que recibe las alertas de rojo (E.164). Vacío = sin avisos'),
  ('worker.intervalo_seg', '30', 'Cada cuánto revisa el trabajador los marcajes por enviar')
ON CONFLICT (clave) DO NOTHING;
