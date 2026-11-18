'use strict';
/**
 * Static serving driven by the directory, not by a hand-kept table.
 *
 * The table this replaces meant every new stylesheet was a server edit, and a
 * file the page asked for but nobody remembered to add was a silent 404. Here a
 * request resolves against `public/` by name; anything outside it is refused.
 */
const fs = require('node:fs');
const path = require('node:path');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

/**
 * @param {string} root  the application directory (contains `public/`)
 * @param {Map<string,string>} vendored  extra URL -> path pairs, e.g. the
 *   player library, which is served under a stable name because its version
 *   lives in package.json and a page should not name it.
 */
function createStatic({ root, vendored = new Map() } = {}) {
  const publicDir = path.join(root, 'public');

  function resolve(urlPath) {
    const vendoredFile = vendored.get(urlPath);
    if (vendoredFile) return path.join(root, vendoredFile);
    const name = urlPath === '/' ? 'index.html' : urlPath.replace(/^\//, '');
    // One flat directory: no subpaths, no dotfiles. A traversal attempt has a
    // slash or a leading dot and is refused before it touches the filesystem.
    if (!name || name.includes('/') || name.includes('\\') || name.startsWith('.')) return null;
    const file = path.join(publicDir, name);
    return path.dirname(file) === publicDir ? file : null;
  }

  /** @returns {{file:string,type:string,size:number,modified:Date}|null} */
  function lookup(urlPath) {
    const file = resolve(urlPath);
    if (!file) return null;
    const type = TYPES[path.extname(file).toLowerCase()];
    if (!type) return null;
    let stats;
    try {
      stats = fs.statSync(file);
    } catch {
      return null;
    }
    if (!stats.isFile()) return null;
    return { file, type, size: stats.size, modified: stats.mtime };
  }

  /** Streams an entry, answering a matching validator with 304 so a reload is free. */
  function send(req, res, entry) {
    const etag = `"${entry.size.toString(16)}-${Math.floor(entry.modified.getTime() / 1000).toString(16)}"`;
    const headers = {
      'Content-Type': entry.type,
      'Cache-Control': 'no-cache',
      ETag: etag,
      'Last-Modified': entry.modified.toUTCString(),
    };
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    res.writeHead(200, { ...headers, 'Content-Length': entry.size });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(entry.file).pipe(res);
  }

  return { lookup, send, resolve };
}

module.exports = { createStatic, TYPES };
