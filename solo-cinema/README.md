# Solo Cinema

A separate, small Node.js streaming application. It proxies **your own authorized HTTPS HLS or direct video URLs** without downloading entire videos to disk. The watchlist and playback position are stored in the browser; clearing browser data removes them. The watchlist stores stream URLs in browser storage, so do not use shared devices or paste credentials into URLs.

**Current scope and limits:** Search uses MovieBox and KissKh. MovieBox, VaPlayer and VidSrc stream adapters are queried independently and report failures; after a fatal playback error the player tries the remaining returned streams for that selected title. The latter two require IMDb and TMDB IDs respectively, which are not always supplied by MovieBox or found by the exact-match Cinemeta lookup. TVMaze episode lists use an exact IMDb lookup; manual episode numbers remain available. KissKh results include its episode list, streaming and optional English subtitles. KissKh token JavaScript is downloaded only from the fixed KissKh origin and evaluated in a resource-limited QuickJS WebAssembly runtime without Node APIs or host callbacks; this reduces exposure compared with the bot’s Node VM, but does not guarantee a malicious or changed provider script is harmless. Episode numbering follows KissKh and is shown as season 1. The QuickJS token execution can briefly block the Node event loop. The KissKh integration has only been exercised with offline fixtures, not the live service. Torrent providers from the bot are not supported because they are not direct browser streams. This does not use the bot downloader, which has an open SSRF issue. HLS quality, audio and subtitle choices depend on the source offering tracks and on browser/player support; direct files have one quality.

## Run

Requires Node.js 22.13+.

```sh
cd solo-cinema
npm ci
CINEMA_PASSWORD='a-long-unique-password' PORT=3000 npm start
```

On Botkeep, set `CINEMA_PASSWORD` privately in Environment and let the host supply `PORT`. Use Node.js 22.13 or later and HTTPS. If the GitHub integration clones the **entire repository**, do not use the root bot startup command: configure its working directory as `solo-cinema`, or (if the panel supports shell startup commands) use `cd solo-cinema && npm ci --omit=dev && npm start`. If the panel supports a project root, set it to `solo-cinema` and use `npm ci --omit=dev` as the install command and `npm start` as the startup command. Panel behavior has not been verified; check the startup log and do not assume GitHub automatically deploys the subfolder. The password must be at least 12 characters. Use HTTPS; HTTP does not protect the password or streams in transit. Do not expose this service on an untrusted network without HTTPS. A restart signs you out and invalidates stream links, but your browser watchlist remains. The public HTTPS proxy refuses private and reserved addresses on every connection and redirect; DNS is checked on connection. Provider integration requires a separate security review and safe handling for every provider-controlled request.

There is no disk media cache or transcoding. Browser support, source CORS-independent proxying, bandwidth, DRM and format compatibility still limit playback. The server is a private tool, not hardened for multiuser or high-traffic use. The offline suite includes mocked HTTP and simulated-DOM playback fallback, not a real browser. All provider adapters, token sandbox, subtitles, fallback and catalog lookups were tested with offline fixtures only; live provider access, playback and Botkeep deployment have not been verified. Some providers require particular headers or DRM that this player does not support.

## Verify after deploying

1. Open the panel’s HTTPS address and sign in. Confirm the startup log shows `Solo Cinema is listening`.
2. Search an authorized title, select an episode, choose a stream and check playback, seeking, available quality/audio/subtitles and fallback. Confirm a KissKh title separately if desired.
3. Refresh to check the browser-local watchlist and playback position. Check the console if a provider fails. Providers can change or block the host; fixture tests cannot establish live availability.
4. This service uses bandwidth while proxying streams; it has no disk video cache. The 2 GB plan may still be constrained by memory, network and provider limits.
