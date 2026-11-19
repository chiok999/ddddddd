# The interface

Troy ships one front end:

| path | what it is | files |
|---|---|---|
| `/` | **ReelBox** — the app shell (React, TanStack Router) | `app/dist/public/` |

It talks to the same API on the same port. Nothing about the transcoder, the
providers, the relay or the login changed when ReelBox replaced the original
hand-written player, and that player is now deleted rather than kept behind a
URL.

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
the ladder the original player proved in the field, and the reasoning is in that
file's header: wait instead of restarting on a missing segment, let the server
decide `canPlay`, report position once a second, borrow the playback rate on a
thin buffer, retry the same position before failing over, and restart the
conversion when a seek goes past what has been converted.

`reelbox-src/tools/engine-check.mjs` tests those behaviours against a stand-in
hls.js, and each case was mutation-checked: reintroducing the original bug makes
exactly that test fail.

Subtitles are per stream, not per title. Troy's caption URL is session-scoped
and expires, so it is fetched on every playback and on every failover, and a
provider that offers no caption leaves the button disabled with the reason
shown rather than presenting a track that would never load.

The frame follows the picture. A 4:3 feature or a 4:5 clip would otherwise be
boxed inside 16:9 with black bars on two sides, so the shape comes from the
decoded video and the viewer can pin a shape instead. `tools/frame-check.mjs`
pins that, including that a pinned shape applies before metadata arrives.

## Tests

```bash
npm test          # 127 tests, including 4 for the shell and the static layer
```

`test-shell.js` covers routing: `/` is the shell, a typo is a 404, the deleted
player's files are gone from the server rather than merely unlinked, nested
bundle paths are served, traversal is refused, and every inline script in the
shell is hash-covered.

## Going back

There is no old UI to go back to. Recovering it means reverting the commit that
deleted `public/`, which also restores the `staticFiles` lookup in `server.js`
that the `/classic/` branch depended on.
