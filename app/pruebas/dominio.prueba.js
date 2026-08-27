// Pruebas de la lógica pura, sin base de datos. Se corren con: npm run prueba
//
// Los casos son celdas REALES del archivo del cliente
// (MONITOREO 09-AGOSTO-2026-FVA-MON DOMINGO.xlsx).
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizar, esRuido, detectarEstatus, partirCelda,
  claveCanonica, partirMultiples, aE164,
} from '../src/dominio/normalizar.js';
import { calcularMensualidad } from '../src/dominio/cobro.js';
import { distanciaMetros } from '../src/dominio/geocerca.js';

test('normalizar quita acentos, comas y colapsa espacios', () => {
  assert.equal(normalizar(' josé  martínez ,  V-21 '), 'JOSE MARTINEZ V-21');
  assert.equal(normalizar(',MARTIN 87'), 'MARTIN 87');
});

test('esRuido reconoce encabezados y pies de página', () => {
  assert.ok(esRuido('Página 1 de 1'));
  assert.ok(esRuido('Clave: FVA-MON-01'));
  assert.ok(esRuido('TURNO A'));
  assert.ok(esRuido('ENCARGADO'));
  assert.ok(!esRuido('RICARDO 04'));
});

test('detectarEstatus lee las palabras que el cliente escribe en la celda', () => {
  assert.equal(detectarEstatus('JUAN 45 CANCELADO'), 'cancelada');
  assert.equal(detectarEstatus('PEDRO V-3 VACACIONES'), 'vacaciones');
  assert.equal(detectarEstatus('MIGUEL F V-43'), null);
});

test('partirCelda maneja los seis formatos del archivo real', () => {
  assert.deepEqual(partirCelda('JUAN CARLOS V-22'), { nombre: 'JUAN CARLOS', unidad: 'V-22' });
  assert.deepEqual(partirCelda('RICARDO 04'), { nombre: 'RICARDO', unidad: '4' });
  assert.deepEqual(partirCelda('V-31 JESUS'), { nombre: 'JESUS', unidad: 'V-31' });
  assert.deepEqual(partirCelda('DANIEL V-12 SALIDA 7:00 PM'), { nombre: 'DANIEL', unidad: 'V-12' });
  assert.deepEqual(partirCelda('VIRGILIO'), { nombre: 'VIRGILIO', unidad: null });
  assert.deepEqual(partirCelda('ANDRES C-03'), { nombre: 'ANDRES', unidad: 'C-3' });
});

test('partirMultiples separa las celdas con dos conductores', () => {
  assert.deepEqual(partirMultiples('ARMANDO 63/JUAN F 49'), ['ARMANDO 63', 'JUAN F 49']);
  assert.deepEqual(partirMultiples('ALEJANDRO V-23/ ISRAEL V-38'), ['ALEJANDRO V-23', 'ISRAEL V-38']);
});

test('claveCanonica fusiona V-21 con 21 — esto decide la factura', () => {
  assert.equal(claveCanonica('V-21', true), '21');
  assert.equal(claveCanonica('21', true), '21');
  // La serie C- es otra flota: nunca se fusiona.
  assert.equal(claveCanonica('C-3', true), 'C-3');
  // Con la fusión apagada se facturan como unidades distintas.
  assert.equal(claveCanonica('V-21', false), 'V-21');
});

test('aE164 acepta los formatos que escribe RRHH', () => {
  assert.equal(aE164('4921234567'), '+524921234567');
  assert.equal(aE164('492 123 4567'), '+524921234567');
  assert.equal(aE164('+524921234567'), '+524921234567');
  assert.equal(aE164('5214921234567'), '+524921234567'); // formato viejo con el 1
  assert.equal(aE164('123'), null);
});

test('el cobro es por vehículo: las rutas no entran en la fórmula', () => {
  const base = { rentaBase: 1900, incluidas: 30, precioExtra: 50, iva: 0.16 };

  // 30 unidades o menos: sólo la renta base.
  assert.equal(calcularMensualidad({ vehiculosActivos: 30, ...base }).subtotal, 1900);
  assert.equal(calcularMensualidad({ vehiculosActivos: 12, ...base }).subtotal, 1900);

  // Escenario conservador del análisis: ~110 unidades.
  const c = calcularMensualidad({ vehiculosActivos: 110, ...base });
  assert.equal(c.adicionales, 80);
  assert.equal(c.subtotal, 5900);
  assert.equal(c.total, 6844);

  // Tal cual se detecta hoy: 134 unidades.
  assert.equal(calcularMensualidad({ vehiculosActivos: 134, ...base }).total, 8236);
});

test('con el contrato en 30 unidades la mensualidad es la renta base', () => {
  const base = { rentaBase: 1900, incluidas: 30, precioExtra: 50, iva: 0.16 };

  // El contrato arranca con 30 aunque el archivo traiga 113. El tope lo
  // impone la base (trigger en 005_limite_contrato.sql) y la vista de cobro
  // sólo cuenta unidades contratadas: nunca pueden llegar más de 30 aquí.
  const c = calcularMensualidad({ vehiculosActivos: 30, ...base });
  assert.equal(c.adicionales, 0);
  assert.equal(c.subtotal, 1900);
  assert.equal(c.total, 2204);

  // Y si el contrato crece, la fórmula sigue sirviendo sin tocar código:
  // basta subir el parámetro limite.vehiculos.
  assert.equal(calcularMensualidad({ vehiculosActivos: 40, ...base }).total, 2784);
});

test('Haversine da distancias razonables para las geocercas', () => {
  // Fresnillo → Zacatecas, ~54 km en línea recta.
  const d = distanciaMetros(23.1774, -102.8665, 22.7709, -102.5832);
  assert.ok(d > 50_000 && d < 60_000, `distancia inesperada: ${Math.round(d)} m`);
  assert.equal(Math.round(distanciaMetros(23.1774, -102.8665, 23.1774, -102.8665)), 0);
});
