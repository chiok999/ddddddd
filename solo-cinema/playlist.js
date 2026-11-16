'use strict';
function rewritePlaylist(text, base, sid, referer, remember) {
  let nextIsPlaylist = false;
  return text.split(/\r?\n/).map(line => {
    const trimmed = line.trim();
    if (!trimmed) return line;
    if (!trimmed.startsWith('#')) {
      const format = nextIsPlaylist ? 'hls' : null; nextIsPlaylist = false;
      return remember(new URL(trimmed, base), sid, referer, format);
    }
    if (/^#EXT-X-STREAM-INF:/i.test(trimmed)) nextIsPlaylist = true;
    // HLS URI attributes cover keys, alternate audio/subtitles, and init maps.
    const playlistAttribute = /^#EXT-X-(?:MEDIA|I-FRAME-STREAM-INF):/i.test(trimmed);
    return line.replace(/URI="([^"\r\n]+)"/gi, (_, uri) => `URI="${remember(new URL(uri, base), sid, referer, playlistAttribute ? 'hls' : null)}"`);
  }).join('\n');
}
module.exports = { rewritePlaylist };
