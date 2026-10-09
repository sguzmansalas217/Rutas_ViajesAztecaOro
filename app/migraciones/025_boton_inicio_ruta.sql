-- ============================================================================
--  025 · Botón del marcaje 4: «Confirmo Inicio Ruta»
--
--  Pedido del cliente (2026-10-09): reemplaza «Estoy en la parada» (024). El
--  texto pedido era «Confirmo Inicio de Ruta» (23 caracteres), pero WhatsApp
--  limita el botón a 20 y infra/whatsapp.js lo cortaría a «Confirmo Inicio de
--  R». Se quita el «de» para que entre completo.
-- ============================================================================
UPDATE parametro SET valor = '"Confirmo Inicio Ruta"', actualizado_en = now()
 WHERE clave = 'boton.marcaje4_si';
