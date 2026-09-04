// SÓLO DESARROLLO. Genera un Excel mínimo con UNA ruta y UN conductor.
//
// Distinto de preparar-prueba.js, que recorta las fechas del archivo del
// cliente pero conserva sus 30 conductores reales. Aquí el archivo se escribe
// desde cero con una sola celda ocupada: ningún número real puede recibir un
// WhatsApp por accidente, aunque alguien marque otra unidad como contratada.
//
// La ruta y el encargado son los del archivo real (MAÑANA fila 8) para que el
// tablero se vea como se va a ver en producción y no como una maqueta.
//
//   node herramientas/prueba-una-ruta.js [opciones]
//     --hora       15:00              hora de monitoreo   (por omisión: dentro de 6 min)
//     --conductor  "PRUEBA UNO 21"    texto tal cual va en la celda del día
//     --ruta       "ALCOHOLIMETRO ZAC"
//     --parada     "TERMINAL"
//     --nota       "PRUEBA DE MONITOREO"
//     --encargado  SERGIO
//     --dia        2026-09-04         día que se llena    (por omisión hoy)
//     --salida     archivo.xlsx
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';

const args = process.argv.slice(2);
const opt = (n, def) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};

const ahora = new Date();
const enSeis = new Date(ahora.getTime() + 6 * 60_000);
const dosDig = (n) => String(n).padStart(2, '0');

const horaTexto = opt('hora', `${dosDig(enSeis.getHours())}:${dosDig(enSeis.getMinutes())}`);
const mm = horaTexto.match(/^(\d{1,2}):(\d{2})$/);
if (!mm) {
  console.error(`La hora "${horaTexto}" no se entiende. Se espera HH:MM en 24 h, por ejemplo 15:00.`);
  process.exit(1);
}
const hh = Number(mm[1]);
const mi = Number(mm[2]);
if (hh > 23 || mi > 59) {
  console.error(`La hora "${horaTexto}" no existe.`);
  process.exit(1);
}

const conductor = opt('conductor', 'PRUEBA UNO 21');
const nombreRuta = opt('ruta', 'ALCOHOLIMETRO ZAC');
const parada = opt('parada', 'PLAZA BICENTENARIO');
const nota = opt('nota', 'PRUEBA DE MONITOREO');
const encargado = opt('encargado', 'SERGIO');
const salida = opt('salida', 'prueba-una-ruta.xlsx');

// ── La semana del día elegido, de lunes a domingo ───────────────────────────
// El importador exige al menos 4 fechas en la fila para reconocerla como la
// del encabezado, así que la semana va completa aunque sólo se llene un día.
const dia = opt('dia') ? new Date(`${opt('dia')}T12:00:00`) : ahora;
const hoy = new Date(dia.getFullYear(), dia.getMonth(), dia.getDate());
const diaSemana = hoy.getDay();
const indiceHoy = diaSemana === 0 ? 6 : diaSemana - 1;   // domingo cierra la semana
const lunes = new Date(hoy);
lunes.setDate(hoy.getDate() - indiceHoy);

const iso = (d) => `${d.getFullYear()}-${dosDig(d.getMonth() + 1)}-${dosDig(d.getDate())}`;
const DIAS = ['LUNES', 'MARTES', 'MIERCOLES', 'JUEVES', 'VIERNES', 'SABADO', 'DOMINGO'];

// ── El archivo ──────────────────────────────────────────────────────────────
// Layout de la hoja MAÑANA del formato FVA-MON-01, que es lo que el importador
// sabe leer: fechas en la fila 4, etiquetas en la 5, datos a partir de la 6.
// Columnas F..L (6..12) son lunes..domingo.
const libro = new ExcelJS.Workbook();
const hoja = libro.addWorksheet('MAÑANA');

hoja.getRow(2).getCell(3).value = 'MONITOREO DE RUTAS';
hoja.getRow(3).getCell(2).value = 'RELACION SEMANAL MONITOREO — PRUEBA';

// UTC a propósito: así las lee el importador y el huso horario no corre el día.
for (let i = 0; i < 7; i++) {
  const d = new Date(lunes);
  d.setDate(lunes.getDate() + i);
  const celda = hoja.getRow(4).getCell(6 + i);
  celda.value = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  celda.numFmt = 'dd-mmm';
}

const etiquetas = hoja.getRow(5);
etiquetas.getCell(2).value = 'HORA MONITOREO';
etiquetas.getCell(3).value = 'RUTA';
etiquetas.getCell(4).value = 'NOTAS';
etiquetas.getCell(5).value = 'PARADA INICIAL';
DIAS.forEach((d, i) => { etiquetas.getCell(6 + i).value = d; });
etiquetas.getCell(13).value = 'ENCARGADO';

const fila = hoja.getRow(6);
// Excel guarda las horas como fracción de día; escribirlo así deja la celda
// igual que en el archivo del cliente y el importador la lee sin ambigüedad.
fila.getCell(2).value = (hh * 60 + mi) / 1440;
fila.getCell(2).numFmt = 'h:mm';
fila.getCell(3).value = nombreRuta;
fila.getCell(4).value = nota;
fila.getCell(5).value = parada;
fila.getCell(6 + indiceHoy).value = conductor;   // sólo el día de hoy
fila.getCell(13).value = encargado;

hoja.getColumn(2).width = 16;
hoja.getColumn(3).width = 24;
hoja.getColumn(4).width = 22;
hoja.getColumn(5).width = 22;
for (let i = 0; i < 7; i++) hoja.getColumn(6 + i).width = 16;
hoja.getColumn(13).width = 14;

await writeFile(salida, Buffer.from(await libro.xlsx.writeBuffer()));

// ── Qué va a pasar ──────────────────────────────────────────────────────────
// La hoja MAÑANA no trae columna de salida, así que los marcajes 3 y 4 cuelgan
// de hora_monitoreo + 40 min (ver dominio/programacion.js).
const enMin = (n) => `${dosDig(Math.floor(n / 60) % 24)}:${dosDig(n % 60)}`;
const base = hh * 60 + mi;

console.log(`\nEscrito: ${path.resolve(salida)}`);
console.log(`Semana ${iso(lunes)} → ${iso(new Date(lunes.getTime() + 6 * 86400000))}`);
console.log(`Ruta "${nombreRuta}" el ${DIAS[indiceHoy]} ${iso(hoy)} a las ${horaTexto}, con ${conductor}.`);
console.log(`\nCon los desfases de producción los marcajes salen a las:`);
console.log(`   1 despertar   ${enMin(base)}`);
console.log(`   2 revisión    ${enMin(base + 10)}`);
console.log(`   3 filtro      ${enMin(base + 20)}   (salida − 20)`);
console.log(`   4 salida      ${enMin(base + 40)}`);
console.log(`\nSúbelo en Cargar Excel y pon el tablero en ${iso(hoy)}.`);
