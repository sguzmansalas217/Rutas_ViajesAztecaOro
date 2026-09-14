-- ============================================================================
--  014 · Los cuatro marcajes, uno detrás de otro
--
--  Hasta aquí había dos anclas: los marcajes 1 y 2 colgaban de la hora del
--  Excel, y los 3 y 4 de una «hora de salida» que la hoja MAÑANA no trae, así
--  que el sistema la inventaba —monitoreo + 40 min— para poder restarle algo.
--  De ahí los números negativos: el filtro se configuraba como «−20», que
--  quería decir «veinte minutos antes de una hora que no existe en el archivo».
--
--  Nadie que no haya escrito el código puede setear eso bien, y setearlo mal no
--  avisa: los mensajes se encabalgan y al conductor le llegan en desorden.
--
--  Ahora cada marcaje se cuenta desde el anterior y todos los números son
--  positivos. «Despertar 3 min después de la hora del Excel, revisión 5 min
--  después del despertar, filtro 30 después de la revisión, salida 30 después
--  del filtro.» Se lee igual que se dice, y con positivos el encabalgamiento
--  deja de ser posible: no es que se valide, es que no se puede escribir.
--
--  Los valores NO se resetean. Se traducen desde los de cada instalación, para
--  que el día del cambio nada se mueva de hora.
-- ============================================================================

-- Los dos nuevos. El valor sale de los viejos con la misma cuenta que hacía
-- programacion.js, así que las horas de hoy se conservan exactas:
--
--     antes:  m3 = monitoreo + 40 + d3        m4 = monitoreo + 40 + d4
--     ahora:  m3 = m2 + r3                    m4 = m3 + r4
--
--     r3 = (40 + d3) − (d1 + d2)              r4 = d4 − d3
--
-- El GREATEST es por si alguna instalación tenía los marcajes encabalgados:
-- se enderezan al mínimo en vez de arrastrar un negativo al modelo nuevo.
INSERT INTO parametro (clave, valor, descripcion)
SELECT 'marcaje3.retraso_min',
       to_jsonb(GREATEST(0,
           40 + COALESCE((SELECT valor::text::int FROM parametro WHERE clave = 'marcaje3.desfase_min'), -20)
              - COALESCE((SELECT valor::text::int FROM parametro WHERE clave = 'marcaje1.desfase_min'), 0)
              - COALESCE((SELECT valor::text::int FROM parametro WHERE clave = 'marcaje2.retraso_min'), 10))),
       'Minutos después del marcaje 2 (revisión). Marcaje 3: filtro / alcoholímetro'
ON CONFLICT (clave) DO NOTHING;

INSERT INTO parametro (clave, valor, descripcion)
SELECT 'marcaje4.retraso_min',
       to_jsonb(GREATEST(0,
             COALESCE((SELECT valor::text::int FROM parametro WHERE clave = 'marcaje4.desfase_min'), 0)
           - COALESCE((SELECT valor::text::int FROM parametro WHERE clave = 'marcaje3.desfase_min'), -20))),
       'Minutos después del marcaje 3 (filtro). Marcaje 4: salida a ruta'
ON CONFLICT (clave) DO NOTHING;

-- Las etiquetas de los dos que se quedan, que ahora significan lo mismo que
-- los nuevos: minutos desde lo anterior.
UPDATE parametro SET descripcion = 'Minutos después de la hora del Excel. Marcaje 1: despertar',
                     actualizado_en = now()
 WHERE clave = 'marcaje1.desfase_min';

UPDATE parametro SET descripcion = 'Minutos después del marcaje 1 (despertar). Marcaje 2: revisión de la unidad',
                     actualizado_en = now()
 WHERE clave = 'marcaje2.retraso_min';

-- Y fuera los viejos. Dejarlos ahí sería dejar dos casillas que ya no mueven
-- nada: alguien las cambiaría, no pasaría nada, y ese silencio se le echaría
-- encima al sistema.
DELETE FROM parametro WHERE clave IN ('marcaje3.desfase_min', 'marcaje4.desfase_min');
