# Troy

A separate, small Node.js streaming application. It proxies **your own authorized HTTPS HLS or direct video URLs** without downloading entire videos to disk. The watchlist and playback position are stored in the browser; clearing browser data removes them. The watchlist stores stream URLs in browser storage, so do not use shared devices or paste credentials into URLs.

**Current scope and limits:** Search uses MovieBox and KissKh. MovieBox, VaPlayer and VidSrc stream adapters are queried independently and report failures; after a fatal playback error the player tries the remaining returned streams for that selected title. The latter two require IMDb and TMDB IDs respectively, which are not always supplied by MovieBox or found by the exact-match Cinemeta lookup. Episode lists use exact IMDb IDs with Cinemeta details and TVMaze fallback; manual episode numbers remain available. Cinemeta details can also supply the TMDB ID missing from its search results. KissKh results include its episode list, streaming and optional English subtitles. KissKh token JavaScript is downloaded only from the fixed KissKh origin and evaluated in a resource-limited QuickJS WebAssembly runtime without Node APIs or host callbacks; this reduces exposure compared with the bot’s Node VM, but does not guarantee a malicious or changed provider script is harmless. Episode numbering follows KissKh and is shown as season 1. The QuickJS token execution can briefly block the Node event loop. The KissKh integration has only been exercised with offline fixtures, not the live service. Torrent providers from the bot are not supported because they are not direct browser streams. This does not use the bot downloader, which has an open SSRF issue. HLS quality, audio and subtitle choices depend on the source offering tracks and on browser/player support; direct files have one quality.

## Run

Requires Node.js 22.13+.

```sh
cd solo-cinema
npm ci
CINEMA_PASSWORD='a-long-unique-password' PORT=3000 npm start
```

On Botkeep, set `CINEMA_PASSWORD` privately in Environment and let the host supply `PORT`. The app loads `.env` from its working directory at startup; variables already exported by the host take precedence over `.env`. Restart after changing it. If the panel writes `.env` elsewhere, set the working directory to the directory containing the file or export the variable directly. Use Node.js 22.13 or later and HTTPS. If the GitHub integration clones the **entire repository**, do not use the root bot startup command: configure its working directory as `solo-cinema`, or (if the panel supports shell startup commands) use `cd solo-cinema && npm ci --omit=dev && npm start`. If the panel supports a project root, set it to `solo-cinema` and use `npm ci --omit=dev` as the install command and `npm start` as the startup command. Panel behavior has not been verified; check the startup log and do not assume GitHub automatically deploys the subfolder. The password must be at least 12 characters. Use HTTPS; HTTP does not protect the password or streams in transit. Do not expose this service on an untrusted network without HTTPS. A restart signs you out and invalidates stream links, but your browser watchlist remains. The public HTTPS proxy refuses private and reserved addresses on every connection and redirect; DNS is checked on connection. Provider integration requires a separate security review and safe handling for every provider-controlled request.

There is no disk media cache or transcoding. Browser support, source CORS-independent proxying, bandwidth, DRM and format compatibility still limit playback. The server is a private tool, not hardened for multiuser or high-traffic use. The offline suite includes mocked HTTP and simulated-DOM playback fallback, not a real browser. All provider adapters, token sandbox, subtitles, fallback and catalog lookups were tested with offline fixtures only; live provider access, playback and Botkeep deployment have not been verified. Some providers require particular headers or DRM that this player does not support.

## Verify after deploying

1. Open the panel’s HTTPS address and sign in. Confirm the startup log shows `Troy is listening`.
2. Search an authorized title, select an episode, choose a stream and check playback, seeking, available quality/audio/subtitles and fallback. Confirm a KissKh title separately if desired.
3. Refresh to check the browser-local watchlist and playback position. Check the console if a provider fails. Providers can change or block the host; fixture tests cannot establish live availability.
4. This service uses bandwidth while proxying streams; it has no disk video cache. The 2 GB plan may still be constrained by memory, network and provider limits.

## Player controls

The server/source menu lists only streams actually returned for the selected title and switches through the same validated streaming proxy. The geographic server names in the design reference are not endpoints and are not fabricated here. Quality, audio and provider subtitles depend on the source; native HLS browsers may control quality themselves. Playback speed and local SRT/VTT subtitle uploads are supported. Uploaded subtitles stay in the browser and are discarded when changing sources or signing out; there is no OpenSubtitles integration. Source switches try to retain position and pause state. These controls have simulated-DOM coverage but have not been verified in a real browser or against every live provider.

## Troy home

The app is branded Troy; the project folder, environment variables and browser storage keys remain unchanged for existing deployments. The home page uses Cinemeta's popular, featured, animation and current-year metadata catalogs (cached in memory for 30 minutes when all requests succeed). “Trending & popular” uses Cinemeta popularity, not a live trending chart. Anime picks are curated search shortcuts; they are not a live anime catalog. A card searches existing providers and requires choosing the intended match; a listing does not guarantee a stream. Poster images load directly in the browser from Cinemeta's image hosts and the reference site's image host for the curated picks; those hosts can see the browser's IP. Provider, artwork and catalog availability varies. No movie files are stored by the home page.

### Movy sources
For MovieBox catalog results with a matched TMDB ID, Troy also tries the user-supplied Movy protocol, using Miami, Boise and the remaining English-server names in order and stopping at the first server with usable URLs. The source picker labels returned streams `movy:<server>`; these names are upstream labels and do not prove geographic hosting. Requests are serialized, results are cached for 10 minutes, and a 429 triggers a local one-minute cooldown (the upstream limit may last longer). This does not account for other clients sharing the same public IP. Movy may be slow, reject requests, change its protocol or return expired links. Playback requests, including rewritten HLS playlists, segments and keys, use the supplied fixed Movy headers through the existing HTTPS/public-address-validated streaming proxy. No video is saved to disk.

Only English-server lookup is implemented; the separate dubbed servers, Berlin alternate-title lookup, subtitle extraction, and Reno's special 900p probe are not implemented. Auto masters use HLS.js quality selection where available. The integration is tested with mocked responses and a Python-generated encryption vector, not against the live provider or a real browser in this environment.
