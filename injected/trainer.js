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
    LOWPASS: "lowpass",
    NOISE: "noise"
  };

  const LOWPASS_PRESETS = {
    light: 3500,
    medium: 1800,
    heavy: 900
  };

  const DEFAULT_STATE = {
    enabled: false,
    mode: "speed",
    speed: 1,
    lowPassPreset: "medium",
    noiseFile: "People Talking Ambience Sound Effect.mp3",
    noiseUrl: "",
    noiseVolume: 0.3
  };

  const graphMap = new WeakMap();
  let latestState = null;
  let currentVideo = null;
  let operationRevision = 0;
  let pageActive = true;
  let needsAudioRetry = false;

  function findVideo() {
    return document.querySelector("video");
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
    const lowpassFilter = audioContext.createBiquadFilter();

    lowpassFilter.type = "lowpass";

    source.connect(inputGain);
    inputGain.connect(mixGain);
    mixGain.connect(audioContext.destination);

    let inLowPassPath = false;

    function routeLowPass(enabled) {
      if (enabled === inLowPassPath) {
        return;
      }

      inputGain.disconnect();
      lowpassFilter.disconnect();

      if (enabled) {
        inputGain.connect(lowpassFilter);
        lowpassFilter.connect(mixGain);
      } else {
        inputGain.connect(mixGain);
      }

      inLowPassPath = enabled;
    }

    const graph = {
      audioContext,
      lowpassFilter,
      routeLowPass
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
      graph.routeLowPass(false);
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
      window.postMessage({ source: "PROF_FANG_TRAINER", type: "TRAINER_STATUS", payload: result }, "*");
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

  function normalizeState(rawState) {
    const state = {
      ...DEFAULT_STATE,
      ...(rawState || {})
    };

    if (state.mode !== MODES.SPEED && state.mode !== MODES.LOWPASS && state.mode !== MODES.NOISE) {
      state.mode = MODES.SPEED;
    }
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
      } else if (activeMode === MODES.LOWPASS && !graph) {
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
        try {
          await graph.audioContext.resume();
        } catch (error) {
          if (!isCurrentOperation(revision, video)) {
            return { status: "superseded" };
          }
          console.warn("[prof_fang_plugin] AudioContext resume blocked", error);
          return { status: "waiting-user-gesture", reason: "audio-context-blocked" };
        }
        if (!isCurrentOperation(revision, video)) {
          return { status: "superseded" };
        }
        if (graph.audioContext.state !== "running") {
          return { status: "waiting-user-gesture", reason: "audio-context-suspended" };
        }
      }

      if (!isCurrentOperation(revision, video)) {
        return { status: "superseded" };
      }
      if (activeMode === MODES.LOWPASS) {
        const cutoff = LOWPASS_PRESETS[state.lowPassPreset] || LOWPASS_PRESETS.medium;
        graph.lowpassFilter.frequency.value = cutoff;
        graph.routeLowPass(true);
      } else if (activeMode === MODES.NOISE) {
        // Noise never creates a media source. A graph previously created by
        // lowpass must still run its dry path so the original audio is audible.
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
      reportCurrentResult(applySettings(message.payload));
    }
  });

  window[READY_FLAG] = true;
  announceReady();
})();
