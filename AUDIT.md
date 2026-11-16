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

## Open: provider-supplied HLS URLs can access local services

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
- **Disposition:** flagged, not fixed. A safe fix needs to cover redirects, DNS rebinding, playlists, encryption keys, segments, direct media and subprocess downloaders together; a hostname-only check would not close the vulnerability.

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
- **Disposition:** flagged. The suggested npm fix is a major downgrade to WebTorrent 0.7.3; it was not applied without compatibility and security validation.

## Test evidence and limits

- `npm test`: 323 passing test executions across seven suite invocations, zero failures. Some tests and fixture paths overlap across suites; this is not 323 unique production paths.
- `NODE_V8_COVERAGE=/tmp/audit-coverage npm test` and `npx --yes c8 report --temp-directory /tmp/audit-coverage --reporter text --all`: collected coverage, but many tests copy code to temporary fixture paths and the report also includes test scripts; its aggregate is not a reliable complete production-coverage percentage.
- `git diff --check`: passed.
- Static provider chain confirmed for the SSRF finding: provider `search()` → `runProviderSearch()` → `resolve()` → `resolveCandidate()` → `verify()` → `verifyHls()` → `fetch()`.
- This report is incomplete: there is no full per-export call graph, exhaustive dead-code inventory, branch coverage proof, or live end-to-end provider/session result. Do not interpret passing tests as proof of those properties.
