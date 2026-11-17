'use strict';
// Locates or fetches a static FFmpeg when the machine has no usable one.
//
// Two supported routes, in this order:
//   1. the `ffmpeg-static` npm package (npm install ffmpeg-static) -- the panel
//      already runs npm install on every restart, so this survives restarts;
//   2. a direct download of the same prebuilt binary from its GitHub release,
//      into the directory given (the application directory is a good choice).
//
// URLs mirror ffmpeg-static's own install.js, so both routes fetch the identical
// build: https://github.com/eugeneware/ffmpeg-static/releases/<tag>/ffmpeg-<platform>-<arch>.gz

const fs = require('node:fs');
const fsp = require('node:fs').promises;
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const zlib = require('node:zlib');
const { pipeline } = require('node:stream/promises');

const RELEASE = process.env.FFMPEG_BINARY_RELEASE || 'b6.1.1';
const BASE = 'https://github.com/eugeneware/ffmpeg-static/releases/download';

function assetName(platform = process.platform, arch = process.arch) {
  return `ffmpeg-${platform}-${arch}.gz`;
}
function downloadUrl(platform, arch) {
  return `${BASE}/${RELEASE}/${assetName(platform, arch)}`;
}

// The package path, if it happens to be installed.
function fromNpmPackage() {
  try {
    const resolved = require.resolve('ffmpeg-static');
    const binary = require(resolved);
    if (typeof binary === 'string' && fs.existsSync(binary)) return binary;
  } catch { /* not installed */ }
  return null;
}

function follow(url, hops = 0) {
  return new Promise((resolve, reject) => {
    if (hops > 6) return reject(new Error('too many redirects'));
    const request = https.get(url, { headers: { 'user-agent': 'troy-ffmpeg' }, timeout: 60000 }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.resume();
        const next = new URL(response.headers.location, url).href;
        return resolve(follow(next, hops + 1));
      }
      if (response.statusCode !== 200) {
        response.resume();
        return reject(new Error(`HTTP ${response.statusCode} from ${url}`));
      }
      resolve(response);
    });
    request.on('error', reject);
    request.on('timeout', () => request.destroy(new Error('download timed out')));
  });
}

// Downloads and decompresses the .gz asset straight to a binary.
async function download(destination, { platform = process.platform, arch = process.arch } = {}) {
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  const partial = `${destination}.part`;
  const response = await follow(downloadUrl(platform, arch));
  try {
    await pipeline(response, zlib.createGunzip(), fs.createWriteStream(partial));
    await fsp.chmod(partial, 0o755);
    await fsp.rename(partial, destination);
    return destination;
  } catch (error) {
    await fsp.rm(partial, { force: true }).catch(() => {});
    throw error;
  }
}

module.exports = { fromNpmPackage, download, downloadUrl, assetName, RELEASE };
