// Carga del Excel semanal del cliente.
import { importarExcel } from '../importador/excel.js';
import { filas, unaFila, auditar } from '../db.js';
import { programarSemana } from '../dominio/programacion.js';
import { resincronizarAsignaciones } from '../dominio/contrato.js';

export default async function importacion(app) {
  app.addHook('preHandler', app.autenticar);

  app.post('/', { preHandler: [app.exigirRol('admin', 'operador')] }, async (req, reply) => {
    const archivo = await req.file();
    if (!archivo) return reply.code(400).send({ error: 'No se recibió ningún archivo' });
    if (!/\.xlsx$/i.test(archivo.filename)) {
      return reply.code(400).send({ error: 'Se espera un archivo .xlsx' });
    }

    const buffer = await archivo.toBuffer();
    const reporte = await importarExcel(buffer, archivo.filename, req.user.id);

    // Una unidad que este mismo archivo acaba de contratar sola (por estar en
    // TELEFONOS) puede traer asignaciones de cargas anteriores que nacieron
    // 'fuera_contrato' cuando todavía no estaba contratada. Sin esto se
    // quedan fantasma: la unidad ya cuenta para el contrato, pero esas rutas
    // de antes nunca se programan ni se cobran.
    const resync = await resincronizarAsignaciones();

    // Deja listos los 4 marcajes de cada asignación programada de la semana.
    const programados = await programarSemana(reporte.semanaInicio, reporte.semanaFin) + resync.programados;

    await auditar({
      usuarioId: req.user.id, accion: 'carga_excel', entidad: 'carga', entidadId: reporte.cargaId,
      detalle: { archivo: archivo.filename, leidas: reporte.leidas, pendientes: reporte.pendientes },
      ip: req.ip,
    });

    return { ...reporte, marcajesProgramados: programados };
  });

  app.get('/', async () =>
    filas(
      `SELECT c.id, c.archivo, c.semana_inicio, c.semana_fin, c.filas_leidas,
              c.filas_resueltas, c.filas_pendientes, c.estado, c.creado_en, u.correo AS subido_por
         FROM carga c LEFT JOIN usuario u ON u.id = c.subido_por
        ORDER BY c.creado_en DESC LIMIT 50`,
    ));

  app.get('/:id', async (req, reply) => {
    const c = await unaFila('SELECT * FROM carga WHERE id = $1', [req.params.id]);
    if (!c) return reply.code(404).send({ error: 'Carga no encontrada' });
    return c;
  });
}
