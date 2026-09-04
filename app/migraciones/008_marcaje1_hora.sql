-- ============================================================================
--  008 · Corrige la redacción del marcaje 1
--
--  En 007 quedó "Ruta {ruta}, salida {hora}", pero {hora} la arma el trabajador
--  con r.hora_monitoreo, no con hora_salida. Al conductor le llegaba su hora de
--  monitoreo etiquetada como hora de salida —40 minutos antes de la buena—, que
--  es justo el dato con el que decide a qué hora levantarse.
--
--  Si algún día se quiere poner de verdad la hora de salida, no basta con
--  cambiar este texto: hay que agregar el dato en trabajador.js, donde se arma
--  el objeto 'datos' que alimenta la interpolación.
-- ============================================================================
UPDATE parametro
   SET valor = '"☀️ Buenos días {nombre}. Monitoreo de las {hora}, ruta {ruta}. ¿Ya estás despierto?"',
       actualizado_en = now()
 WHERE clave = 'texto.marcaje1';
