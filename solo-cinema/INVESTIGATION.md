# Playback investigation

## Evidence

- The user's Botkeep screenshot showed a MovieBox catalog result for Merry Berry Love, but its selected candidate produced `MovieBox returned no playable streams for this title or episode`, VaPlayer returned no streams, and VidSrc lacked a TMDB ID. The screenshot does not identify the MovieBox subject ID or episode number; it does not establish why the candidate was empty.
- On 2026-11-16, a public GET for a separately indexed MovieBox subject (4141784352315295168, `merry-berry-love-EifKV9OpXV4`, season 1 episode 6) returned `hasResource:false` with empty `streams`, `hls`, and `dash`. This demonstrates that a MovieBox title can exist without a playable resource for a particular subject/episode. It is not evidence that this is the user's selected subject, and the request did not replicate the user's provider headers or Botkeep network.
- Cinemeta's series details for `tt38937897` identify TMDB `305551` and episodes for Merry Berry Love. Its search result omits the TMDB ID. The app now reads the details endpoint, but this does not prove VidSrc will produce a working stream.
- An earlier screenshot said KissKh search was unavailable on Botkeep, without a failure code. A public GET of the same search endpoint from the web-page retrieval service returned results. That is a different network, so it does not reproduce the Botkeep failure. The cause is still unknown.
- Existing bot KissKh code retries 429 and selected 5xx responses; Solo Cinema did not. The new bounded retry tests simulate 429 and 403, but no Botkeep 429 was observed.
- MovieBox search results in the screenshot include `Merry Berry Love [English]`. The previous exact-match fallback normalized brackets into words, so it never considered that alternate for `Merry Berry Love`. The regression test simulates the alternate containing a stream; whether it currently does so is unverified.

## Test boundaries

`npm test` exercises authentication, fixture provider search/resolution, local HTTP media proxy, a simulated browser DOM, DNS/redirect checks, and the KissKh token sandbox. It does not make live provider requests or decode a real video. An attempted Chromium playback check failed before launch because the environment lacks libnss3 and libnspr4; it does not establish playback success or failure. Outbound connections from the coding sandbox are restricted, and the authenticated Botkeep instance is not accessible here. No result supports declaring live playback fixed or deploying as a verified final release.
