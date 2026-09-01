// Simula la operación real: se carga el Excel, se programan los marcajes, al
// día siguiente el cliente cambia un conductor y se vuelve a cargar.
// Comprueba qué pasa con la asignación vieja y con sus marcajes.
//   node herramientas/probar-recarga.js "ruta\al\archivo.xlsx"
import { readFile } from 'node:fs/promises';
import ExcelJS from 'exceljs';

import { importarExcel } from '../src/importador/excel.js';
import { programarSemana } from '../src/dominio/programacion.js';
import { pool, consultar } from '../src/db.js';

const ruta = process.argv[2];
const buf = await readFile(ruta);

console.log('── 1. Carga inicial ────────────────────────────────────────────');
const r1 = await importarExcel(buf, 'semana.xlsx', null);
console.log(`   programadas ${r1.resueltas}`);
const m1 = await programarSemana(r1.semanaInicio, r1.semanaFin);
console.log(`   marcajes generados ${m1}`);

// Se toma una asignación real y se cambia el conductor en esa misma celda,
// que es exactamente lo que hace el cliente cuando reasigna una unidad.
const { rows: [v] } = await consultar(
  `SELECT a.id, a.fecha, a.hoja, a.celda, a.texto_origen, a.estado
     FROM asignacion a WHERE a.estado='programada' AND a.celda IS NOT NULL
    ORDER BY a.id LIMIT 1`,
);
console.log(`\n   Se va a cambiar ${v.hoja}!${v.celda} (${v.fecha.toISOString().slice(0, 10)})`);
console.log(`   antes: "${v.texto_origen}"  → asignación ${v.id}`);

// Se simula que el primer marcaje del día YA SALIÓ antes de que llegara el
// cambio. Ese no se puede cancelar: es la prueba de que el conductor sí fue
// contactado, y borrarla sería reescribir lo que pasó.
await consultar(
  `UPDATE marcaje SET estado='enviado', enviado_en=now()
    WHERE asignacion_id=$1 AND numero=1`,
  [v.id],
);

const libro = new ExcelJS.Workbook();
await libro.xlsx.load(buf);
const hoja = libro.getWorksheet(v.hoja);
const nuevo = 'CONDUCTOR DE PRUEBA 99';
hoja.getCell(v.celda).value = nuevo;
const buf2 = Buffer.from(await libro.xlsx.writeBuffer());

console.log('\n── 2. Recarga con el cambio ────────────────────────────────────');
const r2 = await importarExcel(buf2, 'semana.xlsx', null);
console.log(`   programadas ${r2.resueltas}`);
console.log(`   filas retiradas ${r2.reemplazadas} · marcajes cancelados ${r2.marcajesCancelados}`);

console.log('\n── 3. ¿Qué quedó en esa ruta y ese día? ────────────────────────');
const { rows } = await consultar(
  `SELECT a.id, a.texto_origen, a.estado, a.carga_id,
          (SELECT count(*) FROM marcaje m WHERE m.asignacion_id=a.id) AS marcajes
     FROM asignacion a
    WHERE a.fecha=$1 AND a.ruta_id=(SELECT ruta_id FROM asignacion WHERE id=$2)
    ORDER BY a.id`,
  [v.fecha, v.id],
);
for (const f of rows) {
  const marca = f.texto_origen === nuevo ? 'NUEVA ' : f.id === Number(v.id) ? 'VIEJA ' : '      ';
  console.log(`   ${marca}#${f.id} carga ${f.carga_id} · ${f.estado.padEnd(13)} · ${f.marcajes} marcajes · "${f.texto_origen}"`);
}

const vieja = rows.find((f) => Number(f.id) === Number(v.id));
console.log(
  vieja && vieja.estado === 'programada'
    ? '\n   ⚠ LA VIEJA SIGUE VIVA Y PROGRAMADA: los dos conductores recibirían WhatsApp.'
    : '\n   ✓ La vieja quedó fuera de la programación.',
);

console.log('\n── 4. Marcajes de la fila retirada ─────────────────────────────');
const { rows: marcas } = await consultar(
  'SELECT numero, estado, enviado_en IS NOT NULL AS salio FROM marcaje WHERE asignacion_id=$1 ORDER BY numero',
  [v.id],
);
for (const m of marcas) {
  console.log(`   marcaje ${m.numero}: ${m.estado.padEnd(10)} ${m.salio ? '(ya había salido)' : ''}`);
}
const enviado = marcas.find((m) => m.salio);
const pendientes = marcas.filter((m) => !m.salio);
console.log(
  enviado?.estado === 'enviado' && pendientes.every((m) => m.estado === 'cancelado')
    ? '\n   ✓ Se canceló lo que no había salido y se respetó lo que sí.'
    : '\n   ⚠ Los marcajes no quedaron como se esperaba.',
);

await pool.end();
