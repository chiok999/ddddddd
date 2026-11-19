# The interface

Troy ships two front ends and serves both from the same process:

| path | what it is | files |
|---|---|---|
| `/` | **ReelBox** — the app shell (React, TanStack Router) | `app/dist/public/` |
| `/classic/` | the original hand-written player | `public/` |

Both talk to the same API on the same port. Nothing about the transcoder, the
providers, the relay or the login changed when ReelBox became the default.

## Why the shell is a committed build

The panel runs `node server.js` and nothing else: no build step, no second
process, and one assigned `PORT`. So the app is built in `reelbox-src/` and the
output is committed to `app/dist/public/`. `npm start` finds it already there.

Rebuilding is only needed when `reelbox-src/` changes:

```bash
cd ../reelbox-src
npm install
npm run build          # builds and copies into solo-cinema/app/dist/public
```

`npm run build` there fails loudly if the shell is missing, and the copy replaces
the previous build rather than merging into it, so a stale chunk cannot survive.

## What the shell is allowed to do

`server.js` sends one Content-Security-Policy for every response. The app needed
three additions, each for a specific reason:

- **`script-src` hashes.** The built shell carries two inline scripts (a
  scroll-restoration preamble and the hydration payload). They are allowed by
  SHA-256 hash, read from the committed shell at startup — not by
  `'unsafe-inline'`, which would also allow an injected one.
- **`style-src-attr 'unsafe-inline'`.** The seek bar sets one custom property on
  an element. `<style>` blocks are still refused.
- **`fonts.googleapis.com` / `fonts.gstatic.com`.** The design uses Manrope and
  Sora. If that is unwanted, drop the two links in
  `reelbox-src/src/routes/__root.tsx` and remove the hosts from the policy.

`img-src` and `connect-src` are unchanged in spirit: artwork is proxied through
`wsrv.nl`, whose hostname allowlist lives in `reelbox-src/src/lib/art.ts`.

A rebuild changes the inline-script hashes. They are re-read on the next start, so
restart the server after deploying a new build — otherwise the browser blocks
hydration and the page renders but does not run.

## Routing

`server.js` sends the shell for exactly these paths and 404s everything else, so
a typo still says 404 instead of quietly rendering the home screen:

```
/  /browse  /ranking  /me  /title/<id>  /watch/<id>
```

## Playback

The shell does not re-implement playback. `reelbox-src/src/lib/playback.ts` ports
the ladder the classic player proved in the field, and the reasoning is in that
file's header: wait instead of restarting on a missing segment, let the server
decide `canPlay`, report position once a second, borrow the playback rate on a
thin buffer, retry the same position before failing over, and restart the
conversion when a seek goes past what has been converted.

`reelbox-src/tools/engine-check.mjs` tests those eight behaviours against a
stand-in hls.js, and each case was mutation-checked: reintroducing the original
bug makes exactly that test fail.

## Tests

```bash
npm test          # 174 tests, including 4 for the shell and the static layer
```

`test-shell.js` covers the split: `/` is the shell, `/classic/` is the old UI, a
typo is a 404, nested bundle paths are served, traversal is refused, and every
inline script in the shell is hash-covered.

## Going back

Nothing to rebuild: the classic UI was never removed. Point yourself at
`/classic/`. To make it the default again, swap the `APP_ROUTES` block in
`server.js` for the `staticFiles` lookup that precedes it.
