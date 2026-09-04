-- ============================================================================
--  011 · La geocerca necesita el índice único que su propio endpoint da por hecho
--
--  POST /catalogos/geocercas hace 'ON CONFLICT (nombre) DO UPDATE' y la tabla
--  no tiene ningún índice único sobre nombre. Postgres no adivina: contesta
--  42P10 y la petición revienta con un 500. El endpoint nunca ha podido dar de
--  alta un filtro —por eso la tabla está vacía y la ubicación del marcaje 3 se
--  guarda pero no se valida contra nada—.
--
--  El nombre es la llave de verdad: volver a mandar 'FILTRO SAN LUIS' con
--  coordenadas corregidas tiene que actualizar el punto, no crear un segundo
--  filtro con el mismo rótulo y dejar al operador adivinando cuál manda.
-- ============================================================================

-- Por si alguna alta previa alcanzó a entrar duplicada antes de este arreglo:
-- se conserva la más reciente, que es la que alguien quiso dejar buena.
DELETE FROM geocerca g
 WHERE EXISTS (
   SELECT 1 FROM geocerca o
    WHERE o.nombre = g.nombre AND o.id > g.id
 );

CREATE UNIQUE INDEX IF NOT EXISTS ux_geocerca_nombre ON geocerca (nombre);
