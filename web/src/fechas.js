// Qué día es hoy, según el reloj de quien está mirando la pantalla.
//
// Suena a trivialidad y no lo es. Lo que se usaba antes era
// `new Date().toISOString().slice(0, 10)`, y ese método da la fecha en
// Greenwich, no aquí. En Aguascalientes son seis horas menos, así que desde las
// 18:00 y hasta la medianoche el navegador ya cree que es el día siguiente: el
// Tablero y el Historial pedían la fecha de mañana, la API contestaba —con toda
// razón— que ahí no hay nada, y las pantallas se vaciaban solas cada tarde.
//
// Se usa el reloj del navegador a propósito, no una zona escrita a mano: el
// monitorista ve el día que él está viviendo, que es el único que le sirve para
// levantar el teléfono.
export function hoyLocal() {
  const d = new Date();
  const mes = String(d.getMonth() + 1).padStart(2, '0');
  const dia = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mes}-${dia}`;
}

/** El mes en curso, como 'AAAA-MM-01'. Mismo motivo que arriba. */
export const mesLocal = () => `${hoyLocal().slice(0, 7)}-01`;
