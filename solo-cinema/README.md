# Solo Cinema

A separate, small Node.js streaming application. It proxies **your own authorized HTTPS HLS or direct video URLs** without downloading entire videos to disk. The watchlist and playback position are stored in the browser; clearing browser data removes them. The watchlist stores stream URLs in browser storage, so do not use shared devices or paste credentials into URLs.

**Important: this app has a standalone MovieBox catalog and stream adapter, but the bot’s other providers are not integrated.** It does not use the bot downloader because that code has an open SSRF issue. This app is not the requested complete provider-powered cinema: it has no season/episode catalog, cross-provider fallback or guaranteed subtitles. Search results may require manually entering the season and episode number. HLS quality options depend on the source offering a multivariant playlist; direct files have one quality. HLS subtitle tracks depend on the player and source.

## Run

Requires Node.js 22.13+.

```sh
cd solo-cinema
npm ci
CINEMA_PASSWORD='a-long-unique-password' PORT=3000 npm start
```

On Botkeep, deploy **this folder's contents as the project root**, set `CINEMA_PASSWORD` privately in Environment, use `npm start` for startup, and let the host supply `PORT`. The password must be at least 12 characters. Use HTTPS; HTTP does not protect the password or streams in transit. Do not expose this service on an untrusted network without HTTPS. A restart signs you out and invalidates stream links, but your browser watchlist remains. The public HTTPS proxy refuses private and reserved addresses on every connection and redirect; DNS is checked on connection. Provider integration requires a separate security review and safe handling for every provider-controlled request.

There is no disk media cache or transcoding. Browser support, source CORS-independent proxying, bandwidth, DRM and format compatibility still limit playback. The server is a private tool, not hardened for multiuser or high-traffic use. MovieBox was tested with offline fixtures only; live provider access, playback and Botkeep deployment have not been verified. Some providers require particular headers or DRM that this player does not support.
