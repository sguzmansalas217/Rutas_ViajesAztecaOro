// ============================================================================
//  ENSAYO DE LA HOJA TELEFONOS  (herramienta de análisis, no de producción)
//
//  Antes de tocar el importador hay que saber cuántas filas de la hoja nueva
//  se pueden amarrar de verdad a un conductor que ya existe en la base. Este
//  script lo mide sin escribir nada: sólo lee el .xlsx y consulta.
//
//    node herramientas/ensayo-telefonos.js "ruta\al\archivo.xlsx"
// ============================================================================
import ExcelJS from 'exceljs';
import pg from 'pg';

import { normalizar, claveCanonica, aE164 } from '../src/dominio/normalizar.js';

const RUTA = process.argv[2];
if (!RUTA) {
  console.error('Falta la ruta del .xlsx');
  process.exit(1);
}

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL
    ?? 'postgres://monitoreo:monitoreo@localhost:5432/monitoreo',
});

// La columna de unidad de esta hoja trae 'ECO 41', '224', 'V-37', 'C-09'.
// 'ECO' es sólo la etiqueta de económico: la unidad es el número. Se confirmó
// contra las hojas de programación (ECO 82 = unidad 82, ARTURO REYES).
function unidadDeHoja(bruto) {
  const t = normalizar(bruto).replace(/\s*-\s*/g, '-');
  const sinEco = t.replace(/^ECO[- ]?/, '');
  const conPrefijo = sinEco.match(/^(V|C|ACM|TC)[- ]?(\d{1,3})$/);
  if (conPrefijo) return claveCanonica(`${conPrefijo[1]}-${String(Number(conPrefijo[2]))}`);
  const soloNumero = sinEco.match(/^(\d{1,3})$/);
  if (soloNumero) return String(Number(soloNumero[1]));
  return sinEco || null;
}

const libro = new ExcelJS.Workbook();
await libro.xlsx.readFile(RUTA);

const hoja = libro.worksheets.find((h) => normalizar(h.name).includes('TELEFONO'));
if (!hoja) {
  console.error('No hay hoja de teléfonos. Hojas:', libro.worksheets.map((h) => h.name));
  process.exit(1);
}

const texto = (f, c) => String(f.getCell(c).value ?? '').trim();

const filas = [];
let bloque = null;
for (let nf = 1; nf <= hoja.rowCount; nf++) {
  const f = hoja.getRow(nf);
  const a = texto(f, 1);
  const b = texto(f, 2);
  const nombre = normalizar(texto(f, 3));
  const unidad = texto(f, 4);
  const tel = texto(f, 5);

  // Fila de bloque: 'VAO' / 'ORO' en la columna B, sin nada más.
  if (!a && b && !nombre && !unidad && !tel) { bloque = normalizar(b); continue; }
  if (!nombre && !tel) continue;
  if (!/^\d+$/.test(a)) continue; // encabezados

  filas.push({
    fila: nf, bloque, ruta: normalizar(b), nombre,
    unidadBruta: unidad, unidad: unidadDeHoja(unidad),
    telBruto: tel, telefono: aE164(tel),
  });
}

console.log(`Hoja '${hoja.name}': ${filas.length} filas de datos\n`);

// ── Revisión de los teléfonos ───────────────────────────────────────────────
const malos = filas.filter((f) => !f.telefono);
if (malos.length) {
  console.log('TELEFONOS QUE NO SON VALIDOS:');
  for (const m of malos) {
    console.log(`  fila ${m.fila}: ${m.nombre} (${m.unidadBruta}) → "${m.telBruto}" (${String(m.telBruto).replace(/\D/g, '').length} dígitos)`);
  }
  console.log();
}

const porTel = new Map();
for (const f of filas.filter((x) => x.telefono)) {
  porTel.set(f.telefono, [...(porTel.get(f.telefono) ?? []), f]);
}
const repetidos = [...porTel.entries()].filter(([, v]) => v.length > 1);
if (repetidos.length) {
  console.log('TELEFONOS REPETIDOS:');
  for (const [t, v] of repetidos) console.log(`  ${t} → ${v.map((x) => x.nombre).join(', ')}`);
  console.log();
}

// ── Intento de amarre contra la base ────────────────────────────────────────
let porUnidadYNombre = 0;
let porUnidad = 0;
let porNombre = 0;
let sinAmarre = 0;
const detalle = [];

for (const f of filas) {
  // Candidatos: conductores que ya aparecen en asignaciones de esa unidad.
  const { rows: enUnidad } = await pool.query(
    `SELECT DISTINCT c.id, c.nombre
       FROM asignacion a
       JOIN conductor c ON c.id = a.conductor_id
       JOIN vehiculo  v ON v.id = a.vehiculo_id
      WHERE v.clave = $1`,
    [f.unidad],
  );

  const igual = enUnidad.filter((c) => normalizar(c.nombre) === f.nombre);
  // 'JUAN' contra 'JUAN FERNANDEZ': se acepta si el corto es la primera
  // palabra del largo, que es como el cliente abrevia.
  const parecido = enUnidad.filter((c) => {
    const n = normalizar(c.nombre);
    return n !== f.nombre && (n.startsWith(`${f.nombre} `) || f.nombre.startsWith(`${n} `));
  });

  const { rows: porNombreSolo } = await pool.query(
    'SELECT id, nombre FROM conductor WHERE upper(nombre) = $1',
    [f.nombre],
  );

  let via;
  if (igual.length === 1) { via = 'unidad+nombre'; porUnidadYNombre++; }
  else if (igual.length > 1) { via = `unidad+nombre AMBIGUO (${igual.length})`; porUnidadYNombre++; }
  else if (parecido.length === 1) { via = `unidad+parecido → ${parecido[0].nombre}`; porUnidadYNombre++; }
  else if (enUnidad.length === 1) { via = `sólo unidad → ${enUnidad[0].nombre}`; porUnidad++; }
  else if (porNombreSolo.length === 1) { via = 'sólo nombre'; porNombre++; }
  else if (porNombreSolo.length > 1) { via = `sólo nombre AMBIGUO (${porNombreSolo.length})`; porNombre++; }
  else { via = 'SIN AMARRE'; sinAmarre++; }

  detalle.push({ f, via, enUnidad: enUnidad.length });
}

console.log('AMARRE FILA POR FILA:');
for (const d of detalle) {
  const u = String(d.f.unidad ?? '?').padEnd(5);
  const n = d.f.nombre.padEnd(20);
  console.log(`  ${String(d.f.fila).padStart(3)} ${n} ${d.f.unidadBruta.padEnd(7)}→ ${u} ${d.via}`);
}

console.log(`\nRESUMEN: ${filas.length} filas`);
console.log(`  por unidad + nombre : ${porUnidadYNombre}`);
console.log(`  sólo por unidad     : ${porUnidad}`);
console.log(`  sólo por nombre     : ${porNombre}`);
console.log(`  sin amarre          : ${sinAmarre}`);

await pool.end();
