(() => {
  const STORAGE_KEY = "profFangState";
  const BRIDGE_FLAG = "__PROF_FANG_BRIDGE_ACTIVE__";
  const DEFAULT_NOISE_FILE = "People Talking Ambience Sound Effect.mp3";
  const READY_TIMEOUT_MS = 5000;

  // Content script reinjection must not add another bridge or runtime listener.
  if (window[BRIDGE_FLAG]) {
    return;
  }
  window[BRIDGE_FLAG] = true;

  let trainerReady = false;
  let readyAttempt = null;
  let settingsRevision = 0;
  let latestSettings = null;

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

  function cleanupAttempt(attempt) {
    clearTimeout(attempt.timer);
    attempt.script?.remove();
  }

  function failAttempt(attempt, reason) {
    // A removed, slow script can still finish after another attempt starts.
    if (readyAttempt !== attempt) {
      return;
    }
    cleanupAttempt(attempt);
    readyAttempt = null;
    attempt.reject(new Error(reason));
  }

  function ensureTrainerReady() {
    if (trainerReady) {
      return Promise.resolve();
    }
    if (readyAttempt) {
      return readyAttempt.promise;
    }

    const attempt = {};
    attempt.promise = new Promise((resolve, reject) => {
      attempt.resolve = resolve;
      attempt.reject = reject;
    });
    readyAttempt = attempt;
    attempt.timer = setTimeout(() => {
      failAttempt(attempt, "Trainer did not become ready in time");
    }, READY_TIMEOUT_MS);

    // Recover an already initialized trainer if its first READY was missed.
    sendToPage("TRAINER_PING");

    try {
      const script = document.createElement("script");
      attempt.script = script;
      script.src = chrome.runtime.getURL("injected/trainer.js");
      script.async = false;
      // Loading the file does not prove that its message listener is ready.
      script.onload = () => script.remove();
      script.onerror = () => failAttempt(attempt, "Trainer script could not be loaded");
      (document.head || document.documentElement).appendChild(script);
    } catch (error) {
      failAttempt(attempt, error.message || "Trainer script could not be loaded");
    }

    return attempt.promise;
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== "PROF_FANG_TRAINER") {
      return;
    }
    if (event.data.type !== "TRAINER_READY") {
      return;
    }
    trainerReady = true;
    if (readyAttempt) {
      const attempt = readyAttempt;
      cleanupAttempt(attempt);
      readyAttempt = null;
      attempt.resolve();
    }
  });

  function enrichSettings(state) {
    const noiseFile = state?.noiseFile || DEFAULT_NOISE_FILE;
    return {
      ...(state || {}),
      noiseFile,
      noiseUrl: chrome.runtime.getURL(`assets/noise/${noiseFile}`)
    };
  }

  async function queueLatestSettings(state) {
    const revision = ++settingsRevision;
    latestSettings = enrichSettings(state);
    await ensureTrainerReady();
    if (revision !== settingsRevision) {
      return { ok: true, superseded: true };
    }
    sendToPage("APPLY_SETTINGS", latestSettings);
    // Actual application acknowledgement is separate from trainer readiness.
    return { ok: true };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "PROF_FANG_APPLY_SETTINGS") {
      return false;
    }
    queueLatestSettings(message.payload).then(
      sendResponse,
      (error) => sendResponse({ ok: false, error: error.message })
    );
    return true;
  });

  (async function bootstrap() {
    const initialRevision = settingsRevision;
    // Start loading while storage is read, and contain startup failures.
    ensureTrainerReady().catch((error) => {
      console.warn("[prof_fang_plugin] trainer initialization failed", error);
    });
    try {
      const data = await chrome.storage.local.get(STORAGE_KEY);
      // A later popup action takes precedence over an older storage read.
      if (data?.[STORAGE_KEY] && settingsRevision === initialRevision) {
        await queueLatestSettings(data[STORAGE_KEY]);
      }
    } catch (error) {
      console.warn("[prof_fang_plugin] saved settings could not be applied", error);
    }
  })();
})();
