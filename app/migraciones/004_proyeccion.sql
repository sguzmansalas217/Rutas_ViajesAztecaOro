-- ============================================================================
--  PROYECCIÓN DE UNIDADES
--
--  vehiculo_activo_mes sólo cuenta asignaciones en estado 'programada', y eso
--  está bien para facturar: si el conductor no tiene teléfono no hubo
--  monitoreo, y lo que no se monitoreó no se cobra.
--
--  El problema es operativo. Al subir el primer Excel, TODO cae en
--  'por_resolver' (el archivo del cliente no trae un solo teléfono), así que
--  el tablero muestra 0 vehículos y $1,900 de renta base. Ese número no dice
--  nada sobre lo que va a costar el servicio cuando el padrón esté completo.
--
--  Esta vista cuenta las unidades que APARECEN en el archivo, sin filtrar por
--  estado. No factura: sirve para saber de qué tamaño es la operación antes
--  de sentarse a hablar de precio. La diferencia no es menor —en el archivo
--  del 3 al 9 de agosto son ~30 contra ~134 unidades, o sea $2,204 contra
--  $8,236 al mes— y por eso conviene tener el dato antes, no después.
-- ============================================================================

CREATE VIEW vehiculo_en_archivo_mes AS
SELECT date_trunc('month', a.fecha)::date AS periodo,
       a.vehiculo_id,
       v.clave                            AS vehiculo,
       count(*)                           AS asignaciones,
       count(DISTINCT a.ruta_id)          AS rutas_distintas,
       count(DISTINCT a.fecha)            AS dias_activos,
       count(*) FILTER (WHERE a.estado = 'programada')  AS asignaciones_programadas,
       count(*) FILTER (WHERE a.estado = 'por_resolver') AS asignaciones_por_resolver
FROM   asignacion a
JOIN   vehiculo   v ON v.id = a.vehiculo_id
WHERE  a.vehiculo_id IS NOT NULL
  AND  a.estado <> 'cancelada'
GROUP  BY 1, 2, 3;

COMMENT ON VIEW vehiculo_en_archivo_mes IS
  'Unidades presentes en el Excel del periodo, sin filtrar por estado. '
  'Sirve para proyectar la mensualidad; NO es la base de la factura. '
  'Para facturar se usa vehiculo_activo_mes.';
