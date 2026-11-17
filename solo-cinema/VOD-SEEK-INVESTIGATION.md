# Full-length seeking and mandatory transcoding investigation

**Status: not implemented.** Normal direct playback remains available and the existing opt-in transcoder is still a rolling live HLS window. This report is not a change to player behavior.

## Confirmed trigger

- `transcode.js` encodes the input into HLS with `-hls_list_size 8` and `delete_segments`; it does not generate a full VOD playlist or pass original duration to the player.
- `public/player-ui.js` takes the progress bar's length from `video.duration`, which for this rolling playlist reflects the current live timeline rather than the full source duration. Seeking beyond segments still in the window cannot work. The screenshot showing 0:49 / 1:04 and the live-conversion notice is consistent with that behavior, not the episode's length.
- `server.js` rejects `entry.format==='hls'` in `/api/transcode`; `transcode.js` admits only fast-start MP4 and pipes its bytes to FFmpeg with `-protocol_whitelist pipe`. The current system cannot safely enforce conversion of *all* existing streams without making HLS-only and non-fast-start sources unavailable.

## Tested locally

Using the installed FFmpeg 8.1.3 binary, a synthetic 20-second fast-start MP4 containing 10 seconds of red followed by 10 seconds of blue was piped to FFmpeg. Output-side `-ss 12` produced blue pixels, proving FFmpeg can discard the beginning and produce the requested content from a pipe. The automated test `FFmpeg can discard to a later MP4 timestamp on a pipe` reproduces this. This is **not** efficient random access: a pipe cannot seek by HTTP Range, and FFmpeg must consume the stream up to the requested time. Latency, upstream bandwidth, FFmpeg read-rate pacing, subtitle timing, cancellation and late-film behavior have not been established. This test does not implement seeking in Troy.

A synthetic HLS playlist referencing `http://127.0.0.1:9999/segment.ts`, sent to FFmpeg with `-protocol_whitelist pipe`, failed with `Protocol 'http' not on whitelist 'pipe'!` and exit status 183. This is the intended security boundary: enabling FFmpeg's network protocols or giving it provider-controlled playlists without strict mediation can reintroduce server-side access to private addresses and arbitrary URLs.

## Supplied upstreams

- [ErsatzTV Next](https://github.com/ErsatzTV/next) is a scheduled live-channel engine and requires its own patched FFmpeg build. Its `crates/ffpipeline/src/keyframe_seek.rs` explicitly handles keyframe landing and timestamp correction for stream-copy playouts; it does not by itself provide Troy with a secure random-access VOD service.
- [MediaCMS](https://github.com/mediacms-io/mediacms) documents chunked transcoding and HLS, but is a full upload/encode CMS with Django, Celery, Redis and PostgreSQL. Its README suggests 4 GB RAM and substantial storage for its target deployments. Its workflow is not a drop-in for this 2 GB streaming-only project.
- [go2rtc](https://github.com/AlexxIT/go2rtc) documents FFmpeg-backed HLS inputs and on-demand producers, but its HLS output documentation describes live streaming and says its implementation may not work with all players. Its README warns that access to its API can permit command execution. Pointing it directly at provider URLs would bypass Troy's existing DNS-pinned HTTPS checks; its documented live output alone does not establish full-duration VOD seeking.
- [MediaMTX](https://github.com/bluenviron/mediamtx), [SRS](https://github.com/ossrs/srs), [Restreamer](https://github.com/datarhei/restreamer) and [Ant Media Server](https://github.com/ant-media/Ant-Media-Server) primarily provide live streaming infrastructure; their existence does not demonstrate session-bound seekable VOD or safe provider URL handling in this deployment.

## Remaining work

A complete implementation needs session-bound source duration and full-timeline seek semantics, a secure seekable/range-aware source adapter for MP4, a separately validated HLS VOD adapter for playlists, segments and encryption, cancellation/cleanup, subtitle synchronization and automatic conversion of every playable result with no direct-play fallback. Unsupported or unsafe inputs must fail explicitly. Changing the browser's displayed duration without supplying seekable media would be misleading. These behaviors, long-video resource usage and Botkeep playback have not been implemented or verified here.
