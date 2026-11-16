'use strict';

const fs = require('node:fs');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);

/** Add a selectable subtitle track without re-encoding the video or audio. */
async function muxSubtitle({ ffmpeg, input, subtitle, output, language = 'eng' }) {
  if (!ffmpeg) throw new Error('ffmpeg is unavailable');
  if (!input || !subtitle || !output || input === output) throw new Error('invalid subtitle mux paths');
  const tag = /^[a-z]{3}$/i.test(language) ? language.toLowerCase() : 'eng';
  try {
    await run(ffmpeg, [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
      '-i', input, '-i', subtitle,
      '-map', '0:v', '-map', '0:a?', '-map', '1:0', '-map', '0:s?',
      '-map_metadata', '0', '-c', 'copy', '-c:s', 'mov_text',
      '-metadata:s:s:0', `language=${tag}`, '-disposition:s:0', 'default',
      '-f', 'mp4', output,
    ], { timeout: 10 * 60_000, maxBuffer: 256 * 1024, windowsHide: true });
    if (!fs.statSync(output).size) throw new Error('subtitle mux produced an empty file');
    return output;
  } catch (err) {
    try { fs.rmSync(output, { force: true }); } catch { /* best effort */ }
    throw err;
  }
}
module.exports = { muxSubtitle };
