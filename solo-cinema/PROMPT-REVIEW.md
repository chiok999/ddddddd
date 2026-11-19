# Verified findings: the three-track prompt

Assessment of a detailed remediation prompt covering seek correctness, subtitle
retiming and encode quality. Each claim was checked against the running code;
encode claims were measured, not assumed.

**Verdict: the diagnosis is sound.** 14 of 15 code claims are true as written,
one number is wrong, and the prescribed fixes contain five defects that would
have caused new bugs if applied literally. The subtitle track is the largest real
bug and the least expected one.

Everything below was run on this repo at `75a0ddf`, Node v22.22.3, FFmpeg from
`@seydx/node-av-ffmpeg-light-linux-x64`.

---

## Track 1 — pacing: CONFIRMED, and worse than described

### 1.1 The seek offset is subtracted twice — TRUE, critical

`transcode.js:373` computes `offset+encoded-(offset+played)`, and
`played` is an absolute full-timeline position: the client sends
`totalTime() = seekBase + video.currentTime`, and `seekBase` is set to `startAt`
when a job restarts.

The two offsets cancel, so `ahead = encoded - played`. Measured with the exact
expressions:

```
offset 0,    encoded 8,  played 0    -> ahead  8    canPlay yes
offset 1800, encoded 8,  played 1800 -> ahead -1792 canPlay no
offset 1800, encoded 1800, played 1800 -> ahead -1800 canPlay no
offset 1800, encoded 1802, played 1800 -> ahead  2   canPlay yes
```

After a seek to 30:00 the viewer waits for **1802 seconds of output** before the
"catching up" gate opens. That is the reported symptom and it is not subtle.

`job.measure()` (`:288-289`) has the same error with `Math.max(0, …)` on top, so
the throttle sees 0 for the entire offset and never pauses the encoder.

The proposed fix is correct, including `position: played` (the current
`offset+played` double-counts) and the `: offset` default for an unreported
position.

### 1.2 240p waits for the 360p rung — TRUE

`:327` gates readiness on `counts.every(n=>n>=1)`. Both rungs must yield a
segment before `start()` returns, so the default rung waits for an encode it
never downloads.

### 1.3 `MIN_LEAD=2` with `HLSTIME=4` — TRUE

`:36` is `MIN_LEAD=2, RESUME_LEAD=8`. The gate opens with half a segment, which
drains immediately and re-pauses. The proposal (`MIN_LEAD=HLSTIME`,
`RESUME_LEAD=HLSTIME*3`) is right.

### 1.4 Threads — PARTLY TRUE, benefit overstated

`:238` sets `-threads 1` per output; two outputs plus `-filter_threads 1` share
2 cores. Measured, two simultaneous encodes (240p + 360p, medium, CRF 27):

```
current  -threads 1 x2 + -filter_threads 1   5.83x realtime
proposed -threads 0 x2 (auto)                6.79x realtime
middle   -threads 1 x2, no filter limit      6.06x realtime
```

**+16%, not a starvation emergency.** The realtime risk is genuine on a slower
box, but this is a tuning improvement, not a fix for a hang. Worth doing; do not
describe it as rescuing playback.

### 1.5 `-readrate_initial_burst` is inert — TRUE

`:249` passes the flag while `-readrate` is deliberately never set (the comment
at `:243` explains why). The flag only configures the burst of a limiter that is
not active, so it does nothing and the comment claiming it "lets a seek refill
the gap immediately" is false. Safe to delete.

### 1.6 Governor flutter — TRUE

`playback.ts:678` uses a single `buffered < 6` threshold. At a steady 6 s it
toggles 0.92x/1.0x every second. Hysteresis (engage < 5, release > 9) is right.

---

## Track 2 — subtitles: CONFIRMED, the most serious finding

This is the one I would fix first, and it is not in any earlier audit.

- `/caption/` (`server.js:334`) returns the stored text **untouched**.
- There is **no** `VTTCue`, `textTracks` or cue iteration anywhere in
  `reelbox-src/src/` — confirmed by search. The track is attached and the browser
  plays it at whatever times the provider authored.
- Provider captions are authored against the **full timeline**. A converted
  window starts at 0 because `-ss` is an input seek. Nothing reconciles the two.

Consequences, both real: inside a window the cues fire up to `offset` seconds
early or late; after a restart the window resets to 0 while the cues stay
absolute, so subtitles vanish until the window catches up.

The two state bugs are also true:

- `clearSubtitleEl()` (`:427`) sets `subtitleActive = false`, and `loadSubtitle`
  (`:378-379`) resets `this.subtitle`. The viewer's on-state dies on every seek
  restart and every failover.
- `start()` clears the old track only when `loadSubtitle` runs, which is after the
  job resolves — so the previous window's cues keep firing behind the overlay.

Server-side shifting keyed to the window is the correct shape: doing it in the
browser races the track load and cannot work on the native-HLS path.

### A sixth bug the prompt missed

`server.js:334` sends **no ETag and no `Last-Modified`**, only
`no-store`. If the subtitle URL gains a `?from=` query and anything upstream
caches it, revalidation is not even possible. Minor, but it belongs in the same
change.

### Incorrect in the prompt

> "the ::cue rules remain in tokens.css"

`tokens.css` was in the deleted classic player and does not exist. There are **no**
`::cue` rules in the current app at all, and no subtitle size/colour/height
controls — so this is a *missing feature*, not dead styling. The README sentence
about retiming is likewise false today and should be replaced, not corrected.

---

## Track 3 — encode quality: CONFIRMED and measurable, with three defects

### The premise holds

`ultrafast` + `zerolatency` + `baseline` does disable CABAC, deblocking, 8x8dct,
B-frames, mbtree and sets `rc-lookahead=0`. Measured on a 640x360 encode of a
1280x720 source, against the source:

| config | bitrate | SSIM | speed |
|---|---|---|---|
| current `ultrafast+zerolatency+baseline` @420k | 558 kbps | 0.9842 | 18.2x |
| proposed `medium+high+crf27` @maxrate 500k | **358 kbps** | **0.9912** | 8.6x |
| `veryfast+main+crf27` (fallback) | 328 kbps | — | 13.3x |

**Better quality at 36% fewer bits.** The prompt's direction is right and its
numbers are close. Note 8.6x realtime at 360p on this 2-core box: `medium` is
affordable, and the "1.5x realtime" gate it sets is generous rather than tight.

### 3.3 `-profile:a aac_he` — FALSE, it fails

Verified against the packaged FFmpeg:

```
[aac] Profile not supported!                      (native aac)
[libfdk_aac] Unable to set the AOT 5: Invalid config   (libfdk)
```

HE-AAC at 48 kHz is not encodable here; `aac_he_v2` fails identically. Applying
this literally makes **every transcode fail at startup**. Either drop the audio
change or move to 32 kHz LC — which is the frequency HE-AAC is designed for
anyway. The existing `-b:a 32k`/`48k` LC is already fine for speech-heavy
material.

### 3.4 fMP4 — the escape is right, the flag is wrong

The write-up says five places must change together; there are **four** in
`transcode.js` (`:286`, `:316`, `:365`, `:395`) plus the route regex and the
`immutable` decision in `server.js`. Get any of them wrong and the throttle reads
0 while the byte cap stops working — the warning is correct and important.

But `-hls_fmp4_init_filename ${dir}/init.mp4` **fails**:

```
[hls] Failed to open segment '/tmp/fmp4/init.mp4'
```

The init filename is resolved relative to the playlist, not the filesystem. It
must be `init.mp4`. Also `-hls_time 4` is not honoured for fMP4 without
`-force_key_frames`, which the current args do pass — keep it.

Measured benefit: **315 → 282 kbps at equal quality**, about 10%, slightly
better than the "5-8%" claimed.

### 3.5 CODECS — correct

`avc1.64001f` is High profile (100 = 0x64), constraint 0x00, level 3.1 (31 =
0x1f). Confirmed against the SPS the encoder emits (`profile_idc: 100`,
`constraint: 00`, `level_idc: 31`).

### A defect the prompt did not mention

Switching to `-profile:v high` silently breaks the **hardware path**. It is
guarded by the `h264_rkmpp` branch today, but the comment at `:238` says the
branch exists for `/dev/mpp_service` boxes. If the guard ever regresses, High
profile will fail there. Worth an explicit test that the rkmpp branch never
receives `-profile:v high` or `-crf`.

---

## Where the prompt's process instructions are wrong

1. **"`test.js` (how the engine tests fake a job)" and "Look at how this repo
   already fakes a video element … in test.js"** — there is no video element in
   `test.js`. The client harness is `reelbox-src/tools/engine-check.mjs`, in a
   different package with a different runner. Following this literally means
   adding a DOM fake to the server suite.

2. **"BUILD AND PUBLISH: `npm run build && node tools/publish.mjs`"** —
   `npm run build` already runs the publish step (it prints
   `published 3 entries`). Running `publish.mjs` again is harmless but duplicated.

3. **"Restart the server … test-shell.js checks the hashes"** — `test-shell.js`
   reads the shell file and computes hashes; it does not compare against a *live*
   process. The real consequence of a stale shell is that the running server's CSP
   no longer matches its own inline scripts.

4. **"Test count must not fall"** — a reasonable guard, but the suite has 12
   `# SKIP` entries that depend on a packaged FFmpeg. Confirm they are running
   before claiming the count.

5. The **research-first** framing asks for upstream/primary sources for FFmpeg
   flag semantics. That is right in principle: the two flag errors above (3.3 and
   3.4) are exactly what reading the FFmpeg HLS/AAC documentation or testing once
   would have caught, and both would have shipped a broken transcode.

---

## What I would do, in order

1. **1.1 + 1.2 + 1.3** — one commit. They are all in `status()`/`measure()`/
   readiness and together they are the reported "stuck after seeking" bug. Highest
   value by a wide margin.
2. **Track 2** — one commit. Biggest user-visible defect, cleanly isolatable
   (new file + one route + one client path), and the `?from=` parameter is the only
   cross-boundary change.
3. **1.4, 1.5, 1.6** — small, safe, no behaviour risk. Fold into whichever commit
   is nearest.
4. **3.1, 3.2, 3.5** — one commit. Measured win, one line changed, no new failure
   mode.
5. **3.4 fMP4** — separate commit, and only with the four-place regex escape
   tested first. ~10% of bytes, real risk of a silent throttle regression.
6. **3.3 audio** — drop it, or change to 32 kHz LC after testing. As written it
   breaks all playback.
7. **1.7 `-noaccurate_seek`** — measure after step 1. With 1.1 fixed the seek is
   likely fine, and the flag trades accuracy for speed in a way that needs its own
   verification.

## Honest limits of this assessment

- No seek latency was measured end-to-end: that needs a live provider source and
  a real encode, neither reachable from this sandbox.
- The SSIM numbers come from one synthetic source. A film's grain and gradients
  may respond differently; the direction is solid, the exact figures are not
  transferable.
- Real-time encode ratios were measured on 2 cores. A 1 vCPU panel will be
  several times slower, which makes the `medium` vs `veryfast` decision
  deployment-specific — exactly as the prompt says.

## What was implemented, and where the prescription was corrected

All of the above is now in the code, in one change. Where implementation found the
prescription wrong, the correction is recorded here rather than followed silently.

| item | what shipped | correction |
|---|---|---|
| 1.1 double offset | `played` is absolute, `watched = played - offset`, `position: played` | the throttle's copy of the same bug had to be fixed too, and it was worse there: with `played` un-removed the throttle never paused, so the encoder could overrun the disk by a whole seek offset |
| 1.2 `counts.every` | readiness opens on the first rung; master playlist lists a rung once it has a segment | this **caused** a new inconsistency: `status` took the minimum across every rung, so a not-yet-listed rung reported zero lead. `status` now counts only the rungs the playlist advertises |
| 1.3 `MIN_LEAD` | `MIN_LEAD = HLSTIME`, `RESUME_LEAD = HLSTIME*3` | — |
| 1.4 threads | `-threads 0` on x264, `-filter_threads` and the input-side `-threads 2` dropped | gain is 5.83x → 6.79x realtime, i.e. **+16%**, not the large factor the prompt implied |
| 1.5 burst flag | removed, along with the startup probe that required it | it was inert, not harmful — but a flag nothing sets is a claim the code does not honour |
| 1.6 governor | engage below 5 s, release above 9 s | — |
| Track 2 | `caption-shift.js`, `?from=` on `/caption/`, client sends the window, track detached at `start()`, on-state preserved | the suggested shift algorithm leaves the **cue identifier** orphaned when it drops a cue behind the window, which some players render as stray text; that is fixed. `clearSubtitleEl` also had to stop resetting `subtitleActive`, and the choice has to be re-applied when the new track arrives — removing the reset alone is not enough |
| 3.1/3.2 x264 | `medium`/`high`/crf27 for 360p, `veryfast`/`main`/crf30 for 240p, explicit `-x264-params`, ceilings 500k/250k | applied to **both** rungs: 240p at crf30 keeps the data-cheap rung cheap (96 → 57 MB/h), which is a product requirement, not an optimisation |
| 3.3 AAC-HE | **not applied** | fails on both `aac` and `libfdk_aac` in the build we ship |
| 3.4 fMP4 | **not applied** | out of scope for this change; the init-path escape and the real count of four regexes were confirmed and are recorded above |
| 3.5 `avc1.64001f` | `avc1.4d401f` (240p) and `avc1.64001f` (360p) | the two rungs now emit genuinely different profiles, so **one CODECS string for both is no longer true**. Both verified by reading the SPS out of a real segment |
| README | the "retimed when browser cue APIs allow it" line replaced; the 433 MB/h figure replaced with measured bytes | the old figure described bitrate targeting that no longer exists |

Measured after the change, on 2 cores, 40 s of 1080p input:

| rung | before | after |
|---|---|---|
| 360p | 491 kbps, 216 MB/h, SSIM 0.9919, 12.1x realtime | 260 kbps, 114 MB/h, SSIM 0.9937, 6.2x realtime |
| 240p | 217 kbps, 96 MB/h, SSIM 0.9844, 13.4x realtime | 130 kbps, 57 MB/h, SSIM 0.9784, 11.5x realtime |

The 360p rung is the one that pays in CPU, and 6.2x realtime still leaves room on
this box. On a 1 vCPU panel that would not hold, which is why the prompt's
`veryfast` fallback matters; the preset is a one-line change at `videoOptions`.
