'use strict';
/**
 * Caption retiming for a converted window.
 *
 * Provider captions are authored against the full timeline: a cue that says
 * 31:12 means 31:12 into the film. A converted window does not start there —
 * `-ss` is an input seek, so the window's own PTS begins near zero and the player
 * reports window-relative time. Nothing reconciled the two:
 *
 *   - inside a window, every cue fired up to `offset` seconds early or late, and
 *     cues already behind the window fired immediately on load;
 *   - after a seek that restarted the conversion the window reset to zero while
 *     the cues stayed absolute, so subtitles vanished until the window caught up.
 *
 * The shift is done here, on read, rather than in the browser: the stored text
 * stays raw so one download serves every window, and the client cannot race the
 * track load. It also cannot work at all on the native-HLS path, where the
 * browser owns the text track.
 *
 * ASSUMPTION: all four provider endpoints return full-timeline captions. A source
 * that ever returned window-relative cues would be shifted twice. This is worth
 * re-checking if a new provider is added.
 */

// VTT allows both forms: hours are optional, and the separator may be a dot or a
// comma (the spec permits the comma so that SRT-derived files pass through).
const LONG = /^(\d{1,3}):(\d{2}):(\d{2})[.,](\d{3})$/;
const SHORT = /^(\d{2}):(\d{2})[.,](\d{3})$/;

/** Seconds from a timestamp, or null if it is not one. */
function parse(value) {
  const text = String(value).trim();
  const long = LONG.exec(text);
  if (long) return Number(long[1]) * 3600 + Number(long[2]) * 60 + Number(long[3]) + Number(long[4]) / 1000;
  const short = SHORT.exec(text);
  if (short) return Number(short[1]) * 60 + Number(short[2]) + Number(short[3]) / 1000;
  return null;
}

/**
 * A VTT timestamp. Always the long form: a cue at 01:02.500 and one at
 * 00:01:02.500 are the same instant, but mixing the two forms in one file is
 * needless variety for a parser to handle.
 */
function format(seconds) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const pad = (n, width) => String(n).padStart(width, '0');
  return (
    `${pad(Math.floor(ms / 3600000), 2)}:` +
    `${pad(Math.floor((ms % 3600000) / 60000), 2)}:` +
    `${pad(Math.floor((ms % 60000) / 1000), 2)}.${pad(ms % 1000, 3)}`
  );
}

/**
 * Moves every cue back by `from` seconds, dropping cues that ended before it.
 *
 * `from` of 0 (or anything not positive) returns the input untouched, byte for
 * byte — that path is the common case and must not be re-serialised.
 */
function shift(text, from) {
  if (!(from > 0)) return text;
  const lines = String(text).split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // The timestamp map pins cues to the source stream's PTS. The re-muxed window
    // has its own, so a map carried over from the original would actively
    // misalign every cue it was meant to anchor.
    if (/^X-TIMESTAMP-MAP/i.test(line)) continue;
    if (!line.includes('-->')) {
      out.push(line);
      continue;
    }
    const [rawStart, rawEnd] = line.split('-->');
    const endToken = (rawEnd || '').trim().split(/\s+/)[0];
    const start = parse(rawStart);
    const end = parse(endToken);
    if (start === null || end === null) {
      out.push(line); // not a timing line after all; leave it alone
      continue;
    }
    if (end <= from) {
      // Entirely behind the window. A cue can carry an identifier line above it
      // (a bare number from an SRT conversion, or a name), and dropping only the
      // timing and payload would leave that identifier orphaned -- which parses as
      // a one-line cue with no timing and is rendered as stray text by some
      // players. Remove it too when the line directly above is not blank.
      if (out.length && out[out.length - 1].trim() !== '' && !out[out.length - 1].includes('-->')) {
        // Only if that line is part of this cue rather than prose from the one
        // before it: a cue identifier is always preceded by a blank line.
        if (out.length < 2 || out[out.length - 2].trim() === '') out.pop();
      }
      i++;
      while (i < lines.length && lines[i].trim() !== '') i++;
      continue;
    }
    // A cue straddling the seek point starts at the top of the window, which is
    // what a viewer expects to see on the first frame.
    const tail = (rawEnd || '').trim().slice(endToken.length); // cue settings, e.g. "align:start"
    out.push(`${format(Math.max(0, start - from))} --> ${format(Math.max(0.001, end - from))}${tail}`);
  }
  return out.join('\n');
}

module.exports = { shift, parse, format };
