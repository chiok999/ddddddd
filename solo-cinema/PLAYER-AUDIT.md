# Player integration audit

> **Historical.** These audits describe the hand-written player in `public/`,
> which has since been deleted; ReelBox (`reelbox-src/`, built to `app/dist/public/`)
> replaced it. The findings and reasoning are kept because the behaviours they
> describe were carried over to the new player, but the file references below no
> longer resolve.

The supplied `troy-player.html` is a standalone demo, not a drop-in adapter for Troy's session-bound source URLs. Its example creates a separate HLS instance, guesses HLS from filename, inserts title/track labels as HTML, and uses CDN JavaScript. Troy instead keeps its existing proxied resolver, HLS.js instance, text-safe DOM construction, fixed same-origin assets and no-frame CSP. The reference layout and interactions are implemented in `public/index.html`, `public/player.css` and `public/player-ui.js`; stream/track/episode state remains in `public/app.js`.

Offline tests cover play/pause, seeking/progress, gestures, lock and keyboard, settings, PiP/fullscreen API calls, previous/automatic-next episodes, adaptive quality menu, preference persistence, native exposed subtitle/audio tracks, static assets and pre-existing provider/fallback fixtures. These simulated DOM tests do not prove browser rendering, touchscreen behavior, actual media playback or provider availability. No real browser/CDN/Botkeep playback was verified in this environment.

Constraints: quality levels are only those present in the provider's HLS manifest or returned separate files; the optional converter can produce a temporary 240p/360p ladder only for supported fast-start direct MP4 inputs. HLS.js adaptive selection is not available for native HLS playback. Data saver limits automatic HLS.js levels when metadata allows; manual selections may override it. Browser support and permission govern PiP, fullscreen, orientation, wake lock, autoplay and volume. The brightness gesture dims the video area, not the device. Auto-next requires a known later episode to avoid guessing. Persisted quality is a resolution, not a provider-specific level index. CSS and JS remain same-origin; no arbitrary third-party player frames or demo URL loader were reintroduced.

## Subtitle positioning

`public/app.js` listens for native text-track additions and cue changes, and applies the saved height to exposed horizontal WebVTT cues without drawing or interpreting subtitle text. `Subtitle height` is also available in the player menu (`public/player-ui.js`); settings default to 25% from the bottom and persist with size and color. Simulated tests cover active and newly added cues, uploaded subtitles, position changes, persistence, vertical cues, metadata tracks and read-only cues. Browsers may ignore cue positioning for native fullscreen, picture-in-picture, vertical, inaccessible or non-WebVTT captions; placement is approximate. A Chromium launch was attempted for a real-browser test, but failed because `libnspr4.so`, `libnss3.so`, and `libnssutil3.so` are absent in this environment. Real device and live provider positioning remain unverified.
