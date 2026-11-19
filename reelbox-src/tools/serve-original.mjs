// Serve the upstream compiled Cloudflare-module build over plain node http,
// so it can be compared against the reconstruction.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const root = '/home/user/ddddddd/reelbox/dist/client';
const handler = (await import('/home/user/ddddddd/reelbox/dist/server/index.mjs')).default;

const types = {
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:8791');
  const p = normalize(decodeURIComponent(url.pathname));
  if (p !== '/' && /\.\w+$/.test(p)) {
    try {
      const buf = await readFile(join(root, p));
      res.writeHead(200, { 'content-type': types[extname(p)] || 'application/octet-stream' });
      return res.end(buf);
    } catch {
      /* fall through to SSR */
    }
  }
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req);
  const request = new Request(url, {
    method: req.method,
    headers: req.headers,
    body,
  });
  const response = await handler.fetch(request, {}, { waitUntil() {}, passThroughOnException() {} });
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
});

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

server.listen(8791, '0.0.0.0', () => console.log('original on 8791'));
