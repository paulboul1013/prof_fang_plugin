const DEFAULT_STATE = {
  enabled: false,
  mode: "speed",
  speed: 1,
  lowPassPreset: "medium",
  noiseFile: "People Talking Ambience Sound Effect.mp3",
  noiseVolume: 0.3
};

const STORAGE_KEY = "profFangState";

const els = {
  enabled: document.getElementById("enabled"),
  enabledLabel: document.getElementById("enabledLabel"),
  modeRadios: Array.from(document.querySelectorAll("input[name='mode']")),
  speedSettings: document.getElementById("speedSettings"),
  lowpassSettings: document.getElementById("lowpassSettings"),
  noiseSettings: document.getElementById("noiseSettings"),
  speed: document.getElementById("speed"),
  lowPassPreset: document.getElementById("lowPassPreset"),
  noiseFile: document.getElementById("noiseFile"),
  noiseVolume: document.getElementById("noiseVolume"),
  noiseVolumeLabel: document.getElementById("noiseVolumeLabel"),
  status: document.getElementById("status")
};

let currentState = { ...DEFAULT_STATE };

function setStatus(msg, level = "") {
  els.status.textContent = msg;
  els.status.className = `status ${level}`.trim();
}

function mergeState(loaded) {
  const merged = {
    ...DEFAULT_STATE,
    ...(loaded || {})
  };
  if (merged.mode !== "speed" && merged.mode !== "lowpass" && merged.mode !== "noise") {
    merged.mode = "speed";
  }
  return merged;
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
  els.lowPassPreset.value = currentState.lowPassPreset;
  els.noiseFile.value = currentState.noiseFile;
  els.noiseVolume.value = String(currentState.noiseVolume);
  els.noiseVolumeLabel.textContent = `${Math.round(currentState.noiseVolume * 100)}%`;

  const activeMode = currentState.enabled ? currentState.mode : "off";
  els.speedSettings.classList.toggle("hidden", activeMode !== "speed");
  els.lowpassSettings.classList.toggle("hidden", activeMode !== "lowpass");
  els.noiseSettings.classList.toggle("hidden", activeMode !== "noise");

  const disableModeFields = !currentState.enabled;
  els.speed.disabled = disableModeFields;
  els.lowPassPreset.disabled = disableModeFields;
  els.noiseFile.disabled = disableModeFields;
  els.noiseVolume.disabled = disableModeFields;
}

async function getActiveTabId() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0]?.id;
}

async function pushToActiveTab() {
  const tabId = await getActiveTabId();
  if (!tabId) {
    setStatus("No active tab", "error");
    return;
  }

  try {
    await chrome.tabs.sendMessage(tabId, {
      type: "PROF_FANG_APPLY_SETTINGS",
      payload: currentState
    });
    setStatus("Applied", "ok");
  } catch (err) {
    setStatus("Cannot apply on this page", "error");
  }
}

async function persistAndApply() {
  await chrome.storage.local.set({ [STORAGE_KEY]: currentState });
  await pushToActiveTab();
}

function bindEvents() {
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

  els.lowPassPreset.addEventListener("change", async () => {
    currentState.lowPassPreset = els.lowPassPreset.value;
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
    setStatus("Ready");
  } catch (err) {
    setStatus("Init failed", "error");
  }
}

init();
