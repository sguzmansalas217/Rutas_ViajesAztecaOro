// Vuelca un .xlsx tal cual para ver qué trae, sin abrir Excel.
//   node herramientas/ver-excel.js "ruta\al\archivo.xlsx"
import { readFile } from 'node:fs/promises';
import ExcelJS from 'exceljs';

const libro = new ExcelJS.Workbook();
await libro.xlsx.load(await readFile(process.argv[2]));

for (const hoja of libro.worksheets) {
  console.log(`\n═══ HOJA "${hoja.name}"  (${hoja.rowCount} filas × ${hoja.columnCount} col) ═══`);
  hoja.eachRow({ includeEmpty: false }, (fila, n) => {
    const celdas = [];
    fila.eachCell({ includeEmpty: false }, (celda, col) => {
      const v = celda.value;
      const txt = v && typeof v === 'object'
        ? (v.richText?.map((t) => t.text).join('') ?? v.text ?? v.result ?? JSON.stringify(v))
        : v;
      celdas.push(`${celda.address}="${String(txt).replace(/\s+/g, ' ').trim()}"`);
    });
    if (celdas.length) console.log(`  ${String(n).padStart(3)} │ ${celdas.join('  ')}`);
  });
}
