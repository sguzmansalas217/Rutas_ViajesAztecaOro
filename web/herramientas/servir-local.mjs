// Servidor de un rato para revisar el portal ya construido sin levantar Nginx:
// sirve web/dist bajo /monitoreo/ y reenvía /monitoreo/api/ al API que corre en
// el contenedor (localhost:3000), igual que hace infra/nginx/default.conf.
//
//   node web/herramientas/servir-local.mjs [puerto]
//
// No es parte del despliegue. En producción esto lo hace Nginx.
import { createServer, request } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const PUERTO = Number(process.argv[2] ?? 8901);
// fileURLToPath y no .pathname: en Windows el pathname trae la unidad con una
// diagonal delante y los espacios de la ruta como %20.
const RAIZ = fileURLToPath(new URL('../dist/', import.meta.url));
const TIPOS = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json',
};

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname.startsWith('/monitoreo/api/')) {
    const arriba = request({
      host: '127.0.0.1', port: 3000, method: req.method,
      path: url.pathname.replace('/monitoreo/api/', '/api/') + url.search,
      headers: { ...req.headers, host: '127.0.0.1:3000' },
    }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    arriba.on('error', (e) => { res.writeHead(502); res.end(e.message); });
    req.pipe(arriba);
    return;
  }

  if (url.pathname === '/' || url.pathname === '/monitoreo') {
    res.writeHead(301, { location: '/monitoreo/' }); res.end(); return;
  }

  const rel = normalize(url.pathname.replace(/^\/monitoreo\//, '')).replace(/^(\.\.[/\\])+/, '');
  for (const archivo of [rel, 'index.html']) {
    try {
      const cuerpo = await readFile(join(RAIZ, archivo || 'index.html'));
      res.writeHead(200, { 'content-type': TIPOS[extname(archivo)] ?? 'application/octet-stream' });
      res.end(cuerpo);
      return;
    } catch { /* siguiente intento: el index, que el router es de hash */ }
  }
  res.writeHead(404); res.end('no está');
}).listen(PUERTO, () => console.log(`http://localhost:${PUERTO}/monitoreo/`));
