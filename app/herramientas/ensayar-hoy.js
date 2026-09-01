// SÓLO DESARROLLO. Adelanta unos marcajes a "dentro de un minuto" para poder
// ver el ciclo completo en la pantalla: se encolan, salen (simulados), y el
// semáforo cambia cuando el conductor contesta.
//
// Hace falta porque el archivo del cliente es de la semana del 3 al 9 de
// agosto de 2026 y el trabajador, a propósito, sólo toma lo que venció en los
// últimos 15 minutos: un marcaje de hace tres semanas ya no sirve y sólo
// costaría dinero. Sin esto la pantalla se queda quieta y parece descompuesta.
//
//   node herramientas/ensayar-hoy.js [cuántos]      (por omisión 3)
//
// No toca la fecha de la asignación: sigue siendo la de agosto y se ve en el
// tablero de ese día. Lo único que se mueve es la hora del marcaje.
import { pool, consultar, filas } from '../src/db.js';

const cuantos = Number(process.argv[2] ?? 3);

// Sólo asignaciones que de verdad podrían mandar mensaje: contratadas, con
// conductor activo y con teléfono. Si se tomara cualquiera, el trabajador la
// descartaría y el ensayo no enseñaría nada.
const listas = await filas(
  `SELECT a.id, c.nombre, v.clave AS unidad, r.nombre AS ruta, a.fecha
     FROM asignacion a
     JOIN ruta r      ON r.id = a.ruta_id
     JOIN conductor c ON c.id = a.conductor_id
     JOIN vehiculo v  ON v.id = a.vehiculo_id
    WHERE a.estado = 'programada'
      AND v.contratado AND c.activo AND c.telefono_e164 IS NOT NULL
      AND EXISTS (SELECT 1 FROM marcaje m
                   WHERE m.asignacion_id = a.id AND m.estado = 'pendiente')
    ORDER BY a.id
    LIMIT $1`,
  [cuantos],
);

if (!listas.length) {
  console.log('No hay asignaciones programadas con teléfono. Carga primero el Excel.');
  await pool.end();
  process.exit(0);
}

for (const a of listas) {
  // Se escalonan de minuto en minuto para que no salgan todas de golpe y se
  // alcance a ver el semáforo de cada una.
  const { rowCount } = await consultar(
    `UPDATE marcaje
        SET programado_para = now() + (numero * interval '1 minute'),
            estado = 'pendiente', semaforo = 'pendiente',
            enviado_en = NULL, respondido_en = NULL, intentos = 0
      WHERE asignacion_id = $1`,
    [a.id],
  );
  console.log(`#${a.id}  ${a.ruta} · ${a.nombre} (unidad ${a.unidad}) · ${rowCount} marcajes adelantados`);
}

console.log(`\nEl trabajador revisa cada 30 s. En 1-4 minutos deberían salir.`);
console.log(`Míralos en el tablero con fecha ${listas[0].fecha.toISOString().slice(0, 10)},`);
console.log(`o en los registros:  docker compose ... logs -f trabajador`);

await pool.end();
