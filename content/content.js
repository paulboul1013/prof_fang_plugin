(() => {
  const STORAGE_KEY = "profFangState";
  const BRIDGE_FLAG = "__PROF_FANG_BRIDGE_ACTIVE__";
  const DEFAULT_NOISE_FILE = "People Talking Ambience Sound Effect.mp3";
  const READY_TIMEOUT_MS = 5000;
  // How long the popup's request waits for the trainer's own result. A later
  // TRAINER_STATUS still updates the cached status and any open popup.
  const APPLY_TIMEOUT_MS = 4000;

  // Content script reinjection must not add another bridge or runtime listener.
  if (window[BRIDGE_FLAG]) {
    return;
  }
  window[BRIDGE_FLAG] = true;

  let trainerReady = false;
  let readyAttempt = null;
  let settingsRevision = 0;
  let latestSettings = null;
  // The latest known result for this tab, reported by the trainer. Only
  // results for the newest request (settingsRevision) are accepted.
  let latestStatus = { requestId: 0, status: "idle" };
  let statusWaiter = null;

  function sendToPage(type, payload, requestId) {
    window.postMessage(
      {
        source: "PROF_FANG_EXTENSION",
        type,
        payload,
        ...(requestId ? { requestId } : {})
      },
      "*"
    );
  }

  function cleanupAttempt(attempt) {
    clearTimeout(attempt.timer);
    attempt.script?.remove();
  }

  function failAttempt(attempt, reason, code) {
    // A removed, slow script can still finish after another attempt starts.
    if (readyAttempt !== attempt) {
      return;
    }
    cleanupAttempt(attempt);
    readyAttempt = null;
    const error = new Error(reason);
    error.code = code;
    attempt.reject(error);
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
      failAttempt(attempt, "Trainer did not become ready in time", "trainer-timeout");
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
      script.onerror = () => failAttempt(attempt, "Trainer script could not be loaded", "trainer-load-failed");
      (document.head || document.documentElement).appendChild(script);
    } catch (error) {
      failAttempt(attempt, error.message || "Trainer script could not be loaded", "trainer-load-failed");
    }

    return attempt.promise;
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== "PROF_FANG_TRAINER") {
      return;
    }
    if (event.data.type === "TRAINER_STATUS") {
      onTrainerStatus(event.data.payload);
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

  function notifyPopup(status) {
    // The popup may be closed; nobody listening is not an error.
    try {
      const sent = chrome.runtime.sendMessage?.({ type: "PROF_FANG_STATUS", payload: status });
      sent?.catch?.(() => {});
    } catch (_error) {
      // Extension context can be invalidated after an update or reload.
    }
  }

  function setLatestStatus(requestId, result) {
    if (requestId !== settingsRevision) {
      return false;
    }
    latestStatus = {
      requestId,
      status: result.status,
      ...(result.reason ? { reason: result.reason } : {})
    };
    notifyPopup(latestStatus);
    return true;
  }

  function onTrainerStatus(payload) {
    // Untagged or older results must not overwrite the newest operation.
    if (!payload || typeof payload.status !== "string" || payload.requestId !== settingsRevision) {
      return;
    }
    setLatestStatus(payload.requestId, payload);
    if (statusWaiter?.requestId === payload.requestId) {
      const waiter = statusWaiter;
      statusWaiter = null;
      clearTimeout(waiter.timer);
      waiter.resolve(latestStatus);
    }
  }

  function supersedeWaiter() {
    if (statusWaiter) {
      const waiter = statusWaiter;
      statusWaiter = null;
      clearTimeout(waiter.timer);
      waiter.resolve({ requestId: waiter.requestId, status: "superseded", superseded: true });
    }
  }

  function waitForTrainerStatus(requestId) {
    return new Promise((resolve) => {
      const waiter = { requestId, resolve };
      waiter.timer = setTimeout(() => {
        if (statusWaiter !== waiter) {
          return;
        }
        statusWaiter = null;
        setLatestStatus(requestId, { status: "timeout", reason: "trainer-no-response" });
        resolve(latestStatus);
      }, APPLY_TIMEOUT_MS);
      statusWaiter = waiter;
    });
  }

  function toResponse(status) {
    const ok = status.status !== "failed" && status.status !== "timeout";
    return { ok, ...status };
  }

  async function queueLatestSettings(state) {
    const revision = ++settingsRevision;
    latestSettings = enrichSettings(state);
    supersedeWaiter();
    setLatestStatus(revision, { status: trainerReady ? "applying" : "waiting-trainer" });
    try {
      await ensureTrainerReady();
    } catch (error) {
      if (revision !== settingsRevision) {
        return { ok: true, superseded: true, requestId: revision, status: "superseded" };
      }
      setLatestStatus(revision, { status: "failed", reason: error.code || "trainer-load-failed" });
      return toResponse(latestStatus);
    }
    if (revision !== settingsRevision) {
      return { ok: true, superseded: true, requestId: revision, status: "superseded" };
    }
    setLatestStatus(revision, { status: "applying" });
    const result = waitForTrainerStatus(revision);
    sendToPage("APPLY_SETTINGS", latestSettings, revision);
    // Only the trainer's own result proves the settings took effect.
    return toResponse(await result);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "PROF_FANG_GET_STATUS") {
      sendResponse(toResponse(latestStatus));
      return false;
    }
    if (message?.type !== "PROF_FANG_APPLY_SETTINGS") {
      return false;
    }
    queueLatestSettings(message.payload).then(
      sendResponse,
      (error) => sendResponse({ ok: false, status: "failed", reason: "content-error", error: error.message })
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
