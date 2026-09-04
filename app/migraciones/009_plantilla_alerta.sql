-- ============================================================================
--  009 · Plantilla de respaldo para las alertas
--
--  El aviso de rojo sale como texto libre, y WhatsApp sólo lo entrega si el
--  número del encargado escribió al del sistema en las últimas 24 h. Un
--  encargado no escribe nunca: el aviso llegaba el primer día y al siguiente
--  se apagaba solo, con el rechazo de Meta enterrado en el log. Es la peor
--  forma de fallar —el tablero se ve bien y nadie sabe que dejó de avisar—.
--
--  Con esto, cuando Meta contesta 131047 el mismo aviso se reintenta por
--  plantilla, que entra tenga o no ventana. La plantilla CUESTA, así que el
--  orden importa: primero se intenta gratis y sólo se paga cuando no queda de
--  otra. Un rechazo de Meta no se cobra, así que intentar no cuesta nada.
--
--  ⚠️ El nombre tiene que existir y estar APROBADO en el Administrador de
--  WhatsApp, en la misma WABA, con idioma es_MX y dos variables en el cuerpo:
--    {{1}} cuántos marcajes van sin respuesta
--    {{2}} la lista, en una sola línea (Meta rechaza parámetros con saltos)
--  Mientras no exista, el respaldo falla y el aviso simplemente no llega:
--  igual que antes, ni mejor ni peor.
-- ============================================================================
INSERT INTO parametro (clave, valor, descripcion) VALUES
  ('wa.plantilla_alerta', '"alerta_sin_respuesta"',
   'Plantilla aprobada para avisar el rojo cuando el encargado no tiene ventana de 24 h abierta')
ON CONFLICT (clave) DO NOTHING;
