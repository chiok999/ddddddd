'use strict';
// Playlist rewriting shared by the FFmpeg HLS relay and the browser media relay.
//
// The only reason a playlist is rewritten is so that every reference the client
// follows comes back through Troy, where URL validation, DNS pinning and the
// provider headers already apply. Anything this parser does not understand is
// rejected rather than passed through, because a passthrough would let upstream
// data steer the client or FFmpeg at an unvalidated URL.
//
// `toUrl(absoluteUrl, kind)` must return the URL to substitute. It receives
// kind = 'playlist' | 'media' | 'key' and is responsible for its own validation
// and scoping.
function createPlaylistRewriter({toUrl, safeUrl}) {
  function expand(value, vars) {
    const result = value.replace(/\{\$([A-Za-z0-9_-]+)\}/g, (_, name) => {
      if (!Object.hasOwn(vars, name)) throw Error('Undefined HLS variable');
      return vars[name];
    });
    if (/[\r\n"{}]/.test(result)) throw Error('Invalid HLS variable or reference');
    return result;
  }

  function attributes(text) {
    const out = Object.create(null);
    let pos = 0;
    while (pos < text.length) {
      const m = /^\s*([A-Z0-9-]+)\s*=\s*"([^"\r\n]*)"\s*(,|$)/.exec(text.slice(pos));
      if (!m || Object.hasOwn(out, m[1])) throw Error('Invalid HLS variable definition');
      out[m[1]] = m[2];
      pos += m[0].length;
      if (m[3] && pos === text.length) throw Error('Invalid HLS variable definition');
    }
    return out;
  }

  // Returns {text, duration}. `duration` is set only for a completed VOD
  // playlist whose segment durations add up.
  function rewrite(text, base, parentVars = {}) {
    text = text.replace(/^\uFEFF/, '');
    if (!/^#EXTM3U(?:\r?\n|$)/.test(text)) throw Error('Invalid HLS playlist');
    let variant = false, total = 0, vod = false;
    const vars = Object.create(null);

    const ref = (raw, kind, scope) => {
      const expanded = expand(raw, vars);
      if (!expanded) throw Error('Unsupported HLS reference');
      const absolute = new URL(expanded, base);
      safeUrl(absolute);
      return toUrl(absolute, kind, scope);
    };

    const lines = text.split(/\r?\n/).map(line => {
      if (line.startsWith('#EXT-X-DEFINE:')) {
        const attrs = attributes(line.slice('#EXT-X-DEFINE:'.length)), keys = Object.keys(attrs);
        let name, value;
        if (keys.length === 2 && Object.hasOwn(attrs, 'NAME') && Object.hasOwn(attrs, 'VALUE')) { name = attrs.NAME; value = expand(attrs.VALUE, vars); }
        else if (keys.length === 1 && Object.hasOwn(attrs, 'IMPORT')) {
          name = attrs.IMPORT;
          if (!Object.hasOwn(parentVars, name)) throw Error('Undefined imported HLS variable');
          value = parentVars[name];
        } else if (keys.length === 1 && Object.hasOwn(attrs, 'QUERYPARAM')) {
          name = attrs.QUERYPARAM;
          const query = new URL(base).search.slice(1).split('&').filter(Boolean).map(pair => {
            const n = pair.indexOf('=');
            return [n < 0 ? pair : pair.slice(0, n), n < 0 ? '' : pair.slice(n + 1)];
          });
          const matches = query.filter(([key]) => { try { return decodeURIComponent(key.replace(/\+/g, ' ')) === name; } catch { return false; } });
          if (matches.length !== 1) throw Error('Missing or ambiguous HLS query variable');
          value = expand(matches[0][1], vars);
        } else throw Error('Invalid HLS variable definition');
        if (!/^[A-Za-z0-9_-]+$/.test(name) || Object.hasOwn(vars, name)) throw Error('Invalid or duplicate HLS variable');
        vars[name] = value;
        return '';
      }
      if (!line || !line.startsWith('#')) {
        if (!line) return line;
        const out = ref(line.trim(), variant ? 'playlist' : 'media', variant ? vars : {});
        variant = false;
        return out;
      }
      if (line.startsWith('#EXTINF:')) {
        const n = Number(line.slice(8).split(',')[0]);
        if (Number.isFinite(n) && n > 0) total += n;
      }
      if (line === '#EXT-X-ENDLIST') vod = true;
      if (line.startsWith('#EXT-X-STREAM-INF:')) {
        if (/URI\s*=|\{\$/i.test(line)) throw Error('Invalid HLS stream reference');
        variant = true;
        return line;
      }
      const match = /^#(EXT-X-(?:KEY|SESSION-KEY|MAP|MEDIA|I-FRAME-STREAM-INF|SESSION-DATA|PART|PRELOAD-HINT|RENDITION-REPORT)):(.*)$/.exec(line);
      if (match) {
        const tag = match[1];
        const kind = ['EXT-X-KEY', 'EXT-X-SESSION-KEY'].includes(tag) ? 'key'
          : ['EXT-X-MEDIA', 'EXT-X-I-FRAME-STREAM-INF', 'EXT-X-RENDITION-REPORT'].includes(tag) ? 'playlist' : 'media';
        let n = 0;
        const expected = (match[2].match(/(?:^|,)\s*URI\s*=/gi) || []).length;
        const replaced = match[2].replace(/(?:^|,)\s*URI\s*=\s*"([^"\r\n]*)"/gi, (whole, url) => {
          n++;
          return (whole.startsWith(',') ? ',' : '') + 'URI="' + ref(url, kind, {}) + '"';
        });
        if (expected !== n || n > 1 || (['EXT-X-MAP', 'EXT-X-I-FRAME-STREAM-INF', 'EXT-X-PART', 'EXT-X-PRELOAD-HINT', 'EXT-X-RENDITION-REPORT'].includes(tag) && n !== 1))
          throw Error('Invalid HLS URI');
        if (/\{\$/.test(replaced)) throw Error('Unsupported HLS variable in attribute');
        return `#${tag}:${replaced}`;
      }
      // Unknown URI-bearing extensions and delta updates must not reach a
      // client or FFmpeg unfiltered.
      if (/URI\s*=|\{\$|^#EXT-X-SKIP:/i.test(line)) throw Error('Unsupported HLS playlist feature');
      return line;
    });

    return {text: lines.join('\n'), duration: vod && total > 0 ? total : null};
  }

  return {rewrite};
}

module.exports = {createPlaylistRewriter};
