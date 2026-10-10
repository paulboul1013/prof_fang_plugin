(() => {
  const READY_FLAG = "__PROF_FANG_TRAINER_READY__";

  function announceReady() {
    window.postMessage({ source: "PROF_FANG_TRAINER", type: "TRAINER_READY" }, "*");
  }

  // A timeout retry can load the file while an earlier injection finishes.
  if (window[READY_FLAG]) {
    announceReady();
    return;
  }

  const MODES = {
    OFF: "off",
    SPEED: "speed",
    BLUR: "gaussian",
    NOISE: "noise"
  };

  // Gaussian blur strength 1 (light) to 5 (heavy), as the -3 dB cutoff in Hz.
  // A Gaussian low-pass keeps vowels and rhythm but removes consonant detail
  // ("s", "f", "th") smoothly, without the resonance or ringing of a biquad.
  const BLUR_LEVELS = { 1: 4000, 2: 2800, 3: 2000, 4: 1400, 5: 900 };
  // Removing high frequencies lowers loudness; compensate a little (≤ +2.3 dB)
  // so users do not raise the volume and get a jump when blur turns off.
  const BLUR_MAKEUP_GAIN = { 1: 1, 2: 1.06, 3: 1.12, 4: 1.2, 5: 1.3 };
  const DEFAULT_BLUR_LEVEL = 3;
  // Settings saved before the Gaussian blur mode used Low-Pass presets.
  const LEGACY_LOWPASS_LEVELS = { light: 1, medium: 3, heavy: 5 };
  // Gain changes settle in about 3 time constants (~30 ms), which avoids clicks.
  const FADE_TIME_CONSTANT = 0.01;
  // A faded chain is silent (< -80 dB) well before this, then disconnected.
  const FADE_RELEASE_MS = 200;

  const DEFAULT_STATE = {
    enabled: false,
    mode: "speed",
    speed: 1,
    blurLevel: DEFAULT_BLUR_LEVEL,
    noiseFile: "People Talking Ambience Sound Effect.mp3",
    noiseUrl: "",
    noiseVolume: 0.3
  };

  // Chrome can leave resume() pending until the user interacts with the page.
  // Report that as waiting for a gesture instead of never answering; the
  // statechange listener retries once the context actually runs.
  const RESUME_WAIT_MS = 1000;

  const graphMap = new WeakMap();
  let latestState = null;
  let currentVideo = null;
  let operationRevision = 0;
  let pageActive = true;
  let needsAudioRetry = false;
  // Every status report is tagged with the newest request so the content
  // script can discard results that belong to an older popup action.
  let latestRequestId = null;

  function findVideo() {
    return document.querySelector("video");
  }

  // A sampled Gaussian impulse response. Its frequency response is also
  // Gaussian: H(f) = exp(-f² / (2σf²)), with H(cutoff) = -3 dB.
  function gaussianKernel(sampleRate, cutoffHz) {
    const sigmaSeconds = Math.sqrt(Math.LN2) / (2 * Math.PI * cutoffHz);
    const sigma = sigmaSeconds * sampleRate;
    const radius = Math.max(1, Math.ceil(4 * sigma));
    const kernel = new Float32Array(radius * 2 + 1);
    let sum = 0;
    for (let i = 0; i < kernel.length; i += 1) {
      const x = i - radius;
      kernel[i] = Math.exp(-(x * x) / (2 * sigma * sigma));
      sum += kernel[i];
    }
    // Unity gain at 0 Hz, so low frequencies keep their level.
    for (let i = 0; i < kernel.length; i += 1) {
      kernel[i] /= sum;
    }
    return kernel;
  }

  function ensureGraph(video) {
    const cached = graphMap.get(video);
    if (cached) {
      return cached;
    }

    const audioContext = new window.AudioContext();
    const source = audioContext.createMediaElementSource(video);
    const inputGain = audioContext.createGain();
    const mixGain = audioContext.createGain();
    // The dry path is the original audio. Blur is a parallel wet path, so
    // turning it on or off is a crossfade instead of a disconnect.
    const dryGain = audioContext.createGain();

    source.connect(inputGain);
    inputGain.connect(dryGain);
    dryGain.connect(mixGain);
    mixGain.connect(audioContext.destination);

    const kernelBuffers = new Map();
    let activeLevel = null;
    let activeChain = null;
    const fadingChains = new Set();

    function fadeTo(param, value) {
      const now = audioContext.currentTime || 0;
      param.cancelScheduledValues(now);
      param.setValueAtTime(param.value, now);
      param.setTargetAtTime(value, now, FADE_TIME_CONSTANT);
    }

    function kernelBuffer(level) {
      if (!kernelBuffers.has(level)) {
        const kernel = gaussianKernel(audioContext.sampleRate, BLUR_LEVELS[level]);
        const buffer = audioContext.createBuffer(1, kernel.length, audioContext.sampleRate);
        buffer.getChannelData(0).set(kernel);
        kernelBuffers.set(level, buffer);
      }
      return kernelBuffers.get(level);
    }

    function createChain(level) {
      const convolver = audioContext.createConvolver();
      // The kernel is already normalized; Web Audio's own normalization would
      // change its gain.
      convolver.normalize = false;
      convolver.buffer = kernelBuffer(level);
      const gain = audioContext.createGain();
      gain.gain.value = 0;
      inputGain.connect(convolver);
      convolver.connect(gain);
      gain.connect(mixGain);
      return { level, convolver, gain };
    }

    function disconnectChain(chain) {
      inputGain.disconnect(chain.convolver);
      chain.convolver.disconnect();
      chain.gain.disconnect();
    }

    function fadeOut(chain) {
      fadeTo(chain.gain.gain, 0);
      fadingChains.add(chain);
      clearTimeout(chain.releaseTimer);
      chain.releaseTimer = setTimeout(() => {
        if (fadingChains.delete(chain)) {
          disconnectChain(chain);
        }
      }, FADE_RELEASE_MS);
    }

    function revive(level) {
      for (const chain of fadingChains) {
        if (chain.level === level) {
          fadingChains.delete(chain);
          clearTimeout(chain.releaseTimer);
          return chain;
        }
      }
      return null;
    }

    // level: 1-5 for Gaussian blur, or null for the original audio.
    function setBlur(level) {
      if (level === activeLevel) {
        return;
      }
      if (activeChain) {
        fadeOut(activeChain);
        activeChain = null;
      }
      if (level) {
        // Reapplying a level (cleanup, then apply) brings the chain that just
        // started to fade back up instead of starting a new one.
        activeChain = revive(level) || createChain(level);
        fadeTo(activeChain.gain.gain, BLUR_MAKEUP_GAIN[level]);
        fadeTo(dryGain.gain, 0);
      } else {
        fadeTo(dryGain.gain, 1);
      }
      activeLevel = level;
    }

    const graph = {
      audioContext,
      setBlur
    };

    graphMap.set(video, graph);
    audioContext.addEventListener("statechange", () => {
      if (audioContext.state === "running") {
        retryAudio(video);
      }
    });
    return graph;
  }

  function createNoiseController() {
    const events = ["play", "pause", "ended", "volumechange"];
    let owner = null;
    let ownerRevision = 0;
    let player = null;
    let noiseUrl = "";
    let noiseVolume = DEFAULT_STATE.noiseVolume;
    let playRevision = 0;
    let pendingPlay = null;
    let onPlayerError = null;

    function isActive() {
      return owner && latestState?.enabled && latestState.mode === MODES.NOISE &&
        isCurrentOperation(ownerRevision, owner);
    }

    function videoVolume() {
      const volume = Number(owner?.volume);
      return Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 1;
    }

    function shouldPlay() {
      return isActive() && !owner.paused && !owner.ended && !owner.muted &&
        noiseVolume > 0 && videoVolume() > 0;
    }

    function pausePlayer(target, reset = false) {
      target.pause();
      if (reset) {
        target.currentTime = 0;
      }
    }

    function releasePlayer() {
      playRevision += 1;
      pendingPlay = null;
      const previous = player;
      player = null;
      if (previous) {
        previous.removeEventListener("error", onPlayerError);
        pausePlayer(previous, true);
      }
      onPlayerError = null;
    }

    function stop() {
      if (owner) {
        for (const event of events) {
          owner.removeEventListener(event, onVideoStateChange);
        }
      }
      owner = null;
      noiseUrl = "";
      releasePlayer();
    }

    function ensurePlayer() {
      if (!player) {
        const next = new Audio(noiseUrl);
        next.loop = true;
        next.preload = "auto";
        player = next;
        onPlayerError = () => {
          if (player !== next || !isActive()) {
            return;
          }
          releasePlayer();
          reportStatus(failed("noise-media-failed", next.error));
        };
        next.addEventListener("error", onPlayerError);
      }
      return player;
    }

    function isCurrentPlay(request) {
      return pendingPlay === request && player === request.player &&
        playRevision === request.revision && isActive();
    }

    function clearObsoletePlay(request) {
      // Never let an old play settlement pause a newer valid player. Pending
      // players are discarded on pause/OFF so they cannot restart after cleanup.
      if (player !== request.player || !shouldPlay()) {
        pausePlayer(request.player, true);
      }
      return { status: "superseded" };
    }

    async function sync() {
      if (!isActive()) {
        stop();
        return { status: "superseded" };
      }
      if (!shouldPlay()) {
        if (pendingPlay) {
          releasePlayer();
        } else if (player) {
          pausePlayer(player);
        }
        return { status: "applied" };
      }

      const target = ensurePlayer();
      target.volume = noiseVolume * videoVolume();
      if (pendingPlay) {
        return pendingPlay.promise;
      }
      if (!target.paused) {
        return { status: "applied" };
      }

      const request = { player: target, revision: ++playRevision, promise: null };
      pendingPlay = request;
      request.promise = (async () => {
        try {
          await target.play();
          if (!isCurrentPlay(request)) {
            return clearObsoletePlay(request);
          }
          pendingPlay = null;
          if (!shouldPlay()) {
            pausePlayer(target);
          }
          return { status: "applied" };
        } catch (error) {
          if (!isCurrentPlay(request)) {
            return clearObsoletePlay(request);
          }
          pendingPlay = null;
          pausePlayer(target);
          return error?.name === "NotAllowedError"
            ? { status: "waiting-user-gesture", reason: "noise-play-blocked" }
            : failed("noise-play-failed", error);
        }
      })();
      return request.promise;
    }

    function onVideoStateChange(event) {
      if (event.currentTarget !== owner || !isActive()) {
        return;
      }
      const target = owner;
      const revision = ownerRevision;
      const result = sync();
      const noiseRevision = playRevision;
      result.then((status) => {
        if (owner === target && playRevision === noiseRevision && isCurrentOperation(revision, target)) {
          reportStatus(status);
        }
      }).catch((error) => {
        if (owner === target && playRevision === noiseRevision && isCurrentOperation(revision, target)) {
          reportStatus(failed("noise-sync-failed", error));
        }
      });
    }

    async function configure(video, state) {
      stop();
      if (typeof state.noiseUrl !== "string" || !state.noiseUrl) {
        return { status: "failed", reason: "noise-url-missing" };
      }
      owner = video;
      ownerRevision = operationRevision;
      noiseUrl = state.noiseUrl;
      const volume = Number(state.noiseVolume);
      noiseVolume = Number.isFinite(volume) ? Math.max(0, Math.min(0.5, volume)) : DEFAULT_STATE.noiseVolume;
      for (const event of events) {
        owner.addEventListener(event, onVideoStateChange);
      }
      return sync();
    }

    return { configure, stop };
  }

  const noiseController = createNoiseController();

  function disableAll(video, graph) {
    // Noise has one owner independent of the current DOM lookup and audio graph.
    // Clear it even when the old video was already removed from the document.
    noiseController.stop();
    if (graph) {
      graph.setBlur(null);
    }
    if (video) {
      video.playbackRate = 1;
    }
  }

  function detachTarget(video) {
    video.removeEventListener("loadedmetadata", onVideoLoadedMetadata);
    video.removeEventListener("play", onVideoPlay);
    // Keep the media source connected to its dry path. Closing its context
    // would also silence the original video's audio if it is used again.
    disableAll(video, graphMap.get(video));
  }

  function attachTarget(video) {
    currentVideo = video;
    video?.addEventListener("loadedmetadata", onVideoLoadedMetadata);
    video?.addEventListener("play", onVideoPlay);
  }

  function reconcileTarget() {
    const nextVideo = findVideo();
    if (nextVideo === currentVideo) {
      return false;
    }

    operationRevision += 1;
    needsAudioRetry = false;
    const previousVideo = currentVideo;
    currentVideo = null;
    if (previousVideo) {
      detachTarget(previousVideo);
    }
    attachTarget(nextVideo);
    return true;
  }

  function isCurrentOperation(revision, video) {
    return pageActive && revision === operationRevision && currentVideo === video && findVideo() === video;
  }

  function reportStatus(result) {
    if (result.status !== "superseded") {
      needsAudioRetry = result.status === "waiting-user-gesture" && result.reason?.startsWith("audio-context-") === true;
      window.postMessage({
        source: "PROF_FANG_TRAINER",
        type: "TRAINER_STATUS",
        payload: { ...result, requestId: latestRequestId }
      }, "*");
    }
  }

  function reportCurrentResult(promise) {
    const revision = operationRevision;
    promise.then((result) => {
      if (revision === operationRevision) {
        reportStatus(result);
      }
    });
  }

  function onVideoLoadedMetadata(event) {
    if (!latestState || !pageActive || event.currentTarget !== currentVideo || findVideo() !== currentVideo) {
      return;
    }
    // A player can reuse its video element for a new source. Loading metadata
    // can reset playbackRate even though the DOM target's identity is unchanged.
    operationRevision += 1;
    needsAudioRetry = false;
    reportCurrentResult(applyCurrentSettings());
  }

  function onVideoPlay(event) {
    retryAudio(event.currentTarget);
  }

  function retryAudio(video) {
    if (!needsAudioRetry || !latestState?.enabled || !pageActive ||
        video !== currentVideo || findVideo() !== currentVideo) {
      return;
    }
    // A later play or running state can make a blocked graph usable. An
    // already applied speed/filter is left alone.
    needsAudioRetry = false;
    operationRevision += 1;
    reportCurrentResult(applyCurrentSettings());
  }

  function failed(reason, error) {
    console.warn("[prof_fang_plugin] settings could not be applied", error);
    return { status: "failed", reason };
  }

  function normalizeBlurLevel(value) {
    const level = Math.round(Number(value));
    return BLUR_LEVELS[level] ? level : DEFAULT_BLUR_LEVEL;
  }

  function normalizeState(rawState) {
    const state = {
      ...DEFAULT_STATE,
      ...(rawState || {})
    };

    if (state.mode === "lowpass") {
      state.mode = MODES.BLUR;
      if (rawState?.blurLevel === undefined) {
        state.blurLevel = LEGACY_LOWPASS_LEVELS[rawState.lowPassPreset] || DEFAULT_BLUR_LEVEL;
      }
    }
    if (state.mode !== MODES.SPEED && state.mode !== MODES.BLUR && state.mode !== MODES.NOISE) {
      state.mode = MODES.SPEED;
    }
    state.blurLevel = normalizeBlurLevel(state.blurLevel);
    return state;
  }

  async function applyCurrentSettings() {
    const state = latestState;
    const revision = operationRevision;
    const video = currentVideo;
    const activeMode = state.enabled ? state.mode : MODES.OFF;

    try {
      let graph = video ? graphMap.get(video) : null;
      // Cleanup is synchronous, before any resume/play promise. In particular,
      // an OFF request must invalidate and clear an older pending ON request.
      disableAll(video, graph);
      if (!pageActive) {
        return { status: "waiting-video", reason: "page-hidden" };
      }
      if (!video) {
        return { status: activeMode === MODES.OFF ? "applied" : "waiting-video" };
      }
      if (activeMode === MODES.OFF) {
        return { status: "applied" };
      }
      if (activeMode === MODES.SPEED) {
        video.playbackRate = Number(state.speed) || 1;
      } else if (activeMode === MODES.BLUR && !graph) {
        try {
          graph = ensureGraph(video);
        } catch (error) {
          return failed("audio-graph-failed", error);
        }
      }

      if (graph && graph.audioContext.state !== "running") {
        if (graph.audioContext.state === "closed") {
          return { status: "failed", reason: "audio-context-closed" };
        }
        let outcome;
        let waitTimer;
        try {
          const resumed = graph.audioContext.resume();
          // A rejection after the wait elapsed is already reported as waiting.
          resumed.catch(() => {});
          outcome = await Promise.race([
            resumed.then(() => "resumed"),
            new Promise((resolve) => {
              waitTimer = setTimeout(() => resolve("pending"), RESUME_WAIT_MS);
            })
          ]);
        } catch (error) {
          if (!isCurrentOperation(revision, video)) {
            return { status: "superseded" };
          }
          console.warn("[prof_fang_plugin] AudioContext resume blocked", error);
          return { status: "waiting-user-gesture", reason: "audio-context-blocked" };
        } finally {
          clearTimeout(waitTimer);
        }
        if (!isCurrentOperation(revision, video)) {
          return { status: "superseded" };
        }
        if (outcome === "pending") {
          return { status: "waiting-user-gesture", reason: "audio-context-suspended" };
        }
        if (graph.audioContext.state !== "running") {
          return { status: "waiting-user-gesture", reason: "audio-context-suspended" };
        }
      }

      if (!isCurrentOperation(revision, video)) {
        return { status: "superseded" };
      }
      if (activeMode === MODES.BLUR) {
        graph.setBlur(state.blurLevel);
      } else if (activeMode === MODES.NOISE) {
        // Noise never creates a media source. A graph previously created by
        // blur must still run its dry path so the original audio is audible.
        return await noiseController.configure(video, state);
      }
      return { status: "applied" };
    } catch (error) {
      return isCurrentOperation(revision, video) ? failed("apply-failed", error) : { status: "superseded" };
    }
  }

  async function applySettings(rawState) {
    latestState = normalizeState(rawState);
    needsAudioRetry = false;
    operationRevision += 1;
    try {
      if (pageActive) {
        reconcileTarget();
      }
      return await applyCurrentSettings();
    } catch (error) {
      return failed("target-cleanup-failed", error);
    }
  }

  function includesVideo(nodes) {
    return Array.from(nodes).some((node) => node === currentVideo || node.nodeName === "VIDEO" || node.querySelector?.("video"));
  }

  const videoObserver = new MutationObserver((records) => {
    if (!latestState || !pageActive) {
      return;
    }
    // Most page mutations have no effect on the managed video (for example,
    // chat messages). Do not query the whole document or reapply for those.
    const targetMayHaveChanged = currentVideo?.isConnected === false || records.some((record) =>
      includesVideo(record.addedNodes) || includesVideo(record.removedNodes));
    if (!targetMayHaveChanged) {
      return;
    }
    try {
      if (reconcileTarget()) {
        reportCurrentResult(applyCurrentSettings());
      }
    } catch (error) {
      reportStatus(failed("target-cleanup-failed", error));
    }
  });

  function observeVideos() {
    videoObserver.observe(document.documentElement || document, { childList: true, subtree: true });
  }
  observeVideos();

  window.addEventListener("pagehide", () => {
    pageActive = false;
    needsAudioRetry = false;
    operationRevision += 1;
    videoObserver.disconnect();
    const previousVideo = currentVideo;
    currentVideo = null;
    if (previousVideo) {
      try {
        detachTarget(previousVideo);
      } catch (error) {
        reportStatus(failed("target-cleanup-failed", error));
      }
    }
  });

  window.addEventListener("pageshow", () => {
    if (pageActive) {
      return;
    }
    pageActive = true;
    observeVideos();
    if (latestState) {
      reportCurrentResult(applySettings(latestState));
    }
  });

  window.addEventListener("message", (event) => {
    if (event.source !== window) {
      return;
    }
    const message = event.data;
    if (!message || message.source !== "PROF_FANG_EXTENSION") {
      return;
    }
    if (message.type === "TRAINER_PING") {
      announceReady();
    } else if (message.type === "APPLY_SETTINGS") {
      latestRequestId = message.requestId ?? null;
      reportCurrentResult(applySettings(message.payload));
    }
  });

  window[READY_FLAG] = true;
  announceReady();
})();
