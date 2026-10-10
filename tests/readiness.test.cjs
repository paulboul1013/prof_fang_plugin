const test = require("node:test");
const assert = require("node:assert/strict");
const { createBrowser, deferred } = require("./helpers/browser.cjs");

function apply(browser, settings) {
  return browser.sendRuntime({ type: "PROF_FANG_APPLY_SETTINGS", payload: settings });
}

function appliedMessages(browser) {
  return browser.postedMessages.filter((message) => message.type === "APPLY_SETTINGS");
}

const speed = (value) => ({ enabled: true, mode: "speed", speed: value });

test("settings wait for the delayed trainer listener and preserve the noise URL", async () => {
  const browser = createBrowser();
  browser.runContent();
  let responded = false;
  const response = apply(browser, speed(2)).then((value) => {
    responded = true;
    return value;
  });
  await browser.flush();
  assert.equal(browser.scripts.length, 1);
  assert.equal(responded, false);
  assert.equal(appliedMessages(browser).length, 0);
  assert.equal(browser.video.playbackRate, 1);

  browser.loadTrainer();
  await browser.flush();
  assert.equal((await response).ok, true);
  assert.equal(browser.video.playbackRate, 2);
  assert.equal(appliedMessages(browser).length, 1);
  assert.equal(appliedMessages(browser)[0].payload.noiseUrl,
    "chrome-extension://test/assets/noise/People Talking Ambience Sound Effect.mp3");
  assert.equal(browser.timers.size, 0);
});

test("script onload alone cannot mark a trainer ready", async () => {
  const browser = createBrowser();
  browser.runContent();
  const response = apply(browser, speed(2));
  browser.scripts[0].onload();
  await browser.flush();
  assert.equal(appliedMessages(browser).length, 0);
  browser.advanceTimers(5000);
  await browser.flush();
  assert.equal((await response).ok, false);
  assert.equal(browser.video.playbackRate, 1);
});

test("a load failure clears the attempt and a later action retries", async () => {
  const browser = createBrowser();
  browser.runContent();
  const first = apply(browser, speed(2));
  const oldScript = browser.scripts[0];
  oldScript.onerror();
  await browser.flush();
  assert.equal((await first).ok, false);
  assert.equal(oldScript.removed, true);

  const retry = apply(browser, speed(2.5));
  assert.equal(browser.scripts.length, 2);
  // Late events from the failed attempt cannot reject the replacement.
  oldScript.onload();
  oldScript.onerror();
  browser.loadTrainer();
  await browser.flush();
  assert.equal((await retry).ok, true);
  assert.equal(browser.video.playbackRate, 2.5);
});

test("a readiness timeout can retry and ignores old script callbacks", async () => {
  const browser = createBrowser();
  browser.runContent();
  const first = apply(browser, speed(2));
  const oldScript = browser.scripts[0];
  browser.advanceTimers(5000);
  await browser.flush();
  assert.equal((await first).ok, false);

  const retry = apply(browser, speed(3));
  oldScript.onload();
  oldScript.onerror();
  await browser.flush();
  assert.equal(appliedMessages(browser).length, 0);
  // An old injection can finish after timeout. Its READY is valid, while the
  // singleton guard prevents the retry file from creating a second trainer.
  browser.loadTrainer(oldScript);
  browser.loadTrainer(browser.scripts[1]);
  await browser.flush();
  assert.equal((await retry).ok, true);
  assert.equal(browser.video.playbackRate, 3);
  assert.equal(browser.windowListeners.get("message").size, 2);
  assert.equal(browser.timers.size, 0);
});

test("rapid pending actions coalesce to the latest settings including OFF", async () => {
  const browser = createBrowser();
  browser.runContent();
  const requests = [apply(browser, speed(1.5)), apply(browser, speed(3)),
    apply(browser, { enabled: false, mode: "speed", speed: 3 })];
  await browser.flush();
  assert.equal(browser.scripts.length, 1);
  browser.loadTrainer();
  await browser.flush();
  const responses = await Promise.all(requests);
  assert.equal(responses[0].superseded, true);
  assert.equal(responses[1].superseded, true);
  assert.equal(responses[2].ok, true);
  assert.equal(appliedMessages(browser).length, 1);
  assert.equal(appliedMessages(browser)[0].payload.enabled, false);
  assert.equal(browser.video.playbackRate, 1);
});

test("a late bootstrap storage read cannot overwrite a newer popup action", async () => {
  const storage = deferred();
  const browser = createBrowser({ storageGet: () => storage.promise });
  browser.runContent();
  const response = apply(browser, speed(2));
  browser.loadTrainer();
  await browser.flush();
  assert.equal((await response).ok, true);
  storage.resolve({ profFangState: speed(1.5) });
  await browser.flush();
  assert.equal(appliedMessages(browser).length, 1);
  assert.equal(browser.video.playbackRate, 2);
});

test("saved settings wait for READY and a popup can replace them while loading", async () => {
  const browser = createBrowser({ storedState: speed(1.5) });
  browser.runContent();
  await browser.flush();
  assert.equal(appliedMessages(browser).length, 0);
  const response = apply(browser, speed(2.5));
  browser.loadTrainer();
  await browser.flush();
  assert.equal((await response).ok, true);
  assert.equal(appliedMessages(browser).length, 1);
  assert.equal(browser.video.playbackRate, 2.5);
});

test("trainer PING recovers a missed READY without needing another script load", async () => {
  const browser = createBrowser({ storedState: speed(2) });
  browser.runTrainer();
  await browser.flush();
  browser.runContent();
  await browser.flush();
  assert.equal(browser.video.playbackRate, 2);
  assert.equal(browser.timers.size, 0);
  browser.loadTrainer();
  await browser.flush();
  assert.equal(browser.windowListeners.get("message").size, 2);
});

test("repeated content and trainer injection retain one bridge and audio graph", async () => {
  const browser = createBrowser();
  browser.runContent();
  browser.runContent();
  assert.equal(browser.runtimeListeners.length, 1);
  assert.equal(browser.scripts.length, 1);
  browser.loadTrainer();
  await browser.flush();
  const first = apply(browser, { enabled: true, mode: "lowpass", lowPassPreset: "heavy" });
  await browser.flush();
  assert.equal((await first).ok, true);
  browser.runTrainer();
  const second = apply(browser, { enabled: true, mode: "lowpass", lowPassPreset: "light" });
  await browser.flush();
  assert.equal((await second).ok, true);
  assert.equal(browser.windowListeners.get("message").size, 2);
  assert.equal(browser.audioContexts.length, 1);
  assert.equal(browser.audioContexts[0].nodes[3].frequency.value, 3500);
});

test("speed, lowpass, noise and OFF remain mutually exclusive after startup", async () => {
  const browser = createBrowser();
  browser.runContent();
  browser.loadTrainer();
  await browser.flush();

  const speedResponse = apply(browser, speed(2));
  await browser.flush();
  assert.equal((await speedResponse).ok, true);
  assert.equal(browser.video.playbackRate, 2);
  const lowpass = apply(browser, { enabled: true, mode: "lowpass", lowPassPreset: "heavy" });
  await browser.flush();
  assert.equal((await lowpass).ok, true);
  const graph = browser.audioContexts[0];
  const [, inputGain, mixGain, filter] = graph.nodes;
  assert.equal(browser.video.playbackRate, 1);
  assert.equal(filter.frequency.value, 900);
  assert.equal(inputGain.connections.has(filter), true);

  const noise = apply(browser, { enabled: true, mode: "noise", noiseVolume: 0.2 });
  await browser.flush();
  assert.equal((await noise).ok, true);
  assert.equal(inputGain.connections.has(mixGain), true);
  assert.equal(browser.audioPlayers[0].paused, false);
  assert.equal(browser.audioPlayers[0].volume, 0.2);

  const off = apply(browser, { enabled: false });
  await browser.flush();
  assert.equal((await off).ok, true);
  assert.equal(browser.video.playbackRate, 1);
  assert.equal(browser.audioPlayers[0].paused, true);
  assert.equal(browser.audioPlayers[0].currentTime, 0);
  assert.equal(inputGain.connections.has(mixGain), true);
});

test("unrelated runtime messages do not keep a response channel open", async () => {
  const browser = createBrowser();
  browser.runContent();
  assert.equal(await browser.sendRuntime({ type: "UNRELATED" }), undefined);
});
