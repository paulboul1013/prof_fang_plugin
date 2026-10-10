const DEFAULT_STATE = {
  enabled: false,
  mode: "speed",
  speed: 1,
  blurLevel: 3,
  noiseFile: "People Talking Ambience Sound Effect.mp3",
  noiseVolume: 0.3
};

const STORAGE_KEY = "profFangState";
// Gaussian blur strength -> -3 dB cutoff (Hz). Must match injected/trainer.js.
const BLUR_LEVELS = { 1: 4000, 2: 2800, 3: 2000, 4: 1400, 5: 900 };
const BLUR_NAMES = { 1: "Light", 2: "Mild", 3: "Medium", 4: "Strong", 5: "Heavy" };
// Saved settings from the former Low-Pass mode.
const LEGACY_LOWPASS_LEVELS = { light: 1, medium: 3, heavy: 5 };

const els = {
  enabled: document.getElementById("enabled"),
  enabledLabel: document.getElementById("enabledLabel"),
  modeRadios: Array.from(document.querySelectorAll("input[name='mode']")),
  speedSettings: document.getElementById("speedSettings"),
  blurSettings: document.getElementById("blurSettings"),
  noiseSettings: document.getElementById("noiseSettings"),
  speed: document.getElementById("speed"),
  blurLevel: document.getElementById("blurLevel"),
  blurLevelLabel: document.getElementById("blurLevelLabel"),
  noiseFile: document.getElementById("noiseFile"),
  noiseVolume: document.getElementById("noiseVolume"),
  noiseVolumeLabel: document.getElementById("noiseVolumeLabel"),
  status: document.getElementById("status"),
  retry: document.getElementById("retry")
};

let currentState = { ...DEFAULT_STATE };
// Popup-side sequence of apply actions. Only the newest one may update the UI.
let applySeq = 0;
// Content-side request ids. A status below minRequestId belongs to an older
// action and must not replace what the user sees now.
let lastRequestId = 0;
let minRequestId = 0;
let activeTabId = null;

function setStatus(msg, level = "", canRetry = false) {
  els.status.textContent = msg;
  els.status.className = `status ${level}`.trim();
  els.retry?.classList.toggle("hidden", !canRetry);
}

const FAILURE_TEXT = {
  "trainer-load-failed": "Trainer could not be loaded on this page",
  "trainer-timeout": "Trainer did not start in time",
  "trainer-no-response": "No response from the page",
  "noise-url-missing": "Noise track is missing",
  "noise-media-failed": "Noise track could not be loaded",
  "noise-play-failed": "Noise track could not be played",
  "audio-context-closed": "Audio is unavailable for this video",
  "audio-graph-failed": "Audio is unavailable for this video"
};

// Map the trainer's real result to what the user sees. "Applied" is only
// shown when the trainer confirms the settings took effect.
function showResult(result) {
  switch (result?.status) {
    case "idle":
      setStatus("Ready");
      return;
    case "applied":
      setStatus(currentState.enabled ? "Applied" : "Off - normal playback", "ok");
      return;
    case "applying":
      setStatus("Applying...");
      return;
    case "waiting-trainer":
      setStatus("Loading trainer...");
      return;
    case "waiting-video":
      setStatus(result.reason === "page-hidden" ? "Waiting for the page" : "Waiting for a video on this page", "warn");
      return;
    case "waiting-user-gesture":
      setStatus("Press play on the video to start audio training", "warn");
      return;
    case "timeout":
      setStatus(FAILURE_TEXT[result.reason] || "No response from the page", "error", true);
      return;
    case "failed":
      setStatus(FAILURE_TEXT[result.reason] || "Could not apply settings", "error", true);
      return;
    default:
      setStatus("Cannot apply on this page", "error", true);
  }
}

function acceptRequestId(result) {
  const requestId = Number(result?.requestId);
  if (!Number.isFinite(requestId) || requestId < minRequestId) {
    return false;
  }
  lastRequestId = Math.max(lastRequestId, requestId);
  minRequestId = requestId;
  return true;
}

function mergeState(loaded) {
  const merged = {
    ...DEFAULT_STATE,
    ...(loaded || {})
  };
  if (merged.mode === "lowpass") {
    merged.mode = "gaussian";
    if (loaded?.blurLevel === undefined) {
      merged.blurLevel = LEGACY_LOWPASS_LEVELS[loaded.lowPassPreset] || DEFAULT_STATE.blurLevel;
    }
  }
  delete merged.lowPassPreset;
  if (merged.mode !== "speed" && merged.mode !== "gaussian" && merged.mode !== "noise") {
    merged.mode = "speed";
  }
  merged.blurLevel = normalizeBlurLevel(merged.blurLevel);
  return merged;
}

function normalizeBlurLevel(value) {
  const level = Math.round(Number(value));
  return BLUR_LEVELS[level] ? level : DEFAULT_STATE.blurLevel;
}

function blurLabel(level) {
  return `${BLUR_NAMES[level]} · ~${BLUR_LEVELS[level]} Hz`;
}

function selectedMode() {
  const radio = els.modeRadios.find((r) => r.checked);
  return radio ? radio.value : "speed";
}

function render() {
  els.enabled.checked = currentState.enabled;
  els.enabledLabel.textContent = currentState.enabled ? "ON" : "OFF";

  for (const radio of els.modeRadios) {
    radio.checked = radio.value === currentState.mode;
    radio.disabled = !currentState.enabled;
  }

  els.speed.value = String(currentState.speed);
  els.blurLevel.value = String(currentState.blurLevel);
  els.blurLevelLabel.textContent = blurLabel(currentState.blurLevel);
  els.noiseFile.value = currentState.noiseFile;
  els.noiseVolume.value = String(currentState.noiseVolume);
  els.noiseVolumeLabel.textContent = `${Math.round(currentState.noiseVolume * 100)}%`;

  const activeMode = currentState.enabled ? currentState.mode : "off";
  els.speedSettings.classList.toggle("hidden", activeMode !== "speed");
  els.blurSettings.classList.toggle("hidden", activeMode !== "gaussian");
  els.noiseSettings.classList.toggle("hidden", activeMode !== "noise");

  const disableModeFields = !currentState.enabled;
  els.speed.disabled = disableModeFields;
  els.blurLevel.disabled = disableModeFields;
  els.noiseFile.disabled = disableModeFields;
  els.noiseVolume.disabled = disableModeFields;
}

async function getActiveTabId() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0]?.id;
}

async function pushToActiveTab() {
  const seq = ++applySeq;
  // Any status the popup has already seen is now stale; the page assigns this
  // action a newer request id.
  minRequestId = lastRequestId + 1;
  setStatus("Applying...");
  const tabId = await getActiveTabId();
  if (seq !== applySeq) {
    return;
  }
  activeTabId = tabId ?? null;
  if (!tabId) {
    setStatus("No active tab", "error");
    return;
  }

  let response;
  try {
    response = await chrome.tabs.sendMessage(tabId, {
      type: "PROF_FANG_APPLY_SETTINGS",
      payload: currentState
    });
  } catch (err) {
    if (seq === applySeq) {
      // The page never received this action, so no newer id was assigned.
      minRequestId = lastRequestId;
      setStatus("Cannot apply on this page", "error", true);
    }
    return;
  }
  // A newer action owns the status line; an older result must not overwrite it.
  if (seq !== applySeq || response?.superseded) {
    return;
  }
  if (!response || typeof response.status !== "string") {
    setStatus("Cannot apply on this page", "error", true);
    return;
  }
  if (acceptRequestId(response) || response.requestId === undefined) {
    showResult(response);
  }
}

function onRuntimeMessage(message, sender) {
  if (message?.type !== "PROF_FANG_STATUS") {
    return;
  }
  // Statuses come from every tab's content script; show only this tab's.
  if (activeTabId == null || sender?.tab?.id !== activeTabId) {
    return;
  }
  if (acceptRequestId(message.payload)) {
    showResult(message.payload);
  }
}

async function loadTabStatus() {
  const tabId = await getActiveTabId();
  activeTabId = tabId ?? null;
  if (!tabId) {
    return;
  }
  const seq = applySeq;
  try {
    const status = await chrome.tabs.sendMessage(tabId, { type: "PROF_FANG_GET_STATUS" });
    if (seq === applySeq && acceptRequestId(status)) {
      showResult(status);
    }
  } catch (err) {
    if (seq === applySeq) {
      setStatus("Not available on this page", "error");
    }
  }
}

async function persistAndApply() {
  await chrome.storage.local.set({ [STORAGE_KEY]: currentState });
  await pushToActiveTab();
}

function bindEvents() {
  els.retry?.addEventListener("click", () => {
    pushToActiveTab();
  });

  els.enabled.addEventListener("change", async () => {
    currentState.enabled = els.enabled.checked;
    render();
    await persistAndApply();
  });

  for (const radio of els.modeRadios) {
    radio.addEventListener("change", async () => {
      if (!radio.checked) {
        return;
      }
      currentState.mode = selectedMode();
      render();
      await persistAndApply();
    });
  }

  els.speed.addEventListener("change", async () => {
    currentState.speed = Number(els.speed.value);
    await persistAndApply();
  });

  els.blurLevel.addEventListener("input", () => {
    els.blurLevelLabel.textContent = blurLabel(normalizeBlurLevel(els.blurLevel.value));
  });

  els.blurLevel.addEventListener("change", async () => {
    currentState.blurLevel = normalizeBlurLevel(els.blurLevel.value);
    await persistAndApply();
  });

  els.noiseFile.addEventListener("change", async () => {
    currentState.noiseFile = els.noiseFile.value;
    await persistAndApply();
  });

  els.noiseVolume.addEventListener("input", () => {
    const val = Number(els.noiseVolume.value);
    currentState.noiseVolume = val;
    els.noiseVolumeLabel.textContent = `${Math.round(val * 100)}%`;
  });

  els.noiseVolume.addEventListener("change", async () => {
    currentState.noiseVolume = Number(els.noiseVolume.value);
    await persistAndApply();
  });
}

async function init() {
  try {
    const data = await chrome.storage.local.get(STORAGE_KEY);
    currentState = mergeState(data[STORAGE_KEY]);
    render();
    bindEvents();
    chrome.runtime?.onMessage?.addListener(onRuntimeMessage);
    setStatus("Ready");
    // Reopening the popup shows the tab's actual state, not a guess.
    await loadTabStatus();
  } catch (err) {
    setStatus("Init failed", "error");
  }
}

init();
