-- ============================================================================
--  002 · Parámetros iniciales
--  NADA de esto vive en el código: se edita desde el portal y aplica en caliente.
-- ============================================================================

INSERT INTO parametro (clave, valor, descripcion) VALUES

-- ── Precio (Cláusula Tercera del contrato) ──────────────────────────────────
('precio.renta_base',      '1900',  'Renta mensual base en MXN, sin IVA'),
('precio.incluidas',       '30',    'Vehículos activos incluidos en la renta base'),
('precio.extra',           '50',    'MXN sin IVA por vehículo activo adicional'),
('precio.iva',             '0.16',  'Tasa de IVA'),

-- ── Tarifas de Meta (Cláusula Cuarta) ───────────────────────────────────────
-- Este valor es la evidencia documental para invocar el ajuste de precio.
-- ⚠️ VERIFICAR CONTRA EL TARIFARIO OFICIAL DE META EL 1 DE SEPTIEMBRE DE 2026.
('tarifa.meta_utility_usd', '0.0085', 'USD por plantilla utility entregada en México'),
('tarifa.tipo_cambio',      '18.50',  'MXN por USD para el medidor de costo'),
('tarifa.umbral_alerta_usd','120',    'Avisar si el costo Meta del mes supera esto'),

-- ── Tiempos operativos (configurables, minuta 2026-08-24) ───────────────────
('alerta.espera_min',       '5',   'Minutos sin respuesta antes de rojo y alerta'),
('marcaje2.retraso_min',    '10',  'Minutos tras confirmar el marcaje 1'),
('marcaje.tolerancia_min',  '15',  'Ventana para aceptar una respuesta como válida'),
('geocerca.radio_default_m','300', 'Radio por defecto de las geocercas nuevas'),

-- ── Importador ──────────────────────────────────────────────────────────────
-- ⚠️ Decide si '21' y 'V-21' son la misma unidad. AFECTA DIRECTAMENTE LA FACTURA.
-- En true reduce ~25 unidades fantasma; siempre queda reportado en el detalle
-- de la carga para que se pueda revisar.
('importador.fusionar_prefijo_v', 'true',
 'Tratar 21 y V-21 como la misma unidad (afecta el conteo facturable)'),
('importador.crear_conductores',  'true',
 'Dar de alta conductores nuevos automáticamente, sin teléfono, como por_resolver'),

-- ── Retención de datos personales (LFPDPPP) ─────────────────────────────────
('datos.retencion_ubicacion_dias', '180',
 'Días que se conserva la geolocalización de los conductores antes de borrarla'),

-- ── WhatsApp ────────────────────────────────────────────────────────────────
('wa.plantilla_marcaje1', '"marcaje_despertar"',
 'Nombre de la plantilla aprobada en Meta para el marcaje 1'),
('wa.ventana_horas', '24', 'Duración de la ventana de servicio gratuita');
