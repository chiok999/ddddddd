# Troy

A separate, small Node.js streaming application. Playback defaults to **direct relay**: the provider's own bytes are streamed through Troy to the browser, so there is no encoding, no waiting and no temporary disk use, and seeking is native across the whole title. Conversion to a 240p/360p HLS ladder remains as an automatic fallback for sources the relay or the browser cannot handle. Only **authorized HTTPS sources** should be used. The watchlist and playback position are stored in the browser; clearing browser data removes them. The watchlist stores stream URLs in browser storage, so do not use shared devices or paste credentials into URLs.

**Current scope and limits:** Search uses MovieBox, KissKh and Cinemeta metadata. MovieBox, VaPlayer, VidSrc, Movy and 7Movies/VidLink stream adapters are queried independently and report failures; after a fatal playback error the player tries the remaining returned streams for that selected title. The latter two require IMDb and TMDB IDs respectively, which are not always supplied by MovieBox or found by the exact-match Cinemeta lookup. Episode lists use exact IMDb IDs with Cinemeta details and TVMaze fallback; manual episode numbers remain available. Cinemeta details can also supply the TMDB ID missing from its search results. KissKh results include its episode list, streaming and optional English subtitles. KissKh token JavaScript is downloaded only from the fixed KissKh origin and evaluated in a resource-limited QuickJS WebAssembly runtime without Node APIs or host callbacks; this reduces exposure compared with the bot’s Node VM, but does not guarantee a malicious or changed provider script is harmless. Episode numbering follows KissKh and is shown as season 1. The QuickJS token execution can briefly block the Node event loop. The KissKh integration has only been exercised with offline fixtures, not the live service. Torrent providers from the bot are not supported because they are not direct browser streams. This does not use the bot downloader, which has an open SSRF issue. HLS quality, audio and subtitle choices depend on the source offering tracks and on browser/player support; direct files have one quality.

## Playback modes

**1. Direct relay (default).** `/media/<handle>` streams the provider file through the server to the browser. The server adds the provider's `Referer`/`Origin`/`User-Agent`, which a browser cannot add to cross-origin media, and because the response is same-origin there is no CORS problem. Byte ranges pass through unchanged, so the timeline is the real title length and seeking is instant. Playlists are rewritten so their segments and keys come back through Troy too. Memory use per stream is a buffer, not the file; no temporary files are written.

This is the path that fixes a CDN answering `HTTP 426` (or `403`) to the server: that status means the host refused the *request shape*, not that the media is unplayable. Both MovieBox and 7Movies returned 426 to the unadorned server request in production. Because the relay keeps the provider headers and the player domain's own URL, such links play directly, without FFmpeg.

**2. Automatic conversion (fallback).** If the browser cannot decode the relayed source, or the relay is refused, that one source is converted once and then playback moves on. See the conversion section below for its limits and resource cost.

Set `CINEMA_RELAY=0` to disable the relay and require conversion (the previous behaviour). `CINEMA_RELAY_STREAMS` caps simultaneous relayed streams per session (default 6); a global cap of 24 also applies. The relay keeps Troy's URL validation, public-address DNS pinning and redirect checks on every connection, refuses compressed bodies and HTML/JSON masquerading as video, and reports the upstream status without echoing the URL.

**Bandwidth note:** the relay costs server bandwidth equal to what you watch, because the bytes pass through the host. If the host has a transfer allowance, watch that; there is no disk cost.

## FFmpeg and temporary storage

Conversion is the only playback path, so the server refuses to play anything
useful without a working FFmpeg. Startup now says which of these you have:

- **`ffmpeg: ok <path>`** — the real probes (x264, AAC, HLS muxer, scale/pad,
  readrate) all passed.
- **`ffmpeg: NOT USABLE`** — nothing will play. Fix with `node troy-ffmpeg.js`
  (downloads a static build, no root needed) or `apt-get install -y ffmpeg`.

### Getting FFmpeg without root

On a panel container you usually cannot `apt install` and cannot pass devices
through. Two supported routes, both the same prebuilt release:

```sh
# 1. the panel's own npm install, which runs on every restart
npm install ffmpeg-static

# 2. or fetch it once into the application directory
node troy-ffmpeg.js
```

`node troy-ffmpeg.js` first checks anything already present, including the
`ffmpeg-static` package, and only then downloads. It writes to
`.troy-ffmpeg/ffmpeg` beside the application, not `/tmp`, so it survives panel
restarts. Both routes need no root.

If the download fails, the container cannot reach GitHub — install through the
panel, or ask the host to allow `github.com` and
`release-assets.githubusercontent.com`.

### Software or hardware encoding

Software (`libx264`) is the default and always works: no device passthrough, no
BSP kernel, nothing to break. It is the right choice on a normal container.

Hardware encoding is opt-in only, because it needs matching hardware *and* the
device nodes passed in:

```sh
CINEMA_ENCODER=rkmpp npm start
```

That is honoured only when the FFmpeg in use actually advertises `h264_rkmpp`
**and** `/dev/mpp_service` exists. Otherwise the server silently stays on
software rather than failing. Run `node troy-doctor.js` and look at section 0:
it prints the SoC, the kernel, which media devices are visible, and whether the
installed FFmpeg offers `libx264` / `h264_rkmpp`.

In practice: unless the box is really a Rockchip board with its devices passed
through, use software.

**Temporary storage matters as much.** Conversion writes growing HLS segments
for as long as something is playing. If the temp directory is `tmpfs` it lives
in RAM, so a full-length title can consume memory and get the server killed
mid-playback. The server now moves output off tmpfs automatically when the
system temp is RAM-backed, and prints where it chose:

```
temp:     /home/container/.troy-media  [disk (system temp is tmpfs)]  14.2 GB free
```

Set `CINEMA_TMPDIR` to override, or keep the automatic choice.

## When the provider refuses this address outright

There is a failure that no header, protocol or retry can fix: a CDN that answers
`426` (or `403`) to this machine for every request, including HTTP/1.1 with a
browser User-Agent. The refusal belongs to the **address**, not the request.

`troy-426.js` measures it instead of guessing:

```sh
node troy-426.js "https://<the-media-host>/path"
```

Four lines come out. If all four are `426`, the address is refused and the bytes
have to be read from somewhere else. That is what the **Cloudflare relay** is for:

```
browser ──> Troy (this server) ──> Worker (Cloudflare) ──> provider CDN
```

The Worker fetches the media; Troy reads the Worker. Troy's own address never
touches the provider. Everything else is unchanged -- same player, same session,
same range probing, same FFmpeg, same two qualities. Cloudflare's free plan
charges nothing for egress and sets no limit on a response body.

Setup is two steps and is written out in [`worker/README.md`](worker/README.md):
create the Worker, then set the two variables below and restart.

```
CINEMA_RELAY_URL=https://troy-relay.<your-subdomain>.workers.dev
CINEMA_RELAY_KEY=<a long random secret, at least 16 characters>
```

The startup banner then shows one of:

```
  relay:    on  https://troy-relay.….workers.dev/  (source bytes fetched by Cloudflare)
  relay:    off (direct fetch from this address)
  relay:    NOT USABLE
            CINEMA_RELAY_KEY must be at least 16 characters when CINEMA_RELAY_URL is set
```

### The relay can live on bot-keep, or on any box of yours

`troy-relay-server.js` is the same contract as the Worker, with no dependencies
at all -- no npm install, no database, no FFmpeg, no disk, no file kept in memory.
It opens the CDN, streams the answer out and forgets it. That is why it fits on a
container that cannot run Troy itself.

```sh
# on the relay host. The port is the one YOUR panel assigned -- a panel routes the
# outside world to that port and to nothing else. It is shown beside the server,
# as in node17.botkeep.cloud:57395.
TROY_RELAY_KEY=<the same secret> PORT=57395 node troy-relay-server.js
#   → listening: 0.0.0.0:57395   (port from PORT)
#   → health:    http://localhost:57395/health

The relay reads the port from `PORT`, `SERVER_PORT`, `TROY_RELAY_PORT`, or the port
of `TROY_PUBLIC_URL`, in that order, and refuses to start (exit `78`) if none is
set. It will not invent one: listening on a port nothing is routed to looks exactly
like a working relay that never receives a request.

**`troy-relay-server.js: not found` (exit code 127)** means the file was run as a
program rather than with node, or it is not in the directory the panel starts in.
Check both:

```sh
ls -l troy-relay-server.js     # must exist here; otherwise cd to solo-cinema/
node troy-relay-server.js      # always run it with node
```

If two servers cannot be started at all, use the other form. It runs the relay
inside a process that is already starting, so the panel needs no second app:

```js
require('./troy-relay-server').start();   // in the bot's entry file
```

That needs nothing but `TROY_RELAY_KEY` in that process's environment.

The relay refuses to start without a usable key (exit `78`, EX_CONFIG) rather than
run unsigned, and says so. If its port is taken it says that too, instead of
restarting in a loop.

# on Troy
CINEMA_RELAY_URL=http://node17.botkeep.cloud:57395
CINEMA_RELAY_KEY=<the same secret>
```

`CINEMA_RELAY_URL` now accepts `http:` as well as `https:`, because a relay can be
another machine of your own. Over plain HTTP the signature travels in an
`x-troy-sig` header instead of the query string, so the shared key never appears
in a URL that a proxy or a log could keep. An `https:` relay keeps the query form,
which is what the deployed Cloudflare Worker already understands -- no re-paste.

The relay only needs to be reachable from Troy. If bot-keep is reachable only on a
private network between the two, that is enough; nothing else has to be exposed.

**Both routes are now tried, automatically.** The relay is asked first and this
server's own address second, per fetch. A status that says something about the
*path* -- `426`, `427`, `428`, `429`, `451`, `502`, `503`, `504` -- moves to the
other route instead of being reported; a `403` or `404` does not, because asking
again cannot change a wrong link. The winning route is remembered per host for ten
minutes, and each distinct host is asked once when a title is resolved, so the
player does not pay a wait to find out which route is free. `CINEMA_ROUTE_MEMORY=0`
turns the memory off. A panel that loses its environment and leaves the relay
half-configured now starts in direct-only mode instead of refusing to start.

Requests are signed with `CINEMA_RELAY_KEY`, so the Worker is not an open proxy
and a leaked link is useless without the secret. `CINEMA_RELAY_FALLBACK=1` allows
a fall back to the direct fetch when the *Worker itself* is unreachable; it never
retries a refused direct request.

If a source still reports a status, `troy-relay-probe.js` measures which route
gives what, so the cause is named rather than guessed:

```sh
node troy-relay-probe.js "https://<source url>" --referer "https://moviebox.ph/"
```

```
  what   route                      took      upstream
  ------ -------------------------- --------- -----------------------------------------
  200    1. direct                    180ms  video/mp4  2147483648 bytes  ok
  200    2. relay                     240ms  video/mp4  2147483648 bytes  ok
  427    3. relay after a gap        6200ms  text/plain  rate limited (nginx limit_req)  [worker retried 4x]
```

**427 and 429 are rate limits, not refusals** (`limit_req_status 427` is a common
nginx choice for exactly this). A Worker shares its egress address with thousands
of other Workers, so these CDNs count it as a very busy client and its bucket is
often full. The worker therefore waits and asks again up to four times, honouring
`Retry-After` when the CDN sends one and giving up after twelve seconds. Only then
is a 427 reported, marked `[worker retried 4x]` so it is never mistaken for a
refusal. One retry a minute later usually plays.

Prove it on any machine, without deploying anything:

```sh
node troy-relay.js --test
```

That runs the real `worker/troy-relay.mjs` locally against a fixture CDN that
refuses with `426` and accepts a browser-shaped request, and checks 25 properties
including byte-identical bodies, `Range`/`206`/`If-Range`, and a CDN that answers
`427` twice before serving. Add
`--worker-url https://…workers.dev` to check a deployed Worker as well.

## When one server works and another does not

The same build can play on one host and fail on another. That is almost never
the application: it is how that machine reaches the internet. Run this **on the
machine that fails**:

```sh
node diagnose-host.js "https://<the-media-host>/path"
```

It reports IPv6 routability, what the media host resolves to, whether a TCP
connection to each answer actually opens, and the same request under both
address-family policies.

**`CINEMA_IPV4=1` forces IPv4** for all outbound source and provider traffic.
Set it when the diagnostic reports `IPv6 route NOT reachable` while the media
host returns AAAA records — the very common case on cheap VPS hosts, where DNS
keeps handing out an IPv6 address the machine cannot route, so every source
fails for a reason that has nothing to do with the providers. Leave it unset on
a working dual-stack or IPv6-only network.

```sh
CINEMA_IPV4=1 npm start
```

## Run

Requires Node.js 22.13+.

```sh
cd solo-cinema
npm ci
CINEMA_PASSWORD='a-long-unique-password' PORT=3000 npm start
```

On Botkeep, set `CINEMA_PASSWORD` privately in Environment and let the host supply `PORT`. The app loads `.env` from its working directory at startup; variables already exported by the host take precedence over `.env`. Restart after changing it. If the panel writes `.env` elsewhere, set the working directory to the directory containing the file or export the variable directly. Use Node.js 22.13 or later and HTTPS. If the GitHub integration clones the **entire repository**, do not use the root bot startup command: configure its working directory as `solo-cinema`, or (if the panel supports shell startup commands) use `cd solo-cinema && npm ci --omit=dev && npm start`. If the panel supports a project root, set it to `solo-cinema` and use `npm ci --omit=dev` as the install command and `npm start` as the startup command. Panel behavior has not been verified; check the startup log and do not assume GitHub automatically deploys the subfolder. The password must be at least 12 characters. Use HTTPS; HTTP does not protect the password or streams in transit. Do not expose this service on an untrusted network without HTTPS. A restart signs you out and invalidates stream links, but your browser watchlist remains. The public HTTPS proxy refuses private and reserved addresses on every connection and redirect; DNS is checked on connection. Provider integration requires a separate security review and safe handling for every provider-controlled request.

There is no persistent disk media cache. Only the conversion fallback writes temporary HLS segments; relayed playback writes nothing. Browser support, source CORS-independent proxying, bandwidth, DRM and format compatibility still limit playback. The server is a private tool, not hardened for multiuser or high-traffic use. The offline suite includes mocked HTTP and simulated-DOM playback fallback, not a real browser. All provider adapters, token sandbox, subtitles, fallback and catalog lookups were tested with offline fixtures only; live provider access, playback and Botkeep deployment have not been verified. Some providers require particular headers or DRM that this player does not support.

## Verify after deploying

1. Open the panel’s HTTPS address and sign in. Confirm the startup log shows `Troy is listening`.
2. Search an authorized title and tap a result to open its player and look for streams. For shows, select an episode and press Play selected episode. Check playback, seeking, available quality/audio/subtitles and fallback. Confirm a KissKh title separately if desired.
3. Refresh to check the browser-local watchlist and playback position. Check the console if a provider fails. Providers can change or block the host; fixture tests cannot establish live availability.
4. This service uses bandwidth while proxying streams; transcoding also uses temporary disk space. The 2 GB plan may still be constrained by memory, network and provider limits.

## Player controls

The server/source menu lists only streams actually returned for the selected title and switches through the same validated streaming proxy. The geographic server names in the design reference are not endpoints and are not fabricated here. Quality, audio and provider subtitles depend on the source; native HLS browsers may control quality themselves. Playback speed and local SRT/VTT subtitle uploads are supported. The player settings menu includes **Subtitle height**, with a default 25% above the bottom and adjustable presets; the choice is saved locally alongside subtitle size and color. Troy adjusts active, horizontally written WebVTT cues while keeping the browser’s native subtitle rendering. Position is approximate and depends on the browser and cue height; vertical or read-only native captions and native device fullscreen/picture-in-picture can ignore it. Uploaded subtitles stay in the browser and are discarded when changing sources or signing out; there is no OpenSubtitles integration. Source switches try to retain position and pause state. These controls have simulated-DOM coverage but have not been verified in a real browser or against every live provider.

## Troy home

The app is branded Troy; the project folder, environment variables and browser storage keys remain unchanged for existing deployments. The home page loads category names and titles from MovieBox’s home feed, cached in memory for 30 minutes after successful requests. Categories depend on the provider and may change. If MovieBox is unavailable or returns no usable categories, Cinemeta metadata catalogs provide a fallback; Cinemeta also fills missing movie, series or anime coverage. Fallback category labels are local descriptions of those catalogs, not MovieBox categories. A category card opens the selected title directly and starts direct-stream lookup automatically, without requiring a search or save. A listing does not guarantee a working stream. Poster images load through wsrv.nl, which receives the browser IP and original poster URL; it fetches and resizes approved MovieBox or Cinemeta artwork. Availability and cache duration depend on wsrv.nl; no poster files are stored on Troy. Provider, artwork and catalog availability varies. No movie files are stored by the home page.

### Movy sources
For MovieBox or Cinemeta catalog results with a matched TMDB ID, Troy also tries the user-supplied Movy protocol, using Miami, Boise and the remaining English-server names in order and stopping at the first server with usable URLs. The source picker labels returned streams `movy:<server>`; these names are upstream labels and do not prove geographic hosting. Requests are serialized, results are cached for 10 minutes, and a 429 triggers a local one-minute cooldown (the upstream limit may last longer). This does not account for other clients sharing the same public IP. Movy may be slow, reject requests, change its protocol or return expired links. Explicit MP4 sources use the supplied fixed Movy headers through Troy's HTTPS/public-address-validated input fetcher. HLS input is not supported. Converted segments are saved temporarily on disk.

Only English-server lookup is implemented; the separate dubbed servers, Berlin alternate-title lookup, the independent subtitle search service, and Reno's special 900p probe are not implemented. English captions included in a Movy response are fetched on demand and converted to WebVTT when possible. HLS masters cannot currently be used as input. The integration is tested with mocked responses and a Python-generated encryption vector, not against the live provider or a real browser in this environment.

### Search and 7Movies / VidLink
Search returns matching movies and shows, ranks exact matches first and merges only unambiguous title/type/year matches. Cinemeta is metadata only: a listing does not guarantee playback. Tap a result to open the player and start lookup. The player can add or remove titles from the browser-local watchlist. MovieBox catalog duplicates with the same title/type/year are collapsed, and its resolver can retry exact duplicate subjects. Lookups can still wait for slow providers, and autoplay may require tapping the video's own play button.

7Movies uses VidLink's API and a third-party `enc-dec.app` encryptor, which receives the title's TMDB ID and the server's IP. Returned links and limited referer/origin headers go through the public-address-validated streaming proxy. English captions in a response are optional. A public web retrieval returned an Oppenheimer VidLink stream response, but this does **not** verify Botkeep access, CDN playback, or the adapter in a real browser. An attempted Movy seed retrieval from the web-fetch environment returned HTTP 500, with no response body; the failure's cause and Botkeep behavior are unknown. FlyStream, Videasy, Vidsync, Netmirror, Vidfast, 4KHDHub and VixSrc are not integrated.

## Ads and redirects
Troy no longer loads third-party embedded players. VidRift, VixSrc and VidFast embeds are unavailable; VidLink remains available only through the existing 7Movies direct-stream adapter. Its own player uses proxied media rather than provider webpages, and its content security policy disallows frames. This prevents popups and page redirects from those embedded players, but may reduce the number of playable titles. Direct media requests can follow validated HTTPS redirects on the server without navigating the browser; providers sometimes need these to reach a CDN. Troy cannot reliably identify or remove advertisements inserted into the video or HLS stream itself, and cannot guarantee that every third-party stream is ad-free. Browser extensions or device software are outside Troy's control. Playback and ad behavior on Botkeep have not been verified in a real browser.

## Data saver and quality

The Data saver button controls artwork and is remembered locally. Video always uses the chosen converted 240p or 360p rendition, defaulting to 240p; these are approximate video resolutions, not a guaranteed data cap. Audio, overhead and provider traffic add usage.
With Data saver on, category rows initially reveal six matching cards, with More to reveal the rest. Posters use lazy, asynchronous loading and request 140px WebP at quality 45, or 240px quality 60 with saver off. The remote image service controls its own caching and might be unavailable; no long-term cache is guaranteed. Switching the setting reloads already-visible artwork at the new size, which itself uses data.

Troy automatically converts supported sources to temporary 240p and 360p renditions. The player layout and interactions are adapted from the supplied HTML, integrated with Troy’s existing resolver, source selection and security policy.

## Player controls and audit notes

The player overlay includes play/pause, seek and buffering progress, ±10 seconds, previous/next episodes, settings, lock, picture-in-picture and fullscreen. Double-tap the left/right side to seek; a vertical swipe on the left dims only the video (not device brightness), and one on the right changes browser media volume where supported. Keyboard shortcuts work while the watch page is open and focus is not in a form control. Fullscreen, orientation lock, wake lock, picture-in-picture, volume changes and autoplay depend on browser/device permissions and may be unavailable, especially on mobile. The previous button uses the episode list or the prior number; automatic next only runs when a later listed episode exists. Playback speed is saved locally; converted-video resume after leaving the page is not supported.

The settings menu offers 240p and 360p converted qualities and available subtitle controls. Browser features and live playback have not been verified on Botkeep.
## Mandatory on-demand transcoding

Troy installs a platform-specific FFmpeg binary as an optional npm dependency on Linux x64 and ARM64 (glibc or musl). A normal `npm ci --omit=dev` includes optional dependencies; do not use `--omit=optional`. On Linux x64 each executable occupies about 83 MiB; some npm versions install both glibc and musl builds (about 166 MiB total, plus npm cache). The pinned third-party `@seydx/node-av-ffmpeg-light` platform builds include GPL-3.0-or-later and FDK-AAC components; their license and source information ship with the package. Keep the dependency and FFmpeg updated. The package metadata recommends Node 22.18 or later.

Troy checks the packaged executable first, then the system `ffmpeg` on PATH. If `CINEMA_FFMPEG` is explicitly set, only that executable is used. The binary is checked for execution, libx264, AAC, HLS, scale and pad before opening a video; missing files, incompatible loaders and execution permissions are reported separately. Optional dependencies may be skipped if the architecture is unsupported, install fails, or engine/optional settings disallow them; a system FFmpeg with libx264, AAC and HLS remains a fallback. Without a usable binary playback fails; Troy never falls back to the original. Actual Botkeep architecture, installation, noexec restrictions and CPU performance have not been verified.

Troy converts only when relayed playback is not possible. The player quality setting selects 240p or 360p and remembers the choice. There is no return-to-original option. Conversion currently works only for fast-start MP4 input with its `moov` metadata before media data and within 8 MiB. HLS playlists, non-MP4 sources and MP4s whose metadata is at the end cannot play until support is implemented. Input is read through Troy's DNS-pinned HTTPS fetcher and FFmpeg is restricted to pipe input protocols; FFmpeg is a native decoder, not an OS security sandbox. Run Troy as an unprivileged user in an isolated container. Only use authorized sources.
The ladder encodes 240p and 360p in parallel, with the first audio track, H.264 and AAC. Smaller sources may be upscaled without adding detail. Converted segments accumulate in a session-bound HLS EVENT playlist, and FFmpeg writes ENDLIST when conversion completes. When the fast-start MP4 has a valid `mvhd` duration, the custom timeline shows that duration. Seeking within the current converted portion uses the existing output; seeking elsewhere stops the current job and starts a new conversion at the requested timestamp. Subtitles loaded by Troy are retimed for the restarted conversion when browser cue APIs allow it.

**This is not HTTP Range random access.** FFmpeg receives a non-seekable pipe, so a forward seek may need to read and discard the preceding source bytes on the server. A late seek can take a long time, use substantial upstream bandwidth and fail for MP4s that cannot be decoded from a pipe. The old converted segments are removed on restart. If the MP4 duration is missing or invalid, the timeline only covers the converted portion. HLS inputs and a cache reused across sessions are not supported. Playback progress is stored in the browser; resuming starts a new conversion at that position and may be slow. Real providers, subtitle synchronization, browser playback and Botkeep performance have not been verified.

There is **no Troy-imposed output-storage limit or minimum-free-space reserve**. At the configured nominal rates both outputs together use roughly 433 MB per hour of video before overhead, although actual usage varies. The output may fill the filesystem or host quota and affect other applications. Set `CINEMA_TMPDIR` to an existing writable directory to choose where segments go; Troy warns on Linux if that directory is detected as tmpfs, but does not refuse it or require storage checks. Temporary output is removed on stop, logout, source change, shutdown or error; abrupt crashes can leave files until later cleanup.

One job is allowed. Running FFmpeg jobs are not expired for inactivity. Completed jobs expire after ten minutes without access; the open player sends a heartbeat, though browser suspension may prevent it. Initial startup has a 45-second deadline, and a seek has a deadline of at least 180 seconds plus the seek offset in seconds; slow sources can still exceed it. An authenticated user can explicitly stop another session's conversion from Player options. Input pacing targets 3x, but actual speed depends on CPU and the source and may increase bandwidth and disk usage per wall-clock minute. A dropped input connection is retried up to three times per interruption with validated ranges when the source supplies a usable validator and length. On HTTP 401/403 the app attempts to re-resolve catalog sources; direct links have no resolver and providers can return stale, ambiguous or different links. There is no fixed four-hour playback limit. Conversion can use substantial CPU and cause buffering; performance on Botkeep is unverified.

Temporary segments are removed on stop, logout, source change, normal shutdown, error or timeout. Old abandoned job directories are reaped on a later startup after five hours when their owner PID is no longer alive. A crash may therefore leave temporary files until a later restart; use an OS/filesystem quota if a strict disk ceiling is required. The temporary files are session-bound and never exposed as arbitrary filesystem paths. The offline suite tests validation and simulated UI. An FFmpeg integration test runs automatically when the compatible packaged binary is installed, or can use the executable in `CINEMA_TEST_FFMPEG`. It generated a synthetic MP4 and encoded and decoded both variants in this environment, not live provider video or a real browser.

The offline suite includes a local HTTP server that forcibly drops a socket and a real FFmpeg conversion that resumes using a validated range after a simulated 403 refresh. `npm run test:soak` separately runs a five-minute synthetic conversion/playlist-reader soak and uses temporary disk and CPU. It is not a browser or provider playback test. Seeking still restarts conversion and can require downloading and discarding all earlier source bytes; a failed seek does not preserve the prior job. HLS input conversion is not supported.

### Provider reliability and security notes

Provider lookups run with independent deadlines: 6 seconds for VaPlayer and VidSrc, 10 seconds for VidLink, and 12 seconds for MovieBox and Movy. In production, expiry aborts the provider's in-flight fetch; complex or slow providers may be cut off before exhausting every upstream alternative. Equal media URLs are deduplicated only when their playback headers and format also match. The player orders sources using recent playback starts and failures in the current browser session, not a promise of availability. No provider is permanent.

VaPlayer, VidSrc and Movy explicitly identified MP4 paths are eligible for conversion; opaque paths remain classified as HLS and are not assumed to be MP4. HLS input is still unsupported, and these adapters have not been verified live from this environment. VidLink response TTLs, when present and plausible, trigger an attempted re-resolution at 75% of TTL or 45 minutes, whichever is earlier. A refreshed range must still match the original validator and size, and an ambiguous or unavailable refresh can fail. Direct URLs cannot be re-resolved. The user's external probe is not a test of this installation.

Login rate limiting uses the immediate network peer, not untrusted `X-Forwarded-For`. Clients behind the same reverse proxy share a bucket; a separate global backstop remains. Source handles use bounded least-recently-used eviction per session and globally; eviction does not stop an already-started job, but an evicted handle must be resolved again. KissKh episode metadata is cached for two minutes. No periodic provider health probes or persistent last-known-good token script were added: they do not prove stream availability and can cause rate limits or rely on stale third-party code.
