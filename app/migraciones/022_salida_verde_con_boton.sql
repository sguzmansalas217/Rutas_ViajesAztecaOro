-- ============================================================================
--  022 · La salida se pone en verde con el botón «Ya salí»
--
--  Desde la 017 la salida se quedaba en amarillo hasta que llegara la
--  ubicación. El cliente pidió (2026-10-08) que el tablero la marque verde en
--  cuanto el conductor confirma que salió: la ubicación se sigue pidiendo por
--  WhatsApp y, cuando llega, se guarda y se le contesta «Buen viaje», pero ya
--  no condiciona el semáforo.
--
--  Es exactamente el modo «no obligatoria» que la 017 dejó previsto; no hay
--  cambio de código. Una salida tardía sigue saliendo amarilla por la hora.
-- ============================================================================
UPDATE parametro SET valor = 'false', actualizado_en = now()
 WHERE clave = 'ubicacion_salida.obligatoria';
