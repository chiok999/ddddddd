// Serve the reconstruction's production build (dist/) on 8793 for fidelity diffing.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const root = '/home/user/ddddddd/reelbox-src/dist/client';
const entry = (await import('/home/user/ddddddd/reelbox-src/dist/server/server.js')).default;

const types = {
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

const fetchFn = typeof entry === 'function' ? entry : entry.fetch.bind(entry);

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:8793');
  const p = normalize(decodeURIComponent(url.pathname));
  if (p !== '/' && /\.\w+$/.test(p)) {
    try {
      const buf = await readFile(join(root, p));
      res.writeHead(200, { 'content-type': types[extname(p)] || 'application/octet-stream' });
      return res.end(buf);
    } catch {
      /* fall through */
    }
  }
  const response = await fetchFn(new Request(url, { method: req.method, headers: req.headers }));
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
});

server.listen(8793, '0.0.0.0', () => console.log('rebuilt prod on 8793'));
