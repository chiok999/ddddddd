# Troy control audit

Scope: inspected the standalone app's `public/index.html` and every handler in `public/app.js`, plus fallback, provider and server routes used by those handlers. This is an interaction audit, not a full audit of the existing bot. Automated tests use jsdom and mocks; they do not render video or prove every control works on a physical device.

## Findings addressed

- `public/app.js:38,45,52`: a late provider subtitle or HLS track-list update could overwrite the user's subtitle selection, including Off. Explicit choices and track-list refreshes are now preserved; stale HLS track events are ignored. The simulated-DOM test covers HLS refresh, not real caption rendering.
- `public/app.js:53`: choosing Default after a named HLS audio track did nothing. It now sets HLS.js audioTrack to -1 (automatic/default); covered with a mock HLS player.
- `public/app.js:13`: failed sign-out caused an unhandled rejection after clearing only some player state. It now reports failure and leaves the signed-in state intact; successful sign-out clears the player and stale search. Both paths have simulated-DOM coverage.
- `public/app.js:81`: a late episode-list response could reset a manually entered episode. It now only applies the first listed episode if season and episode still have their defaults.
- `public/app.js:107`: two catalog entries from different providers with the same title/year/type were deduplicated. Source now participates in the comparison.
- `public/index.html:2` / `public/app.js:11`: navigation pointed into the hidden app before sign-in; it is now hidden until authenticated. Catalog-failure fallback retains the Movies and Shows anchor targets.
- Added subtitle size and color controls via `::cue` and persisted preferences. CSS cue support varies, particularly in native fullscreen; browser/device verification is still needed. No timing-offset or OpenSubtitles search control exists.

## Control inventory

- Navigation and hero links use same-page anchors. Discovery cards and anime picks search by title; the user must select a result. Catalog retry reloads failed sections. These links/scrolling have not been physically tested on mobile.
- Login, sign-out, search, title result selection, find streams, per-stream and automatic play, watchlist play/save/remove: handlers exist. Automated tests cover login, sign-out, search, source fallback, saved-title playback, direct save/remove and a discovery card. Provider outages and browser autoplay may still prevent playback.
- Season/episode fields and episode dropdown feed resolution; Next Episode uses the list or increments when unavailable. Simulated tests exercise episode navigation and end of list. Catalog data can be incomplete and manual numbers are needed in that case.
- Native video controls provide play/pause, seeking, volume and fullscreen; they are browser-provided and have not been exercised here. Separate back/forward 10-second buttons have simulated seek tests.
- Quality selects HLS.js levels or same-provider file variants; Safari/native HLS cannot expose HLS.js levels. Source selector uses returned stream variants and preserves time/pause where supported. HLS.js, file switching and source switching have mock tests, not live multi-provider tests.
- Subtitles: selector, local SRT/VTT upload, size and color are wired; upload and selections have simulated tests. Provider subtitle fetch is optional. Appearance and cue rendering require real-browser/device tests. Audio and speed have mock tests.
- The reference's Miami, Boise, and other city labels were only UI labels: no working geographic endpoint or source mapping was supplied. They are **not** implemented. The actual selector offers only provider streams returned for that title; no geographic location is implied.

## Still outstanding

1. Live KissKh playback and the Botkeep-specific failure have not been reproduced or fixed with evidence. MovieBox S1 E1 playback was shown by the user previously, not verification of every title/provider.
2. Real-browser and mobile checks remain for every control, subtitle rendering, fullscreen, touch layout, quality/audio switching, server fallback and live caption availability. Previous headless Chromium launch failed due to missing NSS/NSPR libraries.
3. No genuine geographic server integration, live trending chart, live anime-specific catalog, OpenSubtitles search, subtitle timing adjustment, or torrent transport. The Cinemeta popular and curated anime sections are labelled accordingly.
4. Storage-disabled or quota-exceeded environments can make watchlist/progress persistence fail (`public/app.js:5`); normal browser storage is assumed.
5. The existing bot downloader's SSRF exposure remains separately documented in `../AUDIT.md`; the standalone app deliberately does not expose that downloader. Provider-supplied links and the QuickJS token sandbox still warrant independent security review.

## Movy update

The user subsequently supplied API and decryption details. The standalone app now tries named English Movy servers sequentially, stopping at the first usable response, and labels actual results in the source picker. This is not a simultaneous list of all servers. Dubbed servers and Berlin's alternate-title rule are not implemented. External endpoint access, signed-link expiry, actual response format, and playback headers across live CDN redirects remain unverified here; the tests are fixtures/mocks. A 10-minute cache cannot guarantee a particular signed URL remains valid for its entire lifetime. The existing KissKh catalog path remains separate and does not fall back to Movy.
