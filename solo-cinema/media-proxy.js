'use strict';
const {Readable} = require('node:stream');
const {createPlaylistRewriter} = require('./playlist-rewrite');

// Same-origin media relay for authorized playback.
//
// Why this exists: provider CDNs commonly reject requests that are not made by
// a browser (missing Referer/Origin/User-Agent, or a datacenter client), and a
// browser cannot send those headers itself while also respecting CORS. Relaying
// through Troy lets the required headers be applied server-side and removes the
// CORS problem, because the <video>/hls.js request is same-origin.
//
// Guarantees:
// - Bytes are streamed, never buffered, so memory use is independent of size.
// - Every upstream connection goes through the caller's pinned-DNS fetcher,
//   which validates HTTPS, public addresses and each redirect hop.
// - Range requests are forwarded verbatim so the browser can seek natively and
//   FFmpeg is not needed for normal playback.
// - Active relays are capped per session and globally so a small host cannot be
//   exhausted by parallel tile/segment fetches.
const RANGE = /^bytes=\d*-\d*$/;
const PLAYLIST = /mpegurl/i;
const MAX_PLAYLIST = 4 * 1024 * 1024;
const SAFE_RESPONSE_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified'];

function createMediaProxy({openMedia, createHandle, safeUrl, perSession = 6, global = 24, now = Date.now, onError = () => {}}) {
  const active = new Map(); // sid -> count
  let total = 0;

  function release(sid) {
    total = Math.max(0, total - 1);
    const count = (active.get(sid) || 1) - 1;
    if (count <= 0) active.delete(sid); else active.set(sid, count);
  }

  // Reported to the client so a refusal is diagnosable without exposing URLs.
  function failureReason(status, headers) {
    if (status === 426) return 'CDN refused the request with HTTP 426 (upgrade required); this usually means the source blocks non-browser clients';
    if (status === 403) return 'CDN refused the request with HTTP 403 (forbidden); the link may have expired or be IP-locked';
    if (status === 401) return 'CDN refused the request with HTTP 401 (unauthorized); the link may have expired';
    if (status === 404) return 'CDN returned HTTP 404; the link may have expired';
    const server = headers?.get?.('server');
    return `CDN returned HTTP ${status}${server ? ` (${String(server).slice(0, 40)})` : ''}`;
  }

  async function readBounded(body, limit) {
    const chunks = [];
    let size = 0;
    for await (const chunk of Readable.fromWeb(body)) {
      size += chunk.length;
      if (size > limit) throw Error('Playlist is too large');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  async function relay(req, res, entry, sid) {
    if (total >= global) return {status: 429, error: 'Too many simultaneous streams; close another tab'};
    if ((active.get(sid) || 0) >= perSession) return {status: 429, error: 'Too many simultaneous streams for this session'};

    const headers = {'accept-encoding': 'identity'};
    if (entry.userAgent) headers['user-agent'] = entry.userAgent;
    if (entry.referer) headers.referer = entry.referer;
    if (entry.origin) headers.origin = entry.origin;
    const range = typeof req.headers.range === 'string' && RANGE.test(req.headers.range) ? req.headers.range : null;
    if (range) headers.range = range;
    if (range && typeof req.headers['if-range'] === 'string' && req.headers['if-range'].length <= 512) headers['if-range'] = req.headers['if-range'];

    const controller = new AbortController();
    let released = false;
    const finish = () => {
      if (released) return;
      released = true;
      clearTimeout(timeout);
      release(sid);
    };
    // A client that closes the tab must not leave the upstream request running.
    const onClose = () => { controller.abort(); };
    res.once('close', onClose);

    total++;
    active.set(sid, (active.get(sid) || 0) + 1);
    const timeout = setTimeout(() => controller.abort(), 30000);

    let upstream;
    try {
      upstream = await openMedia(entry, headers, controller.signal, req.method === 'HEAD');
      clearTimeout(timeout);
    } catch (err) {
      res.removeListener('close', onClose);
      finish();
      onError(err);
      return {status: 502, error: controller.signal.aborted ? 'Media request timed out' : 'Could not reach the media host'};
    }

    const {response} = upstream;
    if (!response || ![200, 206, 416].includes(response.status)) {
      await response?.body?.cancel().catch(() => {});
      res.removeListener('close', onClose);
      finish();
      return {status: 502, error: failureReason(response?.status, response?.headers)};
    }

    const encoding = (response.headers.get('content-encoding') || 'identity').toLowerCase();
    if (encoding !== 'identity') {
      await response.body?.cancel().catch(() => {});
      res.removeListener('close', onClose);
      finish();
      return {status: 502, error: 'The media host returned compressed content, which cannot be relayed'};
    }

    // A playlist must be rewritten before it reaches the browser, otherwise its
    // relative references would bypass Troy and the provider headers entirely.
    const type = response.headers.get('content-type') || '';
    if (entry.format === 'hls' || PLAYLIST.test(type)) {
      let text;
      try {
        text = await readBounded(response.body, MAX_PLAYLIST);
        const rewriter = createPlaylistRewriter({
          safeUrl,
          toUrl: (absolute, kind) => createHandle({
            url: absolute.href,
            referer: entry.referer,
            origin: entry.origin,
            userAgent: entry.userAgent,
            format: kind === 'playlist' ? 'hls' : null,
          }, sid),
        });
        text = rewriter.rewrite(text, upstream.url || entry.url).text;
      } catch (err) {
        onError(err);
        res.removeListener('close', onClose);
        finish();
        return {status: 502, error: 'This playlist uses features Troy cannot relay safely'};
      }
      res.writeHead(200, {'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store'});
      res.end(text);
      res.removeListener('close', onClose);
      finish();
      return {status: 200};
    }

    const out = {'Cache-Control': 'no-store'};
    for (const name of SAFE_RESPONSE_HEADERS) {
      const value = response.headers.get(name);
      if (value) out[name] = value;
    }
    // Some CDNs omit these on a range response; derive them so seeking works.
    if (response.status === 206 || out.acceptRanges !== undefined) out['Accept-Ranges'] = 'bytes';
    if (!out['content-type'] || /^text\/html|^application\/json/i.test(out['content-type'])) {
      await response.body?.cancel().catch(() => {});
      res.removeListener('close', onClose);
      finish();
      return {status: 502, error: 'The media host returned a web page instead of video'};
    }

    res.writeHead(response.status, out);
    if (req.method === 'HEAD' || !response.body) {
      await response.body?.cancel().catch(() => {});
      res.end();
      res.removeListener('close', onClose);
      finish();
      return {status: response.status};
    }

    const stream = Readable.fromWeb(response.body);
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    res.on('finish', () => { res.removeListener('close', onClose); finish(); });
    stream.pipe(res);
    return {status: response.status, streamed: true};
  }

  return {
    relay,
    get active() { return total; },
  };
}

module.exports = {createMediaProxy};
