-- ============================================================================
--  026 · Rutas sin filtro: el marcaje 3 pregunta la salida del domicilio
--
--  Pedido del cliente (2026-10-27). El Excel trae una columna FILTRO (SI/NO)
--  por ruta desde el 2026-10-22:
--   - SI: el marcaje 3 es el filtro de siempre (¿ya llegaste? → ubicación).
--   - NO: la ruta no pasa por filtro. El marcaje 3, en el mismo lugar —después
--     de la revisión—, pide confirmar que ya salió de su domicilio, sin
--     ubicación, con dos botones: «Confirmo salida» o «Voy con retraso».
--     «Voy con retraso» queda en rojo y avisa al encargado; sin respuesta,
--     rojo como cualquier marcaje.
--
--  Por omisión true: un Excel sin la columna se comporta como antes.
-- ============================================================================
ALTER TABLE ruta ADD COLUMN IF NOT EXISTS lleva_filtro boolean NOT NULL DEFAULT true;

-- WhatsApp corta el título del botón a 20 caracteres.
INSERT INTO parametro (clave, valor, descripcion) VALUES
  ('texto.marcaje3_domicilio',
   '"🏠 {nombre}, confirma que ya saliste de tu domicilio para la ruta {ruta}."',
   'Marcaje 3 en rutas sin filtro: salida del domicilio'),
  ('boton.marcaje3_sali',    '"Confirmo salida"',  'Marcaje 3 sin filtro: ya salió de su domicilio'),
  ('boton.marcaje3_retraso', '"Voy con retraso"',  'Marcaje 3 sin filtro: va tarde (rojo y alerta)'),
  ('acuse.retraso',
   '"🕒 Anotado, {nombre}. Le avisamos a tu encargado que vas con retraso."',
   'Respuesta al conductor que toca «Voy con retraso»')
ON CONFLICT (clave) DO NOTHING;
