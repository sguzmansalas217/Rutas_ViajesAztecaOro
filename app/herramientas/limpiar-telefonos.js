// SÓLO DESARROLLO. Borra todos los teléfonos de los conductores.
//
// Se necesita antes de una prueba con número propio. El importador aplica el
// teléfono de la hoja TELEFONOS únicamente cuando el conductor NO tiene uno
// (ver aplicarTelefono en importador/excel.js): así una carga posterior nunca
// pisa un número corregido a mano desde el portal. El efecto secundario es
// que si el conductor ya trae el número real del cliente, el de tu archivo de
// prueba se ignora en silencio y los marcajes quedan apuntando a una persona
// de verdad. En simulado no pasa nada; con WA_SIMULADO=0 sí.
//
// Dejar la base de desarrollo sin ningún teléfono es la única forma de
// garantizar que un mensaje no pueda salir hacia un conductor del cliente.
// Los números vuelven solos al recargar el archivo bueno.
//
//   node herramientas/limpiar-telefonos.js --si
import { pool, unaFila, consultar } from '../src/db.js';

if (process.env.NODE_ENV === 'production') {
  console.error('Esto no se corre en producción. Borraría los teléfonos de la operación.');
  process.exit(1);
}

const con = await unaFila('SELECT count(*)::int AS n FROM conductor WHERE telefono_e164 IS NOT NULL');

if (!process.argv.includes('--si')) {
  console.log(`Hay ${con.n} conductores con teléfono. Se quedarían todos en blanco.`);
  console.log('Los marcajes ya programados pasan a "por resolver" hasta que se recargue el Excel.');
  console.log('\nSi es lo que quieres:  node herramientas/limpiar-telefonos.js --si');
  await pool.end();
  process.exit(0);
}

await consultar(`UPDATE conductor SET telefono_e164 = NULL, actualizado_en = now()
                  WHERE telefono_e164 IS NOT NULL`);

// Sin teléfono la asignación no puede mandar nada. Se refleja en el estado
// para que el tablero no prometa lo que no va a ocurrir, y para que los
// marcajes pendientes dejen de ser candidatos del trabajador.
const { rowCount: bajadas } = await consultar(
  `UPDATE asignacion a SET estado = 'por_resolver'
     FROM conductor c
    WHERE c.id = a.conductor_id
      AND a.estado = 'programada'
      AND c.telefono_e164 IS NULL`,
);

console.log(`Listo. ${con.n} teléfonos borrados, ${bajadas} asignaciones pasadas a "por resolver".`);
console.log('Ahora carga tu archivo de prueba: será el único número en la base.');

await pool.end();
