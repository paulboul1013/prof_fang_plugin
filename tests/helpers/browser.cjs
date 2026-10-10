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
    this.nodeType = 1;
    this.nodeName = "VIDEO";
    this.playbackRate = 1;
    this.paused = false;
    this.ended = false;
    this.muted = false;
    this.volume = 1;
    this.currentTime = 0;
    this.isConnected = true;
  }

  emit(type) {
    const event = new Event(type);
    // Node's EventTarget clears currentTarget before later listeners. DOM
    // dispatch keeps it set throughout every callback, including a second
    // extension listener on the same media event.
    Object.defineProperty(event, "currentTarget", { configurable: true, value: this });
    try {
      this.dispatchEvent(event);
    } finally {
      Object.defineProperty(event, "currentTarget", { configurable: true, value: null });
    }
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
  // Extension pages (the popup) that receive chrome.runtime.sendMessage.
  const extensionListeners = [];
  const tabId = options.tabId ?? 1;
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

  // Automation completes instantly; the tests check the target values.
  function audioParam(value) {
    return {
      value,
      events: [],
      cancelScheduledValues(time) {
        this.events.push(["cancel", time]);
      },
      setValueAtTime(target, time) {
        this.events.push(["set", target, time]);
        this.value = target;
      },
      setTargetAtTime(target, time, timeConstant) {
        this.events.push(["target", target, time, timeConstant]);
        this.value = target;
      }
    };
  }

  function audioNode(kind) {
    return {
      kind,
      connections: new Set(),
      gain: audioParam(1),
      connect(destination) {
        this.connections.add(destination);
      },
      disconnect(destination) {
        if (destination) {
          this.connections.delete(destination);
        } else {
          this.connections.clear();
        }
      }
    };
  }

  class MockAudioContext extends EventTarget {
    constructor() {
      super();
      this.state = options.audioContextState || "running";
      this.destination = {};
      this.sampleRate = options.sampleRate || 48000;
      this.currentTime = 0;
      this.nodes = [];
      this.resumeCalls = 0;
      audioContexts.push(this);
    }

    createMediaElementSource(element) {
      if (routedVideos.has(element)) {
        throw new Error("Video already has a MediaElementAudioSourceNode");
      }
      routedVideos.add(element);
      const source = audioNode("source");
      source.video = element;
      this.nodes.push(source);
      return source;
    }

    createGain() {
      const node = audioNode("gain");
      this.nodes.push(node);
      return node;
    }

    createConvolver() {
      const node = audioNode("convolver");
      node.normalize = true;
      node.buffer = null;
      this.nodes.push(node);
      return node;
    }

    createBuffer(channels, length, sampleRate) {
      const data = Array.from({ length: channels }, () => new Float32Array(length));
      return {
        numberOfChannels: channels,
        length,
        sampleRate,
        getChannelData(channel) {
          return data[channel];
        }
      };
    }

    async resume() {
      this.resumeCalls += 1;
      if (options.resumeAudioContext) {
        await options.resumeAudioContext(this);
      }
      this.state = "running";
      this.dispatchEvent(new Event("statechange"));
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
      if (options.playNoise) {
        await options.playNoise(this);
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
      },
      sendMessage(message) {
        if (!extensionListeners.length) {
          return Promise.reject(new Error("Could not establish connection. Receiving end does not exist."));
        }
        const data = structuredClone(message);
        return Promise.resolve().then(() => {
          for (const listener of [...extensionListeners]) {
            listener(structuredClone(data), { tab: { id: tabId } }, () => {});
          }
        });
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
    extensionListeners,
    tabId,
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

function createElement(id) {
  const listeners = new Map();
  const classes = new Set(id === "retry" ? ["retry", "hidden"] : []);
  return {
    id,
    textContent: "",
    className: "",
    value: "",
    checked: false,
    disabled: false,
    classList: {
      toggle(name, force) {
        const on = force === undefined ? !classes.has(name) : force;
        if (on) {
          classes.add(name);
        } else {
          classes.delete(name);
        }
        return on;
      },
      contains(name) {
        return classes.has(name);
      }
    },
    addEventListener(type, listener) {
      if (!listeners.has(type)) {
        listeners.set(type, []);
      }
      listeners.get(type).push(listener);
    },
    fire(type) {
      return Promise.all((listeners.get(type) || []).map((listener) => listener({ currentTarget: this })));
    }
  };
}

// Runs the production popup script against a page created by createBrowser.
// The popup shares the extension's storage and reaches the page's content
// script through chrome.tabs.sendMessage, as in the real extension.
function createPopup(browser, options = {}) {
  const elements = new Map();
  const getElement = (id) => {
    if (!elements.has(id)) {
      elements.set(id, createElement(id));
    }
    return elements.get(id);
  };
  const modeRadios = ["speed", "gaussian", "noise"].map((value) => {
    const radio = createElement(`mode-${value}`);
    radio.value = value;
    return radio;
  });
  const listeners = [];
  const context = vm.createContext({
    console: { warn() {}, log() {}, error() {} },
    document: {
      getElementById: getElement,
      querySelectorAll(selector) {
        return selector === "input[name='mode']" ? modeRadios : [];
      }
    },
    chrome: {
      storage: browser.chrome.storage,
      runtime: {
        onMessage: {
          addListener(listener) {
            listeners.push(listener);
            browser.extensionListeners.push(listener);
          }
        }
      },
      tabs: {
        async query() {
          return [{ id: options.tabId ?? browser.tabId }];
        },
        async sendMessage(_tabId, message) {
          if (options.unreachable) {
            throw new Error("Could not establish connection. Receiving end does not exist.");
          }
          return browser.sendRuntime(message);
        }
      }
    }
  });
  vm.runInContext(fs.readFileSync(path.join(REPO_ROOT, "popup/popup.js"), "utf8"), context, {
    filename: "popup/popup.js"
  });
  return {
    context,
    element: getElement,
    modeRadios,
    get status() { return getElement("status").textContent; },
    get statusLevel() { return getElement("status").className; },
    get retryVisible() { return !getElement("retry").classList.contains("hidden"); },
    close() {
      for (const listener of listeners) {
        const index = browser.extensionListeners.indexOf(listener);
        if (index >= 0) {
          browser.extensionListeners.splice(index, 1);
        }
      }
    },
    // Simulates the user changing popup controls.
    async setEnabled(enabled) {
      const toggle = getElement("enabled");
      toggle.checked = enabled;
      return toggle.fire("change");
    },
    async setMode(mode) {
      for (const radio of modeRadios) {
        radio.checked = radio.value === mode;
      }
      return modeRadios.find((radio) => radio.value === mode).fire("change");
    },
    async setSpeed(value) {
      const select = getElement("speed");
      select.value = String(value);
      return select.fire("change");
    },
    retry() {
      return getElement("retry").fire("click");
    }
  };
}

// The trainer graph is [source, inputGain, mixGain, dryGain, ...wet chains],
// where each wet chain is inputGain -> convolver -> gain -> mixGain.
function graphNodes(context) {
  const [source, input, mix, dry] = context.nodes;
  return { source, input, mix, dry };
}

function activeBlurChains(context) {
  const { input, mix } = graphNodes(context);
  return context.nodes.filter((node) => node.kind === "convolver" && input.connections.has(node))
    .map((convolver) => ({ convolver, gain: [...convolver.connections][0] }))
    .filter(({ gain }) => gain && gain.gain.value > 0 && gain.connections.has(mix));
}

// The audible blur's -3 dB cutoff in Hz, derived from the Gaussian kernel's
// variance (σt), or null when only the original audio is audible.
function blurCutoff(context) {
  const chains = activeBlurChains(context);
  if (chains.length !== 1) {
    return chains.length ? NaN : null;
  }
  const { convolver } = chains[0];
  const kernel = convolver.buffer.getChannelData(0);
  const center = (kernel.length - 1) / 2;
  let sum = 0;
  let variance = 0;
  kernel.forEach((value, index) => {
    sum += value;
    variance += value * (index - center) ** 2;
  });
  const sigmaSeconds = Math.sqrt(variance / sum) / convolver.buffer.sampleRate;
  return Math.sqrt(Math.LN2) / (2 * Math.PI * sigmaSeconds);
}

function isDry(context) {
  const { input, mix, dry } = graphNodes(context);
  return input.connections.has(dry) && dry.connections.has(mix) && dry.gain.value === 1 &&
    activeBlurChains(context).length === 0;
}

function isBlurred(context) {
  const { dry } = graphNodes(context);
  return dry.gain.value === 0 && activeBlurChains(context).length === 1;
}

function assertCutoff(context, hz) {
  const cutoff = blurCutoff(context);
  if (!(Math.abs(cutoff - hz) / hz < 0.03)) {
    throw new Error(`Expected Gaussian blur cutoff ≈ ${hz} Hz, got ${cutoff}`);
  }
}

module.exports = {
  createBrowser, createPopup, MockVideo, deferred,
  blurCutoff, assertCutoff, isDry, isBlurred, graphNodes
};
