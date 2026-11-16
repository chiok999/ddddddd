# Solo Cinema

A separate, small Node.js streaming application. It proxies **your own authorized HTTPS HLS or direct video URLs** without downloading entire videos to disk. The watchlist and playback position are stored in the browser; clearing browser data removes them. The watchlist stores stream URLs in browser storage, so do not use shared devices or paste credentials into URLs.

**Current scope and limits:** Search uses MovieBox. MovieBox, VaPlayer and VidSrc stream adapters are queried independently and report failures; playback is not automatically retried if a selected stream fails. The latter two require IMDb and TMDB IDs respectively, which are not always supplied by MovieBox or found by the exact-match Cinemeta lookup. TVMaze episode lists use an exact IMDb lookup; manual episode numbers remain available. KissKh (`.kk`) is not integrated: its existing token generation executes a remotely supplied script, so it must be redesigned and tested before adding it to this publicly accessible app. Torrent providers from the bot are not supported because they are not direct browser streams. This does not use the bot downloader, which has an open SSRF issue. HLS quality, audio and subtitle choices depend on the source offering tracks and on browser/player support; direct files have one quality.

## Run

Requires Node.js 22.13+.

```sh
cd solo-cinema
npm ci
CINEMA_PASSWORD='a-long-unique-password' PORT=3000 npm start
```

On Botkeep, deploy **this folder's contents as the project root**, set `CINEMA_PASSWORD` privately in Environment, use `npm start` for startup, and let the host supply `PORT`. The password must be at least 12 characters. Use HTTPS; HTTP does not protect the password or streams in transit. Do not expose this service on an untrusted network without HTTPS. A restart signs you out and invalidates stream links, but your browser watchlist remains. The public HTTPS proxy refuses private and reserved addresses on every connection and redirect; DNS is checked on connection. Provider integration requires a separate security review and safe handling for every provider-controlled request.

There is no disk media cache or transcoding. Browser support, source CORS-independent proxying, bandwidth, DRM and format compatibility still limit playback. The server is a private tool, not hardened for multiuser or high-traffic use. All provider adapters, fallback and catalog lookups were tested with offline fixtures only; live provider access, playback and Botkeep deployment have not been verified. Some providers require particular headers or DRM that this player does not support.
