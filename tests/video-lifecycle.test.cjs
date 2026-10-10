const test = require("node:test");
const assert = require("node:assert/strict");
const { createBrowser, MockVideo, deferred } = require("./helpers/browser.cjs");

const speed = (value) => ({ enabled: true, mode: "speed", speed: value });
const lowpass = (preset = "heavy") => ({ enabled: true, mode: "lowpass", lowPassPreset: preset });

function lastStatus(browser) {
  return browser.postedMessages.filter((message) => message.type === "TRAINER_STATUS").at(-1)?.payload;
}

async function apply(browser, settings) {
  browser.window.postMessage({ source: "PROF_FANG_EXTENSION", type: "APPLY_SETTINGS", payload: settings }, "*");
  await browser.flush();
  return lastStatus(browser);
}

function assertDry(context) {
  const [, input, mix, filter] = context.nodes;
  assert.equal(input.connections.has(mix), true);
  assert.equal(input.connections.has(filter), false);
}

test("a trainer without settings does not reset a page's own playback rate", async () => {
  const browser = createBrowser({ video: null });
  browser.runTrainer();
  const video = new MockVideo();
  video.playbackRate = 1.5;
  browser.setVideo(video);
  await browser.flush();
  assert.equal(video.playbackRate, 1.5);
  assert.equal(browser.audioContexts.length, 0);
  assert.equal(lastStatus(browser), undefined);
});

test("saved settings apply when the video appears after content and trainer startup", async () => {
  const browser = createBrowser({ video: null, storedState: speed(2.5) });
  browser.runContent();
  browser.loadTrainer();
  await browser.flush();
  assert.equal(lastStatus(browser).status, "waiting-video");
  const video = new MockVideo();
  browser.setVideo(video);
  await browser.flush();
  assert.equal(video.playbackRate, 2.5);
  assert.equal(lastStatus(browser).status, "applied");
  assert.equal(browser.audioContexts.length, 0);
});

test("replacement resets the old video and applies the latest speed to the new one", async () => {
  const browser = createBrowser();
  browser.runTrainer();
  const previous = browser.video;
  await apply(browser, speed(3));
  const next = new MockVideo();
  browser.setVideo(next);
  await browser.flush();
  assert.equal(previous.playbackRate, 1);
  assert.equal(next.playbackRate, 3);
  assert.equal(lastStatus(browser).status, "applied");
});

test("a reused video's metadata reload reapplies the latest speed without restoring an old ON", async () => {
  const browser = createBrowser();
  browser.runTrainer();
  await apply(browser, speed(2.5));
  browser.video.playbackRate = 1;
  browser.video.emit("loadedmetadata");
  await browser.flush();
  assert.equal(browser.video.playbackRate, 2.5);
  await apply(browser, { enabled: false, mode: "speed", speed: 2.5 });
  browser.video.emit("loadedmetadata");
  await browser.flush();
  assert.equal(browser.video.playbackRate, 1);
  assert.equal(lastStatus(browser).status, "applied");
});

test("metadata reload keeps one audio graph and a detached video's metadata listener is removed", async () => {
  const browser = createBrowser();
  browser.runTrainer();
  await apply(browser, lowpass("light"));
  browser.video.emit("loadedmetadata");
  browser.video.emit("loadedmetadata");
  await browser.flush();
  assert.equal(browser.audioContexts.length, 1);
  const previous = browser.video;
  browser.setVideo(new MockVideo());
  await browser.flush();
  const before = browser.postedMessages.length;
  previous.emit("loadedmetadata");
  await browser.flush();
  assert.equal(browser.postedMessages.length, before);
  assertDry(browser.audioContexts[0]);
  assert.equal(browser.audioContexts.length, 2);
});

test("removal enters waiting-video and an OFF request cancels future activation", async () => {
  const browser = createBrowser();
  browser.runTrainer();
  const previous = browser.video;
  await apply(browser, speed(2));
  browser.setVideo(null);
  await browser.flush();
  assert.equal(previous.playbackRate, 1);
  assert.equal(lastStatus(browser).status, "waiting-video");
  assert.equal((await apply(browser, { enabled: false, mode: "speed", speed: 2 })).status, "applied");
  const next = new MockVideo();
  browser.setVideo(next);
  await browser.flush();
  assert.equal(next.playbackRate, 1);
  assert.equal(lastStatus(browser).status, "applied");
});

test("waiting video retains the newest lowpass preset", async () => {
  const browser = createBrowser({ video: null });
  browser.runTrainer();
  await apply(browser, lowpass("light"));
  await apply(browser, lowpass("heavy"));
  browser.setVideo(new MockVideo());
  await browser.flush();
  assert.equal(browser.audioContexts.length, 1);
  assert.equal(browser.audioContexts[0].nodes[3].frequency.value, 900);
  assert.equal(lastStatus(browser).status, "applied");
});

test("lowpass replacement cleans the old path and reattachment reuses its media source", async () => {
  const browser = createBrowser();
  browser.runTrainer();
  const previous = browser.video;
  await apply(browser, lowpass("medium"));
  const originalContext = browser.audioContexts[0];
  browser.setVideo(new MockVideo());
  await browser.flush();
  assertDry(originalContext);
  assert.equal(originalContext.state, "running");
  assert.equal(browser.audioContexts.length, 2);
  assert.equal(browser.audioContexts[1].nodes[3].frequency.value, 1800);
  browser.setVideo(null);
  await browser.flush();
  assertDry(browser.audioContexts[1]);
  browser.setVideo(previous);
  await browser.flush();
  assert.equal(browser.audioContexts.length, 2);
  assert.equal(originalContext.nodes[1].connections.has(originalContext.nodes[3]), true);
  assert.equal(lastStatus(browser).status, "applied");
});

test("unrelated DOM mutations do not query the whole page or reapply the current video", async () => {
  const browser = createBrowser();
  browser.runTrainer();
  await apply(browser, lowpass());
  let documentQueries = 0;
  const query = browser.document.querySelector;
  browser.document.querySelector = (...args) => {
    documentQueries += 1;
    return query(...args);
  };
  const before = browser.postedMessages.length;
  const observer = browser.observers[0];
  for (let count = 0; count < 100; count += 1) {
    observer.callback([{ type: "childList", addedNodes: [{ nodeType: 3, nodeName: "#text" }], removedNodes: [] }]);
  }
  await browser.flush();
  assert.equal(documentQueries, 0);
  assert.equal(browser.audioContexts.length, 1);
  assert.equal(browser.postedMessages.length, before);
  // Even a repeated record containing the same video only reconciles identity.
  observer.callback([{ type: "childList", addedNodes: [browser.video], removedNodes: [] }]);
  await browser.flush();
  assert.equal(documentQueries, 1);
  assert.equal(browser.postedMessages.length, before);
  assert.equal(browser.audioContexts.length, 1);
});

test("OFF clears effects before an outstanding AudioContext resume resolves", async () => {
  const resume = deferred();
  const browser = createBrowser({ audioContextState: "suspended", resumeAudioContext: () => resume.promise });
  browser.runTrainer();
  await apply(browser, lowpass());
  const context = browser.audioContexts[0];
  assert.equal(context.resumeCalls, 1);
  assert.equal((await apply(browser, { enabled: false })).status, "applied");
  assert.equal(context.resumeCalls, 1);
  assertDry(context);
  resume.resolve();
  await browser.flush();
  assertDry(context);
  assert.equal(browser.video.playbackRate, 1);
  assert.equal(lastStatus(browser).status, "applied");
});

test("an older resumed lowpass operation cannot overwrite a newer preset", async () => {
  const resumes = [];
  const browser = createBrowser({ audioContextState: "suspended", resumeAudioContext: () => {
    const resume = deferred();
    resumes.push(resume);
    return resume.promise;
  } });
  browser.runTrainer();
  await apply(browser, lowpass("heavy"));
  await apply(browser, lowpass("light"));
  resumes[1].resolve();
  await browser.flush();
  assert.equal(browser.audioContexts[0].nodes[3].frequency.value, 3500);
  resumes[0].resolve();
  await browser.flush();
  assert.equal(browser.audioContexts[0].nodes[3].frequency.value, 3500);
  assert.equal(lastStatus(browser).status, "applied");
});

test("an old video's pending resume cannot enable its filter after replacement", async () => {
  const resumes = [];
  const browser = createBrowser({ audioContextState: "suspended", resumeAudioContext: () => {
    const resume = deferred();
    resumes.push(resume);
    return resume.promise;
  } });
  browser.runTrainer();
  await apply(browser, lowpass("heavy"));
  const previous = browser.video;
  browser.setVideo(new MockVideo());
  await browser.flush();
  assert.equal(browser.audioContexts.length, 2);
  resumes[0].resolve();
  await browser.flush();
  assertDry(browser.audioContexts[0]);
  assert.equal(previous.playbackRate, 1);
  resumes[1].resolve();
  await browser.flush();
  assert.equal(browser.audioContexts[1].nodes[1].connections.has(browser.audioContexts[1].nodes[3]), true);
  assert.equal(lastStatus(browser).status, "applied");
});

test("a blocked AudioContext reports waiting and keeps the original dry path", async () => {
  const browser = createBrowser({ audioContextState: "suspended", resumeAudioContext: () => {
    throw new Error("User gesture required");
  } });
  browser.runTrainer();
  const result = await apply(browser, lowpass());
  assert.equal(result.status, "waiting-user-gesture");
  assert.equal(result.reason, "audio-context-blocked");
  assertDry(browser.audioContexts[0]);
});

test("a resolved resume that leaves a context suspended is not reported as applied", async () => {
  const browser = createBrowser({ audioContextState: "suspended" });
  const BaseContext = browser.window.AudioContext;
  browser.window.AudioContext = class extends BaseContext {
    async resume() {
      this.resumeCalls += 1;
    }
  };
  browser.runTrainer();
  const result = await apply(browser, lowpass());
  assert.equal(result.status, "waiting-user-gesture");
  assert.equal(result.reason, "audio-context-suspended");
  assertDry(browser.audioContexts[0]);
});

test("audio graph construction failures return failed without an unhandled rejection", async () => {
  const browser = createBrowser();
  const BaseContext = browser.window.AudioContext;
  browser.window.AudioContext = class extends BaseContext {
    createMediaElementSource() {
      throw new Error("Media element cannot be routed");
    }
  };
  browser.runTrainer();
  const result = await apply(browser, lowpass());
  assert.equal(result.status, "failed");
  assert.equal(result.reason, "audio-graph-failed");
  assert.equal(browser.video.playbackRate, 1);
});

test("rejected playback rates return failed and preserve the default speed", async () => {
  const video = new MockVideo();
  let rate = 1;
  Object.defineProperty(video, "playbackRate", {
    get: () => rate,
    set(value) {
      if (value > 4) {
        throw new RangeError("Unsupported playback rate");
      }
      rate = value;
    }
  });
  const browser = createBrowser({ video });
  browser.runTrainer();
  const result = await apply(browser, speed(100));
  assert.equal(result.status, "failed");
  assert.equal(result.reason, "apply-failed");
  assert.equal(video.playbackRate, 1);
});

test("pagehide invalidates pending work and a cached page restores its settings on pageshow", async () => {
  const resume = deferred();
  const browser = createBrowser({ audioContextState: "suspended", resumeAudioContext: () => resume.promise });
  browser.runTrainer();
  await apply(browser, lowpass("light"));
  browser.dispatchWindowEvent("pagehide", { persisted: true });
  assert.equal(browser.observers[0].connected, false);
  resume.resolve();
  await browser.flush();
  assertDry(browser.audioContexts[0]);
  browser.dispatchWindowEvent("pageshow", { persisted: true });
  await browser.flush();
  assert.equal(browser.observers[0].connected, true);
  assert.equal(browser.audioContexts.length, 1);
  assert.equal(browser.audioContexts[0].nodes[1].connections.has(browser.audioContexts[0].nodes[3]), true);
  assert.equal(lastStatus(browser).status, "applied");
});

test("every existing speed and lowpass preset remains available", async () => {
  const browser = createBrowser();
  browser.runTrainer();
  for (const value of [1, 1.5, 2, 2.5, 3]) {
    assert.equal((await apply(browser, speed(value))).status, "applied");
    assert.equal(browser.video.playbackRate, value);
  }
  for (const [preset, cutoff] of [["light", 3500], ["medium", 1800], ["heavy", 900]]) {
    assert.equal((await apply(browser, lowpass(preset))).status, "applied");
    assert.equal(browser.video.playbackRate, 1);
    assert.equal(browser.audioContexts[0].nodes[3].frequency.value, cutoff);
  }
  await apply(browser, { enabled: false });
  assertDry(browser.audioContexts[0]);
  assert.equal(browser.video.playbackRate, 1);
});
