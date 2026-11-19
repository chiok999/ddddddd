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

const { statfsSync } = require('node:fs');

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

/**
 * How far ahead of playback the encoder may run, in seconds.
 *
 * Sized from free disk rather than a constant: "always ahead" that fills the
 * volume is not ahead of anything. Both rungs together write roughly 282 KB/s,
 * so this is minutes of runway rather than a guess. Bounded so a small tmpfs
 * still gets a usable window and a large disk does not convert a whole film
 * nobody is going to watch to the end.
 */
function leadCapSeconds() {
  // An explicit setting wins: a tiny tmpfs or a shared volume needs a bound the
  // free-space figure cannot know about.
  if (process.env.CINEMA_LEAD_CAP_SECONDS !== undefined && process.env.CINEMA_LEAD_CAP_SECONDS !== '') {
    return number('CINEMA_LEAD_CAP_SECONDS', 600, { min: 30, max: 900, integer: true });
  }
  const fallback = 600;
  try {
    const stat = statfsSync(require('node:os').tmpdir());
    const free = Number(stat.bavail) * Number(stat.bsize);
    if (!Number.isFinite(free) || free <= 0) return fallback;
    return Math.max(30, Math.min(900, Math.floor((free * 0.6) / (282 * 1000))));
  } catch {
    return fallback;
  }
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
  leadCapSeconds,
  ladder,
  idleMs,
  startupMs,
  flag,
  ffmpegPath: () => process.env.CINEMA_FFMPEG || '',
  encoder: () => process.env.CINEMA_ENCODER || '',
  tmpdirOverride: () => process.env.CINEMA_TMPDIR || '',
  password: () => process.env.CINEMA_PASSWORD || '',
  port: () => process.env.PORT || '',
  routeMemory: () => flag('CINEMA_ROUTE_MEMORY', true),
  /**
   * Which address family outbound source traffic may use.
   * 'auto' keeps both, because a dual-stack host works either way and an
   * IPv6-only network must not be broken. Only an explicit setting narrows it.
   */
  ipv4Mode: () => {
    const raw = String(process.env.CINEMA_IPV4 || 'auto').toLowerCase();
    if (['1', 'true', 'yes', 'ipv4'].includes(raw)) return 'ipv4';
    if (['0', 'false', 'no', 'ipv6', 'off'].includes(raw)) return 'ipv6';
    return 'auto';
  },
  // The client a browser presents when it plays a video. A default here rather
  // than inline, because an operator may need to change it per provider.
  playerUserAgent: () =>
    process.env.CINEMA_PLAYER_UA ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
};
