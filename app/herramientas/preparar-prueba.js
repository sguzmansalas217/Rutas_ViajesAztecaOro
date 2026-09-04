// SÓLO DESARROLLO. Prepara una copia del Excel para poder ver el ciclo hoy.
//
// El archivo del cliente es de una semana concreta y sus horas son de
// madrugada. Cargado tal cual, los marcajes nacen con fecha y hora pasadas y
// el trabajador nunca los toma: sólo dispara lo que venció en los últimos 15
// minutos, a propósito, porque un marcaje viejo ya no sirve y costaría dinero.
//
// Esta herramienta hace dos cosas sobre una COPIA (el original no se toca):
//   1. Recorre la fila de fechas de cada hoja a la semana en curso.
//   2. Pone la hora de monitoreo de una ruta a la hora que le pidas.
//
//   node herramientas/preparar-prueba.js <entrada.xlsx> [opciones]
//     --hoja  MAÑANA     hoja donde está la ruta          (por omisión MAÑANA)
//     --fila  89         fila de la ruta en esa hoja
//     --hora  10:15      hora de monitoreo   (por omisión: dentro de 5 min)
//     --salida x.xlsx    archivo a escribir  (por omisión <entrada>-hoy.xlsx)
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';

// ── Argumentos ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const entrada = args[0];
if (!entrada || entrada.startsWith('--')) {
  console.error('Falta el archivo de entrada.');
  console.error('  node herramientas/preparar-prueba.js "ruta\\al\\archivo.xlsx" --fila 89 --hora 10:15');
  process.exit(1);
}
const opt = (n, def) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};

const nombreHoja = opt('hoja', 'MAÑANA');
const filaRuta = Number(opt('fila', 89));
const salida = opt('salida', entrada.replace(/\.xlsx$/i, '-hoy.xlsx'));

// Por omisión, dentro de 5 minutos: da tiempo a cargar el archivo en el portal
// antes de que salga el primer mensaje.
const ahora = new Date();
const porOmision = new Date(ahora.getTime() + 5 * 60_000);
const horaTexto = opt('hora',
  `${String(porOmision.getHours()).padStart(2, '0')}:${String(porOmision.getMinutes()).padStart(2, '0')}`);

const mm = horaTexto.match(/^(\d{1,2}):(\d{2})$/);
if (!mm) {
  console.error(`La hora "${horaTexto}" no se entiende. Se espera HH:MM, por ejemplo 10:15.`);
  process.exit(1);
}
const hh = Number(mm[1]);
const mi = Number(mm[2]);
if (hh > 23 || mi > 59) {
  console.error(`La hora "${horaTexto}" no existe.`);
  process.exit(1);
}

// ── La semana en curso, de lunes a domingo ──────────────────────────────────
// El Excel va de lunes a domingo, así que el lunes es el ancla. getDay() da 0
// para domingo: ese día pertenece a la semana que ya va terminando, no a la
// que empieza al día siguiente.
const hoy = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate());
const diaSemana = hoy.getDay();
const lunes = new Date(hoy);
lunes.setDate(hoy.getDate() - (diaSemana === 0 ? 6 : diaSemana - 1));

const DIAS = ['LUNES', 'MARTES', 'MIERCOLES', 'JUEVES', 'VIERNES', 'SABADO', 'DOMINGO'];
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const indiceHoy = diaSemana === 0 ? 6 : diaSemana - 1;

const libro = new ExcelJS.Workbook();
await libro.xlsx.load(await readFile(entrada));

// ── 1. Recorrer las fechas ──────────────────────────────────────────────────
// Se busca la fila de fechas por contenido y no por número, igual que el
// importador: no todas las hojas la tienen en el mismo renglón.
let hojasMovidas = 0;
let columnaHoy = null;

for (const hoja of libro.worksheets) {
  let filaFechas = 0;
  let columnas = [];

  for (let nf = 1; nf <= Math.min(hoja.rowCount, 20) && !filaFechas; nf++) {
    const cols = [];
    for (let c = 1; c <= hoja.columnCount; c++) {
      if (hoja.getRow(nf).getCell(c).value instanceof Date) cols.push(c);
    }
    // Al menos 4 fechas en la misma fila: menos que eso puede ser una celda
    // suelta con la fecha de impresión.
    if (cols.length >= 4) { filaFechas = nf; columnas = cols; }
  }
  if (!filaFechas) continue;

  // Se escriben en el orden en que aparecen: la primera columna es el lunes.
  columnas.sort((a, b) => a - b).forEach((col, i) => {
    if (i > 6) return;
    const d = new Date(lunes);
    d.setDate(lunes.getDate() + i);
    // UTC a propósito: así las lee el importador, y así evita que el huso
    // horario corra la fecha un día.
    hoja.getRow(filaFechas).getCell(col).value = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    if (hoja.name === nombreHoja && i === indiceHoy) columnaHoy = col;
  });
  hojasMovidas++;
}

// ── 2. La hora de la ruta ───────────────────────────────────────────────────
const hoja = libro.getWorksheet(nombreHoja);
if (!hoja) {
  console.error(`No hay ninguna hoja llamada "${nombreHoja}". Hay: ${libro.worksheets.map((h) => h.name).join(', ')}`);
  process.exit(1);
}

const fila = hoja.getRow(filaRuta);
const nombreRuta = fila.getCell(3).value;
if (!nombreRuta) {
  console.error(`La fila ${filaRuta} de "${nombreHoja}" está vacía: ahí no hay ninguna ruta.`);
  process.exit(1);
}

// Excel guarda las horas como fracción de día. Escribirlo así y no como texto
// deja la celda igual que las demás y el importador la lee sin ambigüedad.
fila.getCell(2).value = (hh * 60 + mi) / 1440;
fila.getCell(2).numFmt = 'h:mm';

const quienHoy = columnaHoy ? fila.getCell(columnaHoy).value : null;

await writeFile(salida, Buffer.from(await libro.xlsx.writeBuffer()));

// ── Qué va a pasar ──────────────────────────────────────────────────────────
// La hoja MAÑANA no trae columna de salida, así que los marcajes 3 y 4 se
// derivan de hora_monitoreo + 40 min (ver dominio/programacion.js).
const enMin = (h, m) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
const mas = (n) => { const t = hh * 60 + mi + n; return enMin(Math.floor(t / 60) % 24, t % 60); };

console.log(`\nEscrito: ${path.resolve(salida)}`);
console.log(`Semana movida a ${iso(lunes)} → ${iso(new Date(lunes.getTime() + 6 * 86400000))} en ${hojasMovidas} hojas.`);
console.log(`Hoy es ${DIAS[indiceHoy]} ${iso(hoy)}.`);
console.log(`\nRuta: "${nombreRuta}" (${nombreHoja} fila ${filaRuta}) a las ${horaTexto}.`);
console.log(`Hoy la maneja: ${quienHoy ?? '— la celda de hoy está vacía, no se va a programar —'}`);
console.log(`\nLos cuatro marcajes saldrían a las:`);
console.log(`   1 despertar   ${mas(0)}`);
console.log(`   2 revisión    ${mas(10)}`);
console.log(`   3 filtro      ${mas(20)}`);
console.log(`   4 salida      ${mas(40)}`);
console.log(`\nSúbelo en el portal y pon el tablero en la fecha de hoy.`);
