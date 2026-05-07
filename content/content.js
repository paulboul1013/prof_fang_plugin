const STORAGE_KEY = "profFangState";
const INJECTED_FLAG = "__PROF_FANG_TRAINER_INJECTED__";
const DEFAULT_NOISE_FILE = "People Talking Ambience Sound Effect.mp3";

function injectTrainer() {
  if (window[INJECTED_FLAG]) {
    return;
  }

  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("injected/trainer.js");
  script.async = false;
  script.onload = () => {
    script.remove();
  };
  (document.head || document.documentElement).appendChild(script);
  window[INJECTED_FLAG] = true;
}

function sendToPage(type, payload) {
  window.postMessage(
    {
      source: "PROF_FANG_EXTENSION",
      type,
      payload
    },
    "*"
  );
}

function enrichSettings(state) {
  const noiseFile = state?.noiseFile || DEFAULT_NOISE_FILE;
  return {
    ...(state || {}),
    noiseFile,
    noiseUrl: chrome.runtime.getURL(`assets/noise/${noiseFile}`)
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "PROF_FANG_APPLY_SETTINGS") {
    injectTrainer();
    sendToPage("APPLY_SETTINGS", enrichSettings(message.payload));
    sendResponse({ ok: true });
  }
  return true;
});

(async function bootstrap() {
  injectTrainer();
  const data = await chrome.storage.local.get(STORAGE_KEY);
  if (data?.[STORAGE_KEY]) {
    sendToPage("APPLY_SETTINGS", enrichSettings(data[STORAGE_KEY]));
  }
})();
