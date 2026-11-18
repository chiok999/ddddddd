'use strict';
/**
 * Every runtime knob that is not derived from a request lives here: one name,
 * one default, one clamp. Nothing downstream reads `process.env` for these, so
 * a bad value is bounded in a single place instead of producing a stream that
 * is quietly wrong halfway through playback.
 *
 * Values are read on access, not at load, so a panel `.env`, `--env-file`, or a
 * test that changes a variable between cases is still honoured.
 */

const RUNG_HEIGHTS = ['240', '360'];

function number(name, fallback, { min, max, integer = false } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  const bounded = Math.min(max, Math.max(min, value));
  return integer ? Math.round(bounded) : bounded;
}

function flag(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

/** Lead time the encoder may run ahead of the viewer, in seconds. */
function leadSeconds() {
  return number('CINEMA_LEAD_SECONDS', 12, { min: 2, max: 30, integer: true });
}

/** Encoder pace as a multiple of real time. Below 1 it can never outrun playback. */
function paceTarget() {
  return number('CINEMA_PACE_TARGET', 0.85, { min: 0.2, max: 1.2 });
}

/** Which ladder rungs to build, in the order they appear in the master playlist. */
function ladder() {
  const raw = process.env.CINEMA_LADDER;
  if (raw === undefined || raw.trim() === '') return RUNG_HEIGHTS.slice();
  const chosen = raw.split(',').map((rung) => rung.trim()).filter((rung) => RUNG_HEIGHTS.includes(rung));
  // An empty or wholly invalid list would build a master playlist with no rungs,
  // which is a broken player rather than a configuration choice.
  return chosen.length ? chosen : RUNG_HEIGHTS.slice();
}

/** How long an idle conversion is kept before it is torn down. */
function idleMs() {
  return number('CINEMA_IDLE_MS', 600000, { min: 10000, max: 3600000, integer: true });
}

/** How long a conversion gets to produce its first playable segments. */
function startupMs() {
  return number('CINEMA_STARTUP_MS', 45000, { min: 5000, max: 600000, integer: true });
}

module.exports = {
  RUNG_HEIGHTS,
  leadSeconds,
  paceTarget,
  ladder,
  idleMs,
  startupMs,
  flag,
  ffmpegPath: () => process.env.CINEMA_FFMPEG || '',
  encoder: () => process.env.CINEMA_ENCODER || '',
  tmpdirOverride: () => process.env.CINEMA_TMPDIR || '',
  password: () => process.env.CINEMA_PASSWORD || '',
  relayUrl: () => process.env.CINEMA_RELAY_URL || '',
  relayKey: () => process.env.CINEMA_RELAY_KEY || '',
  port: () => process.env.PORT || '',
  routeMemory: () => flag('CINEMA_ROUTE_MEMORY', true),
  // The client a browser presents when it plays a video. A default here rather
  // than inline, because an operator may need to change it per provider.
  playerUserAgent: () =>
    process.env.CINEMA_PLAYER_UA ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
};
