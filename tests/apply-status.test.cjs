const test = require("node:test");
const assert = require("node:assert/strict");
const { createBrowser, createPopup, MockVideo, deferred } = require("./helpers/browser.cjs");

const speed = (value) => ({ enabled: true, mode: "speed", speed: value });

// The popup awaits storage, tab lookup and the content response in sequence.
async function settle(browser, rounds = 5) {
  for (let i = 0; i < rounds; i += 1) {
    await browser.flush();
    await new Promise(setImmediate);
  }
}

async function readyPage(options = {}) {
  const browser = createBrowser(options);
  browser.runContent();
  browser.loadTrainer();
  await settle(browser);
  return browser;
}

async function openPopup(browser, options) {
  const popup = createPopup(browser, options);
  await settle(browser);
  return popup;
}

async function apply(browser, settings) {
  const response = browser.sendRuntime({ type: "PROF_FANG_APPLY_SETTINGS", payload: settings });
  await settle(browser);
  return response;
}

test("a page without a video reports waiting instead of Applied", async () => {
  const browser = await readyPage({ video: null });
  const popup = await openPopup(browser);
  popup.setEnabled(true);
  await settle(browser);

  assert.notEqual(popup.status, "Applied");
  assert.equal(popup.status, "Waiting for a video on this page");
  assert.match(popup.statusLevel, /warn/);
  assert.equal(popup.retryVisible, false);
});

test("the content response carries the trainer's real result, not a receipt", async () => {
  const browser = await readyPage({ video: null });
  const waiting = await apply(browser, speed(2));
  assert.equal(waiting.status, "waiting-video");
  assert.equal(waiting.ok, true);

  browser.setVideo(new MockVideo());
  await settle(browser);
  const applied = await apply(browser, speed(2));
  assert.equal(applied.status, "applied");
  assert.equal(browser.video.playbackRate, 2);
});

test("a video appearing later updates an open popup to Applied", async () => {
  const browser = await readyPage({ video: null });
  const popup = await openPopup(browser);
  popup.setEnabled(true);
  await settle(browser);
  assert.equal(popup.status, "Waiting for a video on this page");

  browser.setVideo(new MockVideo());
  await settle(browser);
  assert.equal(popup.status, "Applied");
  assert.match(popup.statusLevel, /ok/);
});

test("Applied is shown only once the trainer confirms an existing video", async () => {
  const browser = await readyPage();
  const popup = await openPopup(browser);
  popup.setEnabled(true);
  await settle(browser);
  popup.setSpeed(2);
  await settle(browser);
  assert.equal(browser.video.playbackRate, 2);
  assert.equal(popup.status, "Applied");

  popup.setEnabled(false);
  await settle(browser);
  assert.equal(browser.video.playbackRate, 1);
  assert.equal(popup.status, "Off - normal playback");
});

test("while the trainer loads the popup says so, and a load failure offers retry", async () => {
  const browser = createBrowser();
  browser.runContent();
  await settle(browser);
  const popup = await openPopup(browser);
  // Nothing saved yet, so there is nothing pending to report.
  assert.equal(popup.status, "Ready");

  popup.setEnabled(true);
  await settle(browser);
  assert.equal(popup.status, "Loading trainer...");
  assert.notEqual(popup.status, "Applied");

  browser.scripts.at(-1).onerror();
  await settle(browser);
  assert.equal(popup.status, "Trainer could not be loaded on this page");
  assert.match(popup.statusLevel, /error/);
  assert.equal(popup.retryVisible, true);

  popup.retry();
  await settle(browser);
  assert.equal(popup.status, "Loading trainer...");
  browser.loadTrainer();
  await settle(browser);
  assert.equal(popup.status, "Applied");
  assert.equal(popup.retryVisible, false);
});

test("a trainer readiness timeout is reported with a retry", async () => {
  const browser = createBrowser();
  browser.runContent();
  await settle(browser);
  const popup = await openPopup(browser);
  popup.setEnabled(true);
  await settle(browser);
  // Bootstrap and the popup action share one readiness attempt.
  browser.advanceTimers(5000);
  await settle(browser);
  assert.equal(popup.status, "Trainer did not start in time");
  assert.equal(popup.retryVisible, true);
});

test("a ready trainer that never answers produces a timeout, and a late answer recovers", async () => {
  const browser = createBrowser();
  browser.runContent();
  // Mark the bridge ready without a trainer listening, so APPLY_SETTINGS is lost.
  browser.window.postMessage({ source: "PROF_FANG_TRAINER", type: "TRAINER_READY" });
  await settle(browser);
  const popup = await openPopup(browser);

  popup.setEnabled(true);
  await settle(browser);
  assert.equal(popup.status, "Applying...");
  browser.advanceTimers(4000);
  await settle(browser);
  assert.equal(popup.status, "No response from the page");
  assert.equal(popup.retryVisible, true);

  const lastApply = browser.postedMessages.filter((message) => message.type === "APPLY_SETTINGS").at(-1);
  browser.window.postMessage({
    source: "PROF_FANG_TRAINER",
    type: "TRAINER_STATUS",
    payload: { status: "applied", requestId: lastApply.requestId }
  });
  await settle(browser);
  assert.equal(popup.status, "Applied");
  assert.equal(popup.retryVisible, false);
});

test("blocked noise playback asks for a user gesture instead of claiming success", async () => {
  const blocked = new Error("play() needs a user gesture");
  blocked.name = "NotAllowedError";
  const browser = await readyPage({ noisePlayError: blocked });
  const popup = await openPopup(browser);
  popup.setEnabled(true);
  await settle(browser);
  popup.setMode("noise");
  await settle(browser);
  assert.equal(popup.status, "Press play on the video to start audio training");
  assert.match(popup.statusLevel, /warn/);
});

test("a suspended AudioContext reports waiting for a gesture", async () => {
  const browser = await readyPage({
    audioContextState: "suspended",
    resumeAudioContext: () => Promise.reject(Object.assign(new Error("blocked"), { name: "NotAllowedError" }))
  });
  const popup = await openPopup(browser);
  popup.setEnabled(true);
  await settle(browser);
  popup.setMode("lowpass");
  await settle(browser);
  assert.equal(popup.status, "Press play on the video to start audio training");
});

test("an older slow result cannot overwrite the newest action's status", async () => {
  const noisePlay = deferred();
  const browser = await readyPage({ playNoise: () => noisePlay.promise });
  const popup = await openPopup(browser);
  popup.setEnabled(true);
  await settle(browser);
  popup.setMode("noise");
  await settle(browser);
  assert.equal(popup.status, "Applying...");
  popup.setMode("speed");
  await settle(browser);
  assert.equal(popup.status, "Applied");

  // The superseded noise play settles last; it must not change the status
  // or leave the old noise playing.
  noisePlay.resolve();
  await settle(browser);
  assert.equal(popup.status, "Applied");
  assert.equal(browser.audioPlayers.every((player) => player.paused), true);
  assert.equal(browser.postedMessages.filter((message) => message.type === "TRAINER_STATUS")
    .every((message) => typeof message.payload.requestId === "number"), true);
});

test("a resume() that stays pending reports a gesture prompt, then Applied once audio runs", async () => {
  const resume = deferred();
  const browser = await readyPage({
    audioContextState: "suspended",
    resumeAudioContext: () => resume.promise
  });
  const popup = await openPopup(browser);
  popup.setEnabled(true);
  await settle(browser);
  popup.setMode("lowpass");
  await settle(browser);
  assert.equal(popup.status, "Applying...");

  browser.advanceTimers(1000);
  await settle(browser);
  assert.equal(popup.status, "Press play on the video to start audio training");
  assert.equal(popup.retryVisible, false);

  resume.resolve();
  await settle(browser);
  assert.equal(popup.status, "Applied");
  assert.equal(browser.audioContexts[0].state, "running");
});

test("stale statuses for older requests are ignored by the content script", async () => {
  const browser = await readyPage();
  const popup = await openPopup(browser);
  popup.setEnabled(true);
  await settle(browser);
  popup.setSpeed(2);
  await settle(browser);
  assert.equal(popup.status, "Applied");

  // Request 1 (the ON action) is older than the speed change.
  browser.window.postMessage({
    source: "PROF_FANG_TRAINER",
    type: "TRAINER_STATUS",
    payload: { status: "failed", reason: "apply-failed", requestId: 1 }
  });
  browser.window.postMessage({
    source: "PROF_FANG_TRAINER",
    type: "TRAINER_STATUS",
    payload: { status: "failed", reason: "apply-failed" }
  });
  await settle(browser);
  assert.equal(popup.status, "Applied");
});

test("reopening the popup shows the tab's current state", async () => {
  const browser = await readyPage({ video: null });
  const first = await openPopup(browser);
  first.setEnabled(true);
  await settle(browser);
  first.close();

  const reopened = await openPopup(browser);
  assert.equal(reopened.status, "Waiting for a video on this page");
  browser.setVideo(new MockVideo());
  await settle(browser);
  assert.equal(reopened.status, "Applied");
});

test("saved settings applied on page load are reported to a later popup", async () => {
  const browser = createBrowser({ storedState: speed(2) });
  browser.runContent();
  browser.loadTrainer();
  await settle(browser);
  assert.equal(browser.video.playbackRate, 2);
  const popup = await openPopup(browser);
  assert.equal(popup.status, "Applied");
});

test("statuses pushed from another tab do not change this popup", async () => {
  const browser = await readyPage({ video: null });
  const popup = await openPopup(browser, { tabId: 1 });
  popup.setEnabled(true);
  await settle(browser);
  for (const listener of browser.extensionListeners) {
    listener({ type: "PROF_FANG_STATUS", payload: { status: "applied", requestId: 999 } }, { tab: { id: 2 } });
  }
  assert.equal(popup.status, "Waiting for a video on this page");
});

test("an unsupported page is reported on open and on apply, with retry", async () => {
  const browser = createBrowser();
  const popup = await openPopup(browser, { unreachable: true });
  assert.equal(popup.status, "Not available on this page");
  popup.setEnabled(true);
  await settle(browser);
  assert.equal(popup.status, "Cannot apply on this page");
  assert.equal(popup.retryVisible, true);
});

test("a content script with no popup open does not throw when pushing status", async () => {
  const browser = await readyPage({ video: null });
  assert.equal(browser.extensionListeners.length, 0);
  const response = await apply(browser, speed(2));
  assert.equal(response.status, "waiting-video");
  browser.setVideo(new MockVideo());
  await settle(browser);
  assert.equal(browser.video.playbackRate, 2);
});
