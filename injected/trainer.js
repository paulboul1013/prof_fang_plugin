(() => {
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
    video.playbackRate = 1;
    if (graph) {
      graph.routeLowPass(false);
      graph.stopNoise();
    }
  }

  async function applySettings(rawState) {
    const state = {
      ...DEFAULT_STATE,
      ...(rawState || {})
    };

    if (state.mode !== MODES.SPEED && state.mode !== MODES.LOWPASS && state.mode !== MODES.NOISE) {
      state.mode = MODES.SPEED;
    }

    const video = findVideo();
    if (!video) {
      return;
    }

    const activeMode = state.enabled ? state.mode : MODES.OFF;
    const needsGraph = activeMode === MODES.LOWPASS || activeMode === MODES.NOISE;
    const graph = needsGraph ? ensureGraph(video) : graphMap.get(video);

    if (graph && graph.audioContext.state !== "running") {
      try {
        await graph.audioContext.resume();
      } catch (err) {
        console.warn("[prof_fang_plugin] AudioContext resume blocked", err);
      }
    }

    disableAll(video, graph);

    if (activeMode === MODES.SPEED) {
      video.playbackRate = Number(state.speed) || 1;
      return;
    }

    if (activeMode === MODES.LOWPASS) {
      graph.routeLowPass(true);
      const cutoff = LOWPASS_PRESETS[state.lowPassPreset] || LOWPASS_PRESETS.medium;
      graph.lowpassFilter.frequency.value = cutoff;
      return;
    }

    if (activeMode === MODES.NOISE) {
      const volume = Math.max(0, Math.min(0.5, Number(state.noiseVolume) || 0.3));
      await graph.startNoise(state.noiseUrl, volume);
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) {
      return;
    }
    const message = event.data;
    if (!message || message.source !== "PROF_FANG_EXTENSION") {
      return;
    }
    if (message.type === "APPLY_SETTINGS") {
      applySettings(message.payload);
    }
  });
})();
