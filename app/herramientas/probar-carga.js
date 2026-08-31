// Corre el importador contra la base y enseña el reporte. Sirve para probar un
// archivo sin pasar por el portal.
//   node herramientas/probar-carga.js "ruta\al\archivo.xlsx"
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

import { importarExcel } from '../src/importador/excel.js';
import { pool } from '../src/db.js';

const ruta = process.argv[2];
if (!ruta) { console.error('Falta la ruta del .xlsx'); process.exit(1); }

const r = await importarExcel(await readFile(ruta), basename(ruta), null);

console.log('\n== CARGA', r.cargaId, `(${r.semanaInicio} a ${r.semanaFin}) ==`);
console.log(`  leídas ${r.leidas} · programadas ${r.resueltas} · por resolver ${r.pendientes} · fuera de contrato ${r.fueraContrato}`);
console.log('  hojas:', r.hojas, '· ignoradas:', r.ignoradas);

if (!r.telefonos) console.log('\n== SIN HOJA DE TELEFONOS ==');
else {
  const t = r.telefonos;
  console.log(`\n== HOJA '${t.hoja}': ${t.filas} filas ==`);
  console.log(`  aplicados ${t.aplicados} · ya tenían ${t.yaTenian} · inválidos ${t.invalidos.length} · duplicados ${t.duplicados.length} · sin amarre ${t.sinAmarre.length}`);
  for (const i of t.invalidos)  console.log(`  ✗ inválido  fila ${i.fila}: ${i.nombre} (${i.unidad}) "${i.texto}" — ${i.digitos} dígitos`);
  for (const d of t.repetidos)  console.log(`  ✗ repetido  ${d.telefono}: ${d.filas.map((f) => f.nombre).join(', ')}`);
  for (const d of t.duplicados) console.log(`  ⚑ duplicado ${d.nombre} (${d.unidad}) — el número ya lo tiene otro registro`);
  for (const s of t.sinAmarre)  console.log(`  ⚑ sin amarre fila ${s.fila}: ${s.nombre} (${s.unidad})`);
}

await pool.end();
