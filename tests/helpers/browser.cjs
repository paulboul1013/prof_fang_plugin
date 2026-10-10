const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const REPO_ROOT = path.resolve(__dirname, "../..");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

class MockVideo extends EventTarget {
  constructor() {
    super();
    this.playbackRate = 1;
    this.paused = false;
    this.ended = false;
    this.muted = false;
    this.volume = 1;
    this.currentTime = 0;
    this.isConnected = true;
  }

  emit(type) {
    this.dispatchEvent(new Event(type));
  }

  async play() {
    this.paused = false;
    this.ended = false;
    this.emit("play");
  }

  pause() {
    this.paused = true;
    this.emit("pause");
  }
}

function createBrowser(options = {}) {
  let video = options.video === undefined ? new MockVideo() : options.video;
  let storedState = options.storedState;
  let clock = 0;
  let nextTimer = 1;
  const timers = new Map();
  const windowListeners = new Map();
  const messageQueue = [];
  const scripts = [];
  const postedMessages = [];
  const runtimeListeners = [];
  const audioContexts = [];
  const audioPlayers = [];
  const observers = [];
  const warnings = [];
  const routedVideos = new WeakSet();

  const window = {
    addEventListener(type, listener) {
      if (!windowListeners.has(type)) {
        windowListeners.set(type, new Set());
      }
      windowListeners.get(type).add(listener);
    },
    removeEventListener(type, listener) {
      windowListeners.get(type)?.delete(listener);
    },
    postMessage(message) {
      const data = structuredClone(message);
      postedMessages.push(data);
      messageQueue.push({ source: window, data });
    }
  };

  const document = {
    querySelector(selector) {
      return selector === "video" ? video : null;
    },
    contains(element) {
      return element === video;
    },
    createElement(tag) {
      if (tag !== "script") {
        throw new Error(`Unexpected document.createElement(${tag})`);
      }
      return {
        removed: false,
        remove() {
          this.removed = true;
        }
      };
    },
    head: {
      appendChild(script) {
        scripts.push(script);
        options.onAppendScript?.(script);
      }
    },
    documentElement: {}
  };
  window.document = document;

  class MockMutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.connected = false;
      observers.push(this);
    }

    observe(target, options) {
      this.target = target;
      this.options = options;
      this.connected = true;
    }

    disconnect() {
      this.connected = false;
    }
  }

  function audioNode() {
    return {
      connections: new Set(),
      gain: { value: 1 },
      frequency: { value: 0 },
      connect(destination) {
        this.connections.add(destination);
      },
      disconnect() {
        this.connections.clear();
      }
    };
  }

  class MockAudioContext {
    constructor() {
      this.state = options.audioContextState || "running";
      this.destination = {};
      this.nodes = [];
      this.resumeCalls = 0;
      audioContexts.push(this);
    }

    createMediaElementSource(element) {
      if (routedVideos.has(element)) {
        throw new Error("Video already has a MediaElementAudioSourceNode");
      }
      routedVideos.add(element);
      const source = audioNode();
      source.video = element;
      this.nodes.push(source);
      return source;
    }

    createGain() {
      const node = audioNode();
      this.nodes.push(node);
      return node;
    }

    createBiquadFilter() {
      const node = audioNode();
      this.nodes.push(node);
      return node;
    }

    async resume() {
      this.resumeCalls += 1;
      if (options.resumeAudioContext) {
        await options.resumeAudioContext(this);
      }
      this.state = "running";
    }
  }

  class MockAudio extends MockVideo {
    constructor(src) {
      super();
      this.src = src;
      this.paused = true;
      this.playCalls = 0;
      this.pauseCalls = 0;
      audioPlayers.push(this);
    }

    async play() {
      this.playCalls += 1;
      if (options.noisePlayError) {
        throw options.noisePlayError;
      }
      await super.play();
    }

    pause() {
      this.pauseCalls += 1;
      super.pause();
    }
  }

  const chrome = {
    runtime: {
      getURL(resource) {
        return `chrome-extension://test/${resource}`;
      },
      onMessage: {
        addListener(listener) {
          runtimeListeners.push(listener);
        }
      }
    },
    storage: {
      local: {
        async get(key) {
          if (options.storageGet) {
            return options.storageGet(key);
          }
          return storedState ? { [key]: structuredClone(storedState) } : {};
        },
        async set(data) {
          storedState = structuredClone(data.profFangState);
        }
      }
    }
  };

  function setTimeoutMock(callback, delay) {
    const id = nextTimer++;
    timers.set(id, { callback, at: clock + delay });
    return id;
  }

  function clearTimeoutMock(id) {
    timers.delete(id);
  }

  window.AudioContext = MockAudioContext;
  const context = vm.createContext({
    window,
    document,
    chrome,
    Audio: MockAudio,
    MutationObserver: MockMutationObserver,
    setTimeout: setTimeoutMock,
    clearTimeout: clearTimeoutMock,
    console: { warn: (...args) => warnings.push(args), log() {}, error() {} }
  });

  function runScript(relativePath) {
    return vm.runInContext(fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8"), context, {
      filename: relativePath
    });
  }

  function dispatchWindowEvent(type, event = {}) {
    for (const listener of [...(windowListeners.get(type) || [])]) {
      listener(event);
    }
  }

  function flushMessages() {
    let processed = 0;
    while (messageQueue.length) {
      if (++processed > 1000) {
        throw new Error("Message queue did not settle");
      }
      dispatchWindowEvent("message", messageQueue.shift());
    }
  }

  async function flush() {
    // Async handlers can queue messages after an await. Each round drains the
    // next task batch; timers stay under the test's explicit control.
    for (let round = 0; round < 20; round += 1) {
      await Promise.resolve();
      flushMessages();
    }
  }

  function advanceTimers(ms) {
    const until = clock + ms;
    let next;
    while ((next = [...timers.entries()].filter(([, timer]) => timer.at <= until)
      .sort((a, b) => a[1].at - b[1].at)[0])) {
      const [id, timer] = next;
      clock = timer.at;
      timers.delete(id);
      timer.callback();
    }
    clock = until;
  }

  function sendRuntime(message) {
    return new Promise((resolve, reject) => {
      let responded = false;
      let open = false;
      try {
        for (const listener of runtimeListeners) {
          const keepOpen = listener(structuredClone(message), {}, (response) => {
            responded = true;
            resolve(response);
          });
          open ||= keepOpen === true;
        }
        if (!responded && !open) {
          resolve(undefined);
        }
      } catch (error) {
        reject(error);
      }
    });
  }

  function setVideo(nextVideo) {
    const previous = video;
    if (previous) {
      previous.isConnected = false;
    }
    video = nextVideo;
    if (video) {
      video.isConnected = true;
    }
    const records = [{ type: "childList", addedNodes: video ? [video] : [], removedNodes: previous ? [previous] : [] }];
    for (const observer of observers) {
      if (observer.connected) {
        observer.callback(records, observer);
      }
    }
  }

  return {
    context,
    window,
    document,
    chrome,
    scripts,
    postedMessages,
    runtimeListeners,
    windowListeners,
    audioContexts,
    audioPlayers,
    observers,
    warnings,
    timers,
    get video() { return video; },
    get storedState() { return storedState; },
    runScript,
    runContent: () => runScript("content/content.js"),
    runTrainer: () => runScript("injected/trainer.js"),
    loadTrainer(script = scripts.at(-1)) {
      runScript("injected/trainer.js");
      script?.onload?.();
    },
    sendRuntime,
    dispatchWindowEvent,
    flushMessages,
    flush,
    advanceTimers,
    setVideo
  };
}

module.exports = { createBrowser, MockVideo, deferred };
