/**
 * Resolve → convert → play, with the retry ladder the classic player proved on a
 * real phone.
 *
 * The behaviour here is deliberately a port, not a reinterpretation. The
 * original took eleven rounds of field debugging to get right, and each rule
 * below exists because removing it produced a specific, observed failure:
 *
 *  - Converted output is written faster than real time but not instantly, so a
 *    segment that does not exist yet is a wait, not a fatal error. Treating it as
 *    fatal started a fresh conversion, and a fresh conversion starts a new
 *    timeline — which is why playback appeared to jump backwards.
 *  - The server, not the client, decides whether playback may continue
 *    (`canPlay` / `resumeAt`). The client used to infer it and played on until
 *    hls.js threw a stall.
 *  - Position is reported once a second, because a 2 s lead threshold cannot be
 *    governed by a 4 s poll.
 *  - A thin buffer borrows the playback rate instead of stopping; the viewer's
 *    own speed choice is authoritative and is handed back above 20 s buffered.
 *  - When one provider dies, the next one is tried at the same position rather
 *    than from the beginning, and the final message names what was tried.
 *  - A seek beyond the converted portion restarts the conversion at that point.
 */

import Hls from 'hls.js';
import { api, subtitleRequest, type Stream, type TranscodeJob } from './api';

export type Phase =
  | 'idle'
  | 'resolving'
  | 'converting'
  | 'playing'
  | 'buffering'
  | 'failed';

export interface PlaybackTarget {
  /** Catalog entry the stream was resolved from. */
  id: string;
  title: string;
  type?: string;
  /** Provider family, which decides the subtitle endpoint. */
  source?: string;
  season?: number;
  episode?: number;
  /** Where to start, in seconds of the full timeline. */
  startAt?: number;
  /** Progress key for this source; see lib/library.ts. */
  progressKey: string;
}

export interface PlaybackState {
  phase: Phase;
  message: string;
  /** Providers the ladder has reached, in order. */
  tried: string[];
  /** Full-timeline duration, when the source declared one. */
  duration: number | null;
  /** Seconds of the full timeline behind the current window. */
  seekBase: number;
  /** Human-readable summary of what each provider offered. */
  providers: string;
  /** VTT URL for this stream's subtitle, when the provider offered one. */
  subtitleUrl: string | null;
}

/** Subtitle availability for one stream, for the player's captions button. */
export interface SubtitleState {
  /** A track exists and can be switched on. */
  available: boolean;
  /** The track is attached and showing. */
  on: boolean;
  /** Why there is no track, when there isn't one. */
  note: string;
}

export interface PlayerEvents {
  onState: (state: PlaybackState) => void;
  /**
   * Full-timeline position, for resume bookkeeping.
   *
   * `ahead` is seconds of finished output past the playhead -- what the seek bar
   * draws as its second layer. It is not the browser's own buffer: during a
   * conversion the interesting question is how much exists on the server, not how
   * much has been appended locally.
   */
  onProgress: (position: number, duration: number | null, paused: boolean, ahead?: number) => void;
  /** Subtitle availability, which changes per stream rather than per title. */
  onSubtitle?: (state: SubtitleState) => void;
}

const WAITABLE =
  /bufferStalledError|bufferSeekOverHole|fragLoadError|fragLoadTimeOut|levelLoadError|levelLoadTimeOut|manifestLoadError|manifestLoadTimeOut|bufferNudgeOnStall|fragParsingError/;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const newRequestId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (n) => n.toString(16).padStart(2, '0')).join('');

/**
 * Asks Troy for the caption track retimed into the window that starts at `from`.
 *
 * A `<track src>` cannot carry a header, so the offset has to be a query
 * parameter. At `from === 0` the URL is returned unchanged -- the common case,
 * and it keeps the stored URL identical to what the server would have sent
 * anyway.
 */
export function captionUrl(url: string, from: number) {
  if (!(from > 0)) return url;
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}from=${encodeURIComponent(from.toFixed(3))}`;
}

/** Doubles as the sink for the audio/video element the UI renders. */
export class Playback {
  private video: HTMLVideoElement | null = null;
  private hls: Hls | null = null;
  private events: PlayerEvents;
  private target: PlaybackTarget | null = null;
  private streams: Stream[] = [];
  private streamIndex = 0;
  private job: TranscodeJob | null = null;
  private requestId: string | null = null;
  private seekBase = 0;
  private duration: number | null = null;
  private timer: number | null = null;
  private recoveryTimer: number | null = null;
  private generation = 0;
  private waiting = false;
  /** Seconds of converted output past the playhead, from the last status poll. */
  private leadAhead = 0;
  private pausedByViewer = false;
  private attemptedSeek = false;
  private subtitle: SubtitleState = { available: false, on: false, note: '' };
  private subtitleEl: HTMLTrackElement | null = null;
  private subtitleActive = false;
  private state: PlaybackState = {
    phase: 'idle',
    message: '',
    tried: [],
    duration: null,
    seekBase: 0,
    providers: '',
    subtitleUrl: null,
  };

  constructor(events: PlayerEvents) {
    this.events = events;
  }

  attach(video: HTMLVideoElement | null) {
    if (this.video === video) return;
    this.teardownVideo();
    this.video = video;
    if (video) {
      video.addEventListener('play', this.onPlay);
      video.addEventListener('pause', this.onPause);
      video.addEventListener('ended', this.onEnded);
    }
  }

  private onPlay = () => {
    this.pausedByViewer = false;
  };

  private onPause = () => {
    // A pause the governor itself requested is not the viewer's choice.
    if (!this.waiting) this.pausedByViewer = true;
  };

  private onEnded = () => {
    if (this.target) this.events.onProgress(this.totalDuration(), this.duration, true);
  };

  private teardownVideo() {
    const video = this.video;
    if (!video) return;
    video.removeEventListener('play', this.onPlay);
    video.removeEventListener('pause', this.onPause);
    video.removeEventListener('ended', this.onEnded);
    this.video = null;
  }

  private set(patch: Partial<PlaybackState>) {
    this.state = { ...this.state, ...patch };
    this.events.onState(this.state);
  }

  getState() {
    return this.state;
  }

  /** Full-timeline position: the current window's base plus the element's clock. */
  totalTime() {
    return this.seekBase + (this.video?.currentTime || 0);
  }

  totalDuration() {
    if (this.duration) return this.duration;
    const video = this.video;
    if (!video) return 0;
    if (Number.isFinite(video.duration)) return this.seekBase + video.duration;
    try {
      return video.seekable.length ? this.seekBase + video.seekable.end(video.seekable.length - 1) : 0;
    } catch {
      return 0;
    }
  }

  pause() {
    this.pausedByViewer = true;
    this.video?.pause();
  }

  play() {
    this.pausedByViewer = false;
    void this.video?.play().catch(() => {});
  }

  toggle() {
    if (this.video?.paused) this.play();
    else this.pause();
  }

  /** Jumps within the converted window, or restarts the conversion past its end. */
  seek(target: number) {
    const video = this.video;
    if (!video || !Number.isFinite(target)) return;
    const duration = this.totalDuration();
    if (duration <= 0) {
      video.currentTime = Math.max(0, target);
      return;
    }
    const clamped = Math.max(0, Math.min(Math.max(0, duration - 1), target));
    const relative = clamped - this.seekBase;
    let available = Number.isFinite(video.duration) ? video.duration : 0;
    try {
      for (let i = 0; i < video.seekable.length; i++) {
        if (relative >= video.seekable.start(i) && relative < video.seekable.end(i) - 0.1) {
          video.currentTime = relative;
          return;
        }
        available = Math.max(available, video.seekable.end(i));
      }
    } catch {
      /* seekable can throw before metadata loads */
    }
    if (relative >= 0 && Number.isFinite(video.duration) && relative < available - 0.1) {
      video.currentTime = relative;
      return;
    }
    if (!this.duration) {
      this.set({ message: 'This source has no usable duration for seeking beyond the converted video.' });
      return;
    }
    // Past the converted portion: the only honest answer is a new conversion.
    this.attemptedSeek = true;
    void this.start(this.target!, clamped);
  }

  private lead(phase: Phase, message: string) {
    this.set({ phase, message });
  }

  /** Tears down everything and starts from a fresh resolve. */
  async stop() {
    this.generation++;
    this.stopTimer();
    this.clearSubtitleEl();
    this.subtitle = { available: false, on: false, note: '' };
    this.hls?.destroy();
    this.hls = null;
    const video = this.video;
    if (video) {
      video.pause();
      video.removeAttribute('src');
      video.load();
    }
    const pending = this.requestId;
    const job = this.job;
    this.requestId = null;
    this.job = null;
    this.target = null;
    this.streams = [];
    if (pending) void api.cancelTranscode(pending).catch(() => {});
    if (job) void api.stopTranscode(job.id).catch(() => {});
    this.set({ phase: 'idle', message: '', tried: [], providers: '', duration: null, seekBase: 0 });
  }

  async start(target: PlaybackTarget, startAt?: number) {
    const generation = ++this.generation;
    this.stopTimer();
    // The old track is relative to the old window, so it must go now rather than
    // when the new one arrives: `start` can take tens of seconds waiting for a
    // conversion, and cues from the previous seek point would otherwise keep
    // firing over the new picture. `subtitleActive` is deliberately *not* cleared
    // here, so the viewer's choice survives the restart.
    this.clearSubtitleEl();
    this.hls?.destroy();
    this.hls = null;
    this.job = null;
    this.target = target;
    this.seekBase = startAt ?? target.startAt ?? 0;
    this.duration = null;
    this.attemptedSeek = false;
    this.streams = [];
    this.streamIndex = 0;
    this.subtitle = { available: false, on: false, note: '' };
    this.set({
      phase: 'resolving',
      message: 'Looking for a stream…',
      tried: [],
      providers: '',
      duration: null,
      seekBase: this.seekBase,
      subtitleUrl: null,
    });

    const season = target.season ?? 1;
    const episode = target.episode ?? 1;
    try {
      const resolved = await api.resolve(target.id, season, episode);
      if (generation !== this.generation) return;
      const unsupported = resolved.streams.filter((s) => s.format === 'hls');
      // HLS *input* cannot be converted; the machine only converts direct files.
      this.streams = resolved.streams.filter((s) => s.format !== 'hls');
      const providers = [
        ...resolved.providers.map((p) => `${p.provider}: ${p.count ? `${p.count} stream(s)` : p.error || 'no streams'}`),
        ...(unsupported.length ? [`${unsupported.length} HLS source(s) cannot be converted`] : []),
      ].join(' · ');
      this.set({ providers });
      if (!this.streams.length) {
        this.set({
          phase: 'failed',
          message: unsupported.length
            ? 'Only HLS sources were found; HLS input conversion is not supported.'
            : 'No playable streams found for this title or episode.',
        });
        return;
      }
      await this.playStream(0, generation);
    } catch (error: any) {
      if (generation !== this.generation) return;
      this.set({ phase: 'failed', message: error?.message || 'Could not find a stream' });
    }
  }

  /**
   * One rung of the ladder: make the source a handled URL, convert it, attach the
   * playlist. `wasPaused` carries the viewer's state across a retry so a
   * failover does not start playing behind a pause.
   */
  private async playStream(index: number, generation: number) {
    const stream = this.streams[index];
    const target = this.target;
    if (!stream || !target) return;
    this.streamIndex = index;
    const wasPaused = this.pausedByViewer;
    this.lead('converting', this.seekBase > 0 ? 'Seeking: preparing conversion at the selected point…' : 'Preparing 240p / 360p conversion…');
    this.set({ tried: [...new Set([...this.state.tried, stream.provider])] });

    try {
      const requestId = newRequestId();
      this.requestId = requestId;
      let job: TranscodeJob;
      try {
        job = await api.transcode(stream.url, this.seekBase, requestId);
      } finally {
        if (this.requestId === requestId) this.requestId = null;
      }
      if (generation !== this.generation) {
        void api.stopTranscode(job?.id).catch(() => {});
        return;
      }
      if (
        !job ||
        typeof job.id !== 'string' ||
        !/^[A-Za-z0-9_-]+$/.test(job.id) ||
        job.url !== `/transcode/${job.id}/master.m3u8`
      ) {
        if (typeof job?.id === 'string' && /^[A-Za-z0-9_-]+$/.test(job.id)) {
          void api.stopTranscode(job.id).catch(() => {});
        }
        throw new Error('Invalid conversion response');
      }
      this.job = job;
      this.duration = Number.isFinite(job.duration) && job.duration! > 0 ? job.duration! : null;
      // Subtitle availability belongs to the stream, not the title: failing over
      // to another provider means asking that provider for its own caption.
      void this.loadSubtitle(stream, target, generation);
      this.set({ seekBase: this.seekBase, duration: this.duration });
      this.attachPlaylist(job, wasPaused, generation);
    } catch (error: any) {
      if (generation !== this.generation) return;
      await this.failOver(index, generation, error?.message || 'Conversion failed');
    }
  }

  /**
   * Fetches this stream's subtitle and attaches it as a <track>.
   *
   * The URL Troy returns is session-scoped and expires, so it is fetched per
   * playback rather than stored with the title. A provider that has no caption
   * is the normal case, not an error: it says so and the button stays disabled
   * instead of offering a track that would never load.
   */
  private async loadSubtitle(stream: Stream, target: PlaybackTarget, generation: number) {
    this.clearSubtitleEl();
    this.subtitle = { available: false, on: false, note: '' };
    const request = subtitleRequest(stream.provider, stream, target.source, {
      id: target.id,
      season: target.season ?? 1,
      episode: target.episode ?? 1,
    });
    if (!request) {
      this.subtitle = { available: false, on: false, note: 'This source has no subtitles.' };
      this.publishSubtitle();
      return;
    }
    try {
      const result = await api.subtitle(request.path, request.data);
      if (generation !== this.generation) return;
      if (!result?.url) {
        this.subtitle = { available: false, on: false, note: 'This source has no subtitles.' };
        this.publishSubtitle();
        return;
      }
      const video = this.video;
      if (!video) return;
      const el = document.createElement('track');
      el.kind = 'subtitles';
      el.label = 'English (provider)';
      el.srclang = 'en';
      // Provider captions are timed against the whole film; a converted window
      // starts near zero at `seekBase`. Without `from` every cue fires offset
      // seconds early, and cues behind the window fire all at once on load.
      el.src = captionUrl(result.url, this.seekBase);
      // Not `default`: the viewer asked for a clean picture until they say
      // otherwise, and an autoplaying caption track is a surprise on a phone.
      el.track.mode = 'hidden';
      video.append(el);
      this.subtitleEl = el;
      // Re-apply the choice made on a previous window; `hidden` only wins when the
      // viewer has never asked for captions.
      el.track.mode = this.subtitleActive ? 'showing' : 'hidden';
      this.subtitle = { available: true, on: this.subtitleActive, note: '' };
      this.set({ subtitleUrl: el.src });
      this.publishSubtitle();
    } catch (error: any) {
      if (generation !== this.generation) return;
      this.subtitle = { available: false, on: false, note: error?.message || 'Subtitles unavailable.' };
      this.publishSubtitle();
    }
  }

  private publishSubtitle() {
    this.events.onSubtitle?.(this.subtitle);
  }

  /**
   * Detaches the <track> element. `subtitleActive` is the viewer's preference and
   * outlives the element: resetting it here is what made subtitles turn
   * themselves off whenever a seek restarted the conversion or a stream failed
   * over, so the button had to be pressed again after every hiccup.
   */
  private clearSubtitleEl() {
    this.subtitleEl?.remove();
    this.subtitleEl = null;
  }

  /** Switches the attached track on or off. Returns the new state. */
  toggleSubtitle(): SubtitleState {
    if (this.subtitleEl) {
      this.subtitleActive = !this.subtitleActive;
      this.subtitleEl.track.mode = this.subtitleActive ? 'showing' : 'hidden';
    }
    this.subtitle = { ...this.subtitle, on: this.subtitleActive && !!this.subtitleEl };
    this.publishSubtitle();
    return this.subtitle;
  }

  subtitleState() {
    return this.subtitle;
  }

  private attachPlaylist(job: TranscodeJob, wasPaused: boolean, generation: number) {
    const video = this.video;
    if (!video) return;
    const outputUrl = job.url;
    this.set({
      phase: 'playing',
      message: this.duration
        ? 'Seeking to an unconverted point restarts conversion and may take time.'
        : 'Duration unavailable: seeking is limited to the converted portion.',
    });

    if (!Hls.isSupported()) {
      // Native HLS (Safari) takes the single variant the quality picker selects.
      video.src = outputUrl.replace('master.m3u8', `${this.quality}/index.m3u8`);
      if (!wasPaused) void video.play().catch(() => {});
      return;
    }

    const hls = new Hls({
      // `startLevel` is an index into the provider's level list, not ours, and a
      // network estimate can move it again. The quality is therefore pinned by
      // height once the manifest is parsed (see MANIFEST_PARSED below), which is
      // also what makes "240p" mean 240p rather than "whatever ABR chose".
      startLevel: 0,
      startPosition: 0,
      liveDurationInfinity: false,
      // Buffering targets sized for a playlist produced just ahead of playback,
      // not for a live edge: 120/240 held two to four minutes of media and fought
      // the encoder for no benefit. Segments are immutable and re-fetchable.
      maxBufferLength: 24,
      maxMaxBufferLength: 48,
      backBufferLength: 8,
      maxBufferHole: 0.5,
      highBufferWatchdogPeriod: 4,
      nudgeOffset: 0.1,
      nudgeMaxRetry: 60,
      appendErrorMaxRetry: 10,
      fragLoadPolicy: policy(40, 20000, 180000),
      playlistLoadPolicy: policy(20, 15000, 60000),
      manifestLoadPolicy: policy(10, 15000, 60000),
    });
    this.hls = hls;
    hls.loadSource(outputUrl);
    hls.attachMedia(video);

    let recoveredAppend = false;
    const pinLevel = () => {
      // Choose the rung the viewer asked for. A missing rung means a ladder of
      // one, in which case there is nothing to choose.
      const index = hls.levels.findIndex((level) => level.height === this.quality);
      if (index >= 0) hls.currentLevel = index;
    };
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      if (generation !== this.generation || this.hls !== hls) return;
      pinLevel();
      this.startTimer();
      if (!wasPaused) void video.play().catch(() => {});
    });
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (!data.fatal || generation !== this.generation || this.hls !== hls) return;
      if (WAITABLE.test(data.details || '')) {
        // The encoder is behind the player. Wait; do not restart.
        this.set({ phase: 'buffering', message: 'Buffering: the conversion is behind the player; it will resume on its own.' });
        hls.startLoad?.(-1);
        // Tracked, because this fires after a delay: a player that has been
        // navigated away from must not be told to play 1.2 s later.
        if (this.recoveryTimer !== null) clearTimeout(this.recoveryTimer);
        this.recoveryTimer = window.setTimeout(() => {
          this.recoveryTimer = null;
          if (generation === this.generation && this.video && !this.video.paused) {
            void this.video.play().catch(() => {});
          }
        }, 1200);
        return;
      }
      if (!recoveredAppend && data.details === 'bufferAppendError' && typeof hls.recoverMediaError === 'function') {
        recoveredAppend = true;
        hls.recoverMediaError();
        hls.startLoad?.();
        return;
      }
      void this.conversionFailed(generation);
    });
  }

  /** One automatic retry at the same position, then the next provider. */
  private async conversionFailed(generation: number) {
    if (generation !== this.generation || !this.target) return;
    const job = this.job;
    const position = this.totalTime();
    const paused = this.pausedByViewer || !!this.video?.paused;
    let message = 'Converted playback failed.';
    try {
      const status = job ? await api.transcodeStatus(job.id, position) : null;
      if (status?.error) message = status.error;
    } catch {
      /* the retry below is still worth attempting */
    }
    if (generation !== this.generation) return;
    if (!this.attemptedSeek) {
      this.attemptedSeek = true;
      this.pausedByViewer = paused;
      this.set({ message: 'Playback interrupted; retrying this source…' });
      void this.start({ ...this.target, startAt: position }, position);
      return;
    }
    await this.failOver(this.streamIndex, generation, message);
  }

  private async failOver(index: number, generation: number, reason: string) {
    if (generation !== this.generation) return;
    const next = index + 1;
    if (next < this.streams.length) {
      const paused = this.pausedByViewer || !!this.video?.paused;
      this.pausedByViewer = paused;
      this.set({ message: `${reason} Trying the next source…` });
      this.hls?.destroy();
      this.hls = null;
      this.attemptedSeek = false;
      this.seekBase = this.seekBase; // keep the position across the failover
      await this.playStream(next, generation);
      return;
    }
    const tried = this.state.tried.join(', ');
    this.set({
      phase: 'failed',
      message: `${reason} No source could be played. Tried ${this.state.tried.length} source${
        this.state.tried.length === 1 ? '' : 's'
      } from ${tried} (${this.streams.map((s) => s.format).join(', ')}).`,
    });
  }

  quality = 240;

  /**
   * The rung the player should download.
   *
   * This has to be set before playback and re-applied on every new HLS instance,
   * because a seek past the converted window and a failover both build one. It
   * was previously only written when the viewer opened the settings menu, so the
   * saved choice was ignored on load and the stream ran at whatever the
   * bandwidth estimate picked — twice the data, for a picture an inch bigger.
   */
  setQuality(height: number) {
    this.quality = height;
    if (this.hls) {
      // The conversion only produces 240 and 360, so a level is chosen by height
      // and never by index: the index order is the provider's, not ours.
      const index = this.hls.levels.findIndex((level) => level.height === height);
      if (index >= 0) this.hls.currentLevel = index;
      return;
    }
    const video = this.video;
    if (video && this.job) {
      const paused = video.paused;
      const time = video.currentTime;
      video.addEventListener(
        'loadedmetadata',
        () => {
          if (Number.isFinite(time) && time <= video.duration) video.currentTime = time;
        },
        { once: true },
      );
      video.src = `/transcode/${this.job.id}/${height}/index.m3u8`;
      video.load();
      if (!paused) void video.play().catch(() => {});
    }
  }

  private startTimer() {
    this.stopTimer();
    this.report();
    this.timer = window.setInterval(() => {
      this.governRate();
      this.report();
    }, 1000);
  }

  private stopTimer() {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.recoveryTimer !== null) {
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = null;
    }
    this.waiting = false;
  }

  private report() {
    const job = this.job;
    const video = this.video;
    if (!job || !video) return;
    const position = this.totalTime();
    this.events.onProgress(position, this.duration, this.pausedByViewer || video.paused, this.leadAhead);
    void api
      .transcodeStatus(job.id, position)
      .then(async (status) => {
        if (!status || typeof status.canPlay !== 'boolean') return;
        this.leadAhead = typeof status.ahead === 'number' && Number.isFinite(status.ahead) ? Math.max(0, status.ahead) : 0;
        if (!status.canPlay && !video.paused && !this.waiting) {
          // The server owns the verdict: stop, and ask again until it says yes.
          this.waiting = true;
          video.pause();
          this.set({ message: 'Catching up with the conversion…' });
          while (this.waiting) {
            await sleep(1000);
            if (!this.job || this.job.id !== job.id) break;
            const next = await api.transcodeStatus(job.id, position).catch(() => null);
            if (next?.canPlay && next.resumeAt) {
              this.waiting = false;
              this.set({ message: '' });
              void video.play().catch(() => {});
              return;
            }
          }
          this.waiting = false;
        } else if (status.canPlay && this.state.message.startsWith('Catching up')) {
          this.set({ message: '' });
        }
      })
      .catch(() => {});
  }

  /**
   * Borrows the playback rate when the buffer is thin rather than stopping.
   * `preservesPitch` is on by default, so 0.92× costs nothing audible.
   */
  private governRate() {
    const video = this.video;
    if (!video || video.paused || this.waiting || !video.buffered.length) return;
    const buffered = video.buffered.end(video.buffered.length - 1) - video.currentTime;
    const chosen = this.userRate || 1;
    // Two thresholds, not one. A single `buffered < 6` test flips 0.92x and 1.0x
    // every second whenever the buffer sits at almost exactly six seconds, which
    // is audible as a stutter and was the reported "rate keeps changing".
    if (this.slowed && buffered > 9) this.slowed = false;
    else if (!this.slowed && buffered < 5) this.slowed = true;
    const target = this.slowed ? Math.min(chosen, 0.92) : chosen;
    if (Math.abs((video.playbackRate || 1) - target) > 0.01) video.playbackRate = target;
  }

  /** Set while the buffer is thin, so the governor does not oscillate. */
  private slowed = false;

  userRate = 1;

  setRate(rate: number) {
    this.userRate = rate;
    if (this.video) this.video.playbackRate = rate;
  }
}

function policy(retries: number, firstByte: number, maxLoad: number) {
  const retry = () => ({
    maxNumRetry: retries,
    retryDelayMs: 1000,
    maxRetryDelayMs: 8000,
    backoff: 'exponential' as const,
  });
  return { default: { maxTimeToFirstByteMs: firstByte, maxLoadTimeMs: maxLoad, timeoutRetry: retry(), errorRetry: retry() } };
}
