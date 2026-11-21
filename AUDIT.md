# Audit findings (partial)

This is not an exhaustive audit. The repository contains 161 tracked files and approximately 40,505 lines (including tests and generated lockfile). Not every file, exported symbol, branch, or live integration was inspected or exercised. The static inventory, current suite and reproductions below do not establish that unmentioned code is safe or reachable. No live WhatsApp accounts, panel, torrent swarm, or external media providers were available for testing.

## Fixed: failed socket close can crash the service

- **Location:** `gateway/sessions/manager.js:213-218`; regression `scripts/test-sessions.js:770`.
- **Finding:** stale-socket recovery handled synchronous throws from `sock.end()` but not its rejected promise.
- **Impact:** with strict unhandled-rejection behavior the process exits instead of recovering any account.
- **Reproduce:** `node --test --test-name-pattern='rejected socket end during stale' scripts/test-sessions.js`. The test runs a child with `--unhandled-rejections=strict`, makes the liveness probe fail and the socket's `end()` reject. Before the fix the child exited 1; afterward it exits 0.
- **Change:** attach an asynchronous rejection handler and log the close error, without blocking probes on a hung close.

## Fixed: failed credential save lost on reconnect

- **Location:** `gateway/sessions/manager.js:399-409,452-468`; regression `scripts/test-sessions.js:794,824`.
- **Finding:** a save failure was logged and forgotten, so reconnection reloaded missing or outdated persisted credentials while newer credentials were still in memory.
- **Impact:** a simulated failed save followed by a 515 disconnect marked the linked account `logged_out` despite successful registration in memory.
- **Reproduce:** `node --test --test-name-pattern='failed credential save is retried|credential updates save in order' scripts/test-sessions.js`. Before the fix the first test failed because the account was `logged_out`; after the fix both pass.
- **Change:** serialize saves and retry a failed save before reloading. This only protects a still-running process; a crash or shutdown after a failed write can still lose the unsaved state.

## Fixed: incorrect provider count

- **Location:** `scripts/check-live.js:46`; `lib/movies/engine/core/reliability.js:5-6`.
- **Finding:** the script claimed 12 providers and reliability comments described 14, but the registry currently has 11.
- **Impact:** diagnostics misreport provider inventory.
- **Reproduce:** `node -e "(async()=>{await import('./lib/movies/engine/media/index.js');const r=(await import('./lib/movies/engine/core/registry.js')).default;console.log(r.table().length,r.table().map(p=>p.id))})()"` prints 11.
- **Change:** removed the hard-coded count from the script and corrected the comment.

## Partially mitigated; still open: provider-supplied HLS URLs can access local services

- **Location:** `lib/movies/engine/providers/stream/vaplayer.js:40-44`, `lib/movies/engine/core/resolver.js:194-221,326-333`, `lib/movies/engine/core/verify.js:140-145`; also `lib/movies/engine/media/hls.js:28-34,110-121`.
- **Finding:** a provider-supplied HTTP(S) URL is passed to `fetch` without rejecting loopback/private destinations or pinning DNS, and redirects are followed.
- **Impact:** a malicious or compromised provider can cause requests to services reachable from the bot host; this reproduction proves the request, not a specific data-exfiltration exploit.
- **Reproduce:** run from the repository root:

```sh
node - <<'JS'
const http = require('node:http');
(async () => {
  const server = http.createServer((req, res) => {
    console.log('local server received:', req.url);
    res.end('#EXTM3U\n#EXTINF:10,\nsegment.ts\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const { resolveCandidate } = await import('./lib/movies/engine/core/resolver.js');
    const result = await resolveCandidate({provider:'vaplayer',kind:'hls',title:'fixture',url:`http://127.0.0.1:${server.address().port}/private`});
    console.log('verified:', result.verified);
  } finally { server.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
JS
```

Observed: the local server received `/private` and `verified: true`. The test directly supplies the same candidate shape produced by VaPlayer; it does not compromise that provider.
- **Re-audit:** `node --test scripts/test-hls-security.js` now verifies that HLS verification rejects direct loopback URLs and loopback redirects, and rejected URLs cannot be returned as last-resort unverified links. `safeManifest.js` checks each redirect and uses the existing DNS-pinning lookup through an Undici dispatcher.
- **Still vulnerable:** the native HLS downloader and external downloader paths are not protected. Reproduced by serving a playlist and segment from loopback and calling `downloadHlsNative()` directly: the local server received `/p` and `/segment`. An externally controlled playlist can also direct subsequent segment and key requests; that specific cross-host case has not been reproduced here. Direct file verification/download paths also remain outside this mitigation.
- **Disposition:** partially mitigated, not fixed. Do not treat the verification guard as a complete SSRF fix. A safe fix must cover playlists, segments, keys, redirects, DNS rebinding, direct media and both subprocess downloaders without an unsafe fallback.

## Open: live session database is tracked by Git

- **Location:** `lib/sqlite.js:21-22,40-41`; `.gitignore:14-15`; `database/bot.sqlite`.
- **Finding:** the default database is `database/bot.sqlite`, and that file is tracked; only SQLite WAL/SHM files are ignored.
- **Impact:** running the bot modifies a tracked file containing account auth data and creates a risk of accidentally committing credentials or overwriting runtime state during deployment.
- **Reproduce:** `git ls-files --stage database/bot.sqlite`; the checked-in database has an `auth` table. This checkout's table was empty; no production database was accessed.
- **Disposition:** flagged, not removed. Removing a tracked runtime database without a safe deployment/migration procedure can cause Git checkout or pull to delete the panel's live file.

## Open: optional dependency advisory

- **Location:** `package.json:39-40`; `lib/movies/engine/media/torrent.js:17-39`; `config.js:139`.
- **Finding:** `npm audit` reports four high-severity dependency entries through `webtorrent` → `torrent-discovery` → `bittorrent-tracker` → `ip` (GHSA-2p57-rm9w-gvfp).
- **Impact:** the advisory concerns incorrect public/private IP classification; exploitability in this bot was not established. The optional WebTorrent package was not installed in this sandbox, but may be installed on other hosts.
- **Reproduce:** `npm audit --json`, `npm audit --omit=optional --json`, `npm ls webtorrent --depth=0`. Observed: four high entries in the full lockfile audit, zero when optional dependencies are omitted, and the local optional dependency absent.
- **Re-audit:** `npm pack bittorrent-tracker@11.2.3`, unpack it and search its JavaScript for imports of `ip` and calls to `isPublic`/`isPrivate`. The only `ip` import is `lib/server/parse-udp.js`, which calls `ipLib.toString`; no tracker call to the advisory's classification functions was found. This narrows the observed usage but does not prove the dependency tree is safe.
- **Disposition:** flagged. The suggested npm fix is a major downgrade to WebTorrent 0.7.3; it was not applied without compatibility and security validation.

## Test evidence and limits

- `npm test`: 325 passing test executions across seven suite invocations, zero failures. Some tests and fixture paths overlap across suites; this is not 323 unique production paths.
- `NODE_V8_COVERAGE=/tmp/audit-coverage npm test` and `npx --yes c8 report --temp-directory /tmp/audit-coverage --reporter text --all`: collected coverage, but many tests copy code to temporary fixture paths and the report also includes test scripts; its aggregate is not a reliable complete production-coverage percentage.
- `git diff --check`: passed.
- Static provider chain confirmed for the SSRF finding: provider `search()` → `runProviderSearch()` → `resolve()` → `resolveCandidate()` → `verify()` → `verifyHls()` → `fetch()`.
- This report is incomplete: there is no full per-export call graph, exhaustive dead-code inventory, branch coverage proof, or live end-to-end provider/session result. Do not interpret passing tests as proof of those properties.

## Current re-audit scope

The HLS verification mitigation was tested offline, but the end-to-end SSRF issue, Git-tracked runtime database, and optional dependency advisory remain open. The exhaustive audit originally requested has not been completed. No real production sessions, provider responses or WhatsApp playback were tested.

## Re-audit 2026-11-21 (end-to-end, after PRs #101/#102)

Scope: full test run, syntax pass, dependency audit, static scans, live boot
smoke test. Branch `arena/87018650-ddddddd` at `083c26f`.

- `npm test`: **342 passing, 0 failing** (structure 42, preflight/readiness 59,
  media 88, bugfixes 13, sessions 109, workers 11, storage 20).
- `node --check` on every JS file under commands/gateway/lib/scripts plus
  index.js/config.js: **154/154 clean**.
- Live boot (scratch DB): starts, `GET /health` and `/health/details` answer
  counts-only JSON (no numbers/session data), graceful SIGTERM exit 0, and a
  shutdown `bot.sqlite.backup` is written.
- Static scans: no `eval`/`new Function`, no `shell: true` or shell `exec()`
  (child processes use `execFile`/`spawn`/`fork` with argument arrays), no
  hard-coded credentials outside env lookups, no template-string SQL.
- `npm audit`: 0 vulnerabilities with optional deps omitted; the same 4 high
  entries via optional `webtorrent` → `bittorrent-tracker` → `ip` remain
  (see earlier disposition — still open, unchanged).
- New-code review (recovery strings + mirror, PR #102): mirror URL is never
  logged; recovery/mirror payloads are AES-256-GCM encrypted when a secret is
  configured. Two informational notes: (1) recovery strings are unencrypted
  when `SESSION_RECOVERY_SECRET` is unset — the command and README both warn
  to treat them as passwords; (2) `.sessionid` delivers a login-equivalent
  file inside WhatsApp chat (owner-only, by design).
- Still open from earlier sections, unchanged: Git-tracked
  `database/bot.sqlite`; the optional-dependency advisory; the partially
  mitigated HLS SSRF surface (verification path guarded and tested, native/
  external downloader paths not fully covered).
- Limits: no live WhatsApp account, real Postgres/Mongo server, panel, or
  media provider was exercised; mirror adapters were verified against fake
  drivers, recovery/mirror flows against local fixtures.

## Fix pass 2026-11-21 (only fixes that cannot affect the PR #101/#102 integration)

- **Fixed: Git-tracked runtime database.** `database/bot.sqlite` removed from
  the index (`git rm --cached`; the live file stays on disk) and
  `database/*.sqlite` is now ignored with a comment explaining why. Session/
  auth code untouched. If a deploy ever loses the file, boot restores it from
  `database/bot.sqlite.backup` (PR #101) or the remote mirror (PR #102);
  README's deployment section says so. Verified: full suite green, boot smoke
  green.
- **Fixed (native path): HLS SSRF in the pure-Node downloader.**
  `lib/movies/engine/media/hls.js` now validates every fetched URL —
  playlist, variant, segment, key, and each redirect hop — against the same
  public-address rules used by the verified-manifest path, and fetches through
  the DNS-pinning Undici dispatcher (`publicLookup`), so public hostnames
  cannot resolve to private addresses either. Cross-origin redirects strip
  credential headers. An explicit `allowPrivateHosts` option exists only for
  offline loopback test fixtures; production callers (`download.js`) never
  pass it. Regression: `scripts/test-hls-security.js` (private playlist
  blocked with zero requests; public→private redirect blocked). Still open,
  unchanged: ffmpeg/N_m3u8DL-RE subprocess downloaders cannot be DNS-pinned
  this way and remain reachable only with URLs that already passed the
  guarded resolve/verify stage.
- **Not fixed, deliberately: optional `webtorrent` advisory.** The installed
  `ip` is already 2.0.1 and the advisory has no patched release; the only
  npm-suggested remedy is a major downgrade/removal of the optional torrent
  feature. Verified again that `bittorrent-tracker` never calls the
  advisory's `isPublic`/`isPrivate` functions (its only `ip` use is address
  formatting), so the flagged code path is unreachable here. Removing a
  working feature to silence an unreachable advisory would be a regression,
  not a fix.
