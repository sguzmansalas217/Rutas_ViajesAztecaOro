-- ============================================================================
--  022 · Plantilla de respaldo para falla reportada y filtro fuera de ubicación
--
--  Esos dos rojos avisan en el momento (webhook.js), no por vencimiento, y la
--  plantilla de "sin respuesta" no les queda. Sin plantilla propia, con la
--  ventana del encargado cerrada el aviso no llega.
--
--  Nace VACÍA a propósito: mientras la plantilla no esté aprobada en Meta, un
--  nombre inexistente haría fallar el envío igual. Cuando Meta la apruebe, se
--  llena desde la pantalla Alertas / Parámetros con el nombre exacto.
--
--  La plantilla debe estar en es_MX con UNA variable en el cuerpo:
--    {{1}} el aviso completo en una línea (motivo, conductor, ruta, teléfono)
-- ============================================================================
INSERT INTO parametro (clave, valor, descripcion) VALUES
  ('wa.plantilla_alerta_ruta', '""',
   'Plantilla aprobada para falla reportada y filtro fuera de ubicación cuando el encargado no tiene ventana abierta (vacío = sólo texto libre)')
ON CONFLICT (clave) DO NOTHING;
