# Troy: how it works, and what it will not do

One document. It replaces a set of audit notes that accumulated over many
changes, several of which had been corrected in place so many times that their
"current policy" paragraph contradicted both their own body and the code.

Every claim here was checked against the source while writing it. Where a number
is stated it is read from `config.js` or measured, not remembered.

## What it is

A single Node process that:

1. signs in with a password, one session per browser, 24-hour cookie
2. finds a title through several providers
3. resolves that title to one or more stream URLs
4. **converts the stream on demand** with FFmpeg into HLS, because the browser
   cannot play most provider sources directly
5. serves the pieces to a React app that lives in `app/dist/public/`

The relay (`troy-relay-server.js`) is a separate, optional process on a
different host: some CDNs refuse the server's address and accept a residential
one. It fetches bytes and nothing else. See `RELAY-PERF.md`.

## The conversion, which is the part that surprises people

It is **not** a download, and it is **not** a completed file.

- FFmpeg reads the source through a pipe as fast as it can encode.
- Output is an **EVENT playlist**: segments accumulate and are never deleted.
- The encoder is paused when it gets too far ahead of you, and resumed when you
  catch up. `leadSeconds` is 12, and the cap is derived from free disk (30 s to
  15 min, 900 s by default), because "always ahead" that fills the volume is not
  ahead of anything.
- **Seeking past what has been converted starts a new conversion at that
  timestamp.** It does not fail and it does not wait. This is the single most
  frequently mis-documented behaviour here: three separate notes in this folder
  claimed seeking was limited to the converted portion, long after the code
  gained the ability to restart.
- A new conversion means a new FFmpeg process and a new set of segment files.
  The old ones are removed.

### Limits, as they actually are

| limit | value | where |
|---|---|---|
| concurrent jobs | 1, server-wide | `transcode.js` returns 409 to a second session |
| rungs | 240p and 360p | `config.ladder()` |
| rate control | CRF 30 (240p) / CRF 27 (360p), ceiling 250k / 500k | `transcode.js` |
| codec profile | main @3.1 (240p) / high @3.1 (360p) | declared in the master playlist |
| segment length | 4 s | `HLSTIME` |
| startup deadline | 45 s | `config.startupMs()` |
| idle expiry | 10 min | `config.idleMs()` |
| output size cap | **none** | removed by request; the disk can fill |
| free-space reserve | **none** | removed by request |

There is no output-size cap and no free-space reserve. The filesystem can fill
and that is a deliberate, accepted risk. Two claims in the notes this file
replaces — a 128 MiB cap and a 90-second inactivity timeout — describe code that
no longer exists.

### What it cannot convert

- **HLS-only sources** (`.m3u8` upstream): refused with a reason rather than
  attempted, because re-wrapping HLS needs a different pipeline.
- **MP4 with the index at the end** (`moov` after `mdat`): a pipe cannot seek, so
  it is rejected up front instead of being found broken 40 seconds in.
- **Anything needing FFmpeg's own network or file protocols**: only `pipe` is
  whitelisted.
- **Compressed or HTML responses**: only uncompressed direct MP4.

Only the first audio track is encoded. A smaller input is not upscaled; no detail
is invented.

### Safety boundaries around FFmpeg

FFmpeg is given stdin, an input format fixed to MOV/MP4, a protocol whitelist of
`pipe`, and two fixed output paths. No shell, no URL, no user-derived argument,
no arbitrary path. The binary itself is not sandboxed: run it unprivileged, in a
container, and keep it updated. That is the honest boundary — the argument
surface is closed, the native decoders are not.

## Providers

`moviebox`, `kisskh`, `cinemeta` (metadata), `movy`, and `7movies` via VidLink.

Providers fail, and they fail differently. The rules the code follows:

- A provider that returns **426** is refusing the connection, not the file. It is
  retried at offset 0 only; retrying mid-file would leave a hole.
- **427/429** are rate limits: the request was valid and arrived too soon.
- **401/403** are retried **once** through a refresh, when the resolver can mint
  a new link. Not more, because a stale link that stays stale is a wrong title,
  not a transient fault.
- A **502** from the relay means the relay could not reach the CDN, which is not
  the same as the CDN refusing you. The router remembers which route worked and
  prefers it for ten minutes.

Cross-origin redirects strip credentials; same-origin ones keep them.

## What has not been verified

Stated plainly, because earlier notes drifted into implying otherwise:

- **No real playback has been confirmed end-to-end in a headless environment.**
  There is no browser here, and provider CDNs are not reachable from the build
  sandbox. Playback logic is covered by engine tests against a stand-in hls.js,
  and the encoder by tests against real FFmpeg. Neither proves a specific title
  plays on a specific phone today.
- Provider availability is not permanent, and a working metadata lookup is not
  proof that a stream resolves or survives URL expiry.
- Subtitle positioning for native fullscreen, picture-in-picture, vertical and
  non-WebVTT captions is approximate.
- Caption retiming assumes every provider times its captions against the whole
  film. If one ever returned window-relative cues they would be shifted twice.
- Concurrency, memory and disk behaviour under load on Botkeep are unknown.

## Testing

```bash
npm test     # 141 tests
```

They fall into four groups: the HTTP surface (auth, origin checks, session
binding, private-address rejection), the converter (real FFmpeg, event
playlists, restart-on-seek, disk-full, cancellation), the providers (fixtures and
recorded response shapes), and the relay (signatures, redirects, timeouts,
pooled-socket retry).

The suite deliberately includes tests that **fail** if a protection is removed —
`without the guard that same rejection is fatal, so the test above can fail` is
one. A test that cannot fail is documentation, not a test.

## Where the interface is documented

`UI.md` covers routing, the CSP hash requirement and how the app bundle is
published. This file covers the engine.
