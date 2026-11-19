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
    if (!name) return null;
    // Subdirectories are allowed because the app shell has its own `assets/`
    // directory and a hashed bundle is not a hand-kept table either. Every
    // segment is still checked, so `..`, a leading dot, or a backslash is
    // refused before the filesystem is touched -- this is the same rule as
    // before, applied per segment instead of to the whole path.
    const segments = name.split('/');
    if (segments.some(segment => !segment || segment.startsWith('.') || segment.includes('\\'))) return null;
    const file = path.join(publicDir, ...segments);
    // The resolved path must stay inside `public/`, which is a stronger check
    // than comparing the parent directory now that nesting is permitted.
    const relative = path.relative(publicDir, file);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
    return file;
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
