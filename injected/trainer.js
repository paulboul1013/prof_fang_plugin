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
    let noisePlayer = null;

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

    function ensureNoisePlayer(noiseUrl) {
      if (!noiseUrl) {
        return null;
      }

      if (noisePlayer && noisePlayer.src === noiseUrl) {
        return noisePlayer;
      }

      if (noisePlayer) {
        noisePlayer.pause();
      }

      noisePlayer = new Audio(noiseUrl);
      noisePlayer.loop = true;
      noisePlayer.preload = "auto";
      return noisePlayer;
    }

    async function startNoise(noiseUrl, volume) {
      const player = ensureNoisePlayer(noiseUrl);
      if (!player) {
        return;
      }
      player.volume = volume;
      try {
        await player.play();
      } catch (err) {
        console.warn("[prof_fang_plugin] noise play blocked", err);
      }
    }

    function stopNoise() {
      if (!noisePlayer) {
        return;
      }
      noisePlayer.pause();
      noisePlayer.currentTime = 0;
    }

    const graph = {
      audioContext,
      lowpassFilter,
      routeLowPass,
      startNoise,
      stopNoise
    };

    graphMap.set(video, graph);
    return graph;
  }

  function disableAll(video, graph) {
    if (graph) {
      graph.routeLowPass(false);
      graph.stopNoise();
    }
    if (video) {
      video.playbackRate = 1;
    }
  }

  function detachTarget(video) {
    video.removeEventListener("loadedmetadata", onVideoLoadedMetadata);
    // Keep the media source connected to its dry path. Closing its context
    // would also silence the original video's audio if it is used again.
    disableAll(video, graphMap.get(video));
  }

  function attachTarget(video) {
    currentVideo = video;
    video?.addEventListener("loadedmetadata", onVideoLoadedMetadata);
  }

  function reconcileTarget() {
    const nextVideo = findVideo();
    if (nextVideo === currentVideo) {
      return false;
    }

    operationRevision += 1;
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

    if (!pageActive) {
      return { status: "waiting-video", reason: "page-hidden" };
    }
    if (!video) {
      return { status: activeMode === MODES.OFF ? "applied" : "waiting-video" };
    }

    try {
      let graph = graphMap.get(video);
      // Cleanup is synchronous, before any resume/play promise. In particular,
      // an OFF request must invalidate and clear an older pending ON request.
      disableAll(video, graph);
      if (activeMode === MODES.OFF) {
        return { status: "applied" };
      }

      if (activeMode === MODES.SPEED) {
        video.playbackRate = Number(state.speed) || 1;
      } else if (!graph) {
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
        const volume = Math.max(0, Math.min(0.5, Number(state.noiseVolume) || 0.3));
        await graph.startNoise(state.noiseUrl, volume);
        if (!isCurrentOperation(revision, video)) {
          return { status: "superseded" };
        }
      }
      return { status: "applied" };
    } catch (error) {
      return isCurrentOperation(revision, video) ? failed("apply-failed", error) : { status: "superseded" };
    }
  }

  async function applySettings(rawState) {
    latestState = normalizeState(rawState);
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
