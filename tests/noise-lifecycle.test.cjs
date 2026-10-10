const test = require("node:test");
const assert = require("node:assert/strict");
const { createBrowser, MockVideo, deferred } = require("./helpers/browser.cjs");
const { assertCutoff, isBlurred, isDry } = require("./helpers/browser.cjs");

const noiseUrl = "chrome-extension://test/assets/noise/People Talking Ambience Sound Effect.mp3";
const noise = (volume = 0.3, url = noiseUrl) => ({ enabled: true, mode: "noise", noiseVolume: volume, noiseUrl: url });
const speed = (value = 2) => ({ enabled: true, mode: "speed", speed: value });
const lowpass = (preset = "heavy") => ({ enabled: true, mode: "lowpass", lowPassPreset: preset });

function lastStatus(browser) {
  return browser.postedMessages.filter((message) => message.type === "TRAINER_STATUS").at(-1)?.payload;
}

async function apply(browser, settings) {
  browser.window.postMessage({ source: "PROF_FANG_EXTENSION", type: "APPLY_SETTINGS", payload: settings }, "*");
  await browser.flush();
  return lastStatus(browser);
}

function assertStopped(player) {
  assert.equal(player.paused, true);
  assert.equal(player.currentTime, 0);
}

function assertDry(context) {
  assert.equal(isDry(context), true);
  assert.equal(context.state, "running");
}

test("noise uses the packaged looping MP3 without rerouting the original video", async () => {
  const browser = createBrowser({ audioContextState: "suspended" });
  browser.window.AudioContext = class {
    constructor() { throw new Error("Noise must not create an AudioContext"); }
  };
  browser.runTrainer();
  const result = await apply(browser, noise());
  const player = browser.audioPlayers[0];
  assert.equal(result.status, "applied");
  assert.equal(player.src, noiseUrl);
  assert.equal(player.loop, true);
  assert.equal(player.preload, "auto");
  assert.equal(player.paused, false);
  assert.equal(player.volume, 0.3);
  assert.equal(browser.video.playbackRate, 1);
  assert.equal(browser.audioContexts.length, 0);
});

test("every UI noise volume stays exact at full video volume and explicit zero does not play", async () => {
  const browser = createBrowser();
  browser.runTrainer();
  for (const volume of [0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5]) {
    assert.equal((await apply(browser, noise(volume))).status, "applied");
    assert.equal(browser.audioPlayers.at(-1).volume, volume);
    assert.equal(browser.audioPlayers.at(-1).paused, false);
  }
  const previous = browser.audioPlayers.at(-1);
  previous.currentTime = 42;
  const count = browser.audioPlayers.length;
  assert.equal((await apply(browser, noise(0))).status, "applied");
  assertStopped(previous);
  assert.equal(browser.audioPlayers.length, count);
  browser.video.emit("play");
  await browser.flush();
  assert.equal(browser.audioPlayers.length, count);
});

test("noise follows pause, play, ended, and replay on the same video", async () => {
  const browser = createBrowser();
  browser.runTrainer();
  await apply(browser, noise());
  const player = browser.audioPlayers[0];
  player.currentTime = 12;
  browser.video.pause();
  assert.equal(player.paused, true);
  assert.equal(player.currentTime, 12);
  await browser.video.play();
  await browser.flush();
  assert.equal(player.paused, false);
  browser.video.ended = true;
  browser.video.emit("ended");
  assert.equal(player.paused, true);
  await browser.video.play();
  await browser.flush();
  assert.equal(player.paused, false);
  assert.equal(browser.audioPlayers.length, 1);
  assert.equal(lastStatus(browser).status, "applied");
});

test("muting or zero video volume pauses noise and volume changes scale its configured level", async () => {
  const browser = createBrowser();
  browser.runTrainer();
  await apply(browser, noise(0.4));
  const player = browser.audioPlayers[0];
  browser.video.volume = 0.5;
  browser.video.emit("volumechange");
  await browser.flush();
  assert.equal(player.volume, 0.2);
  browser.video.muted = true;
  browser.video.emit("volumechange");
  assert.equal(player.paused, true);
  browser.video.muted = false;
  browser.video.volume = 0;
  browser.video.emit("volumechange");
  await browser.flush();
  assert.equal(player.paused, true);
  browser.video.volume = 1;
  browser.video.emit("volumechange");
  await browser.flush();
  assert.equal(player.paused, false);
  assert.equal(player.volume, 0.4);
  assert.equal(browser.audioPlayers.length, 1);
});

for (const initial of ["paused", "muted", "ended", "silent"]) {
  test(`noise applied to an initially ${initial} video waits until it can be heard`, async () => {
    const video = new MockVideo();
    if (initial === "silent") video.volume = 0;
    else video[initial] = true;
    const browser = createBrowser({ video });
    browser.runTrainer();
    assert.equal((await apply(browser, noise())).status, "applied");
    assert.equal(browser.audioPlayers.length, 0);
    video.paused = false;
    video.muted = false;
    video.ended = false;
    video.volume = 1;
    video.emit(initial === "muted" || initial === "silent" ? "volumechange" : "play");
    await browser.flush();
    assert.equal(browser.audioPlayers.length, 1);
    assert.equal(browser.audioPlayers[0].paused, false);
  });
}

test("OFF resets noise and removes old video's media listeners", async () => {
  const browser = createBrowser();
  browser.runTrainer();
  await apply(browser, noise());
  const player = browser.audioPlayers[0];
  player.currentTime = 25;
  assert.equal((await apply(browser, { enabled: false, mode: "noise" })).status, "applied");
  assertStopped(player);
  const count = browser.postedMessages.length;
  browser.video.emit("play");
  browser.video.emit("volumechange");
  await browser.flush();
  assert.equal(browser.audioPlayers.length, 1);
  assert.equal(browser.postedMessages.length, count);
});

test("replacement immediately stops the old noise and only the new video controls playback", async () => {
  const browser = createBrowser();
  browser.runTrainer();
  await apply(browser, noise());
  const previousVideo = browser.video;
  const previousPlayer = browser.audioPlayers[0];
  previousPlayer.currentTime = 34;
  const nextVideo = new MockVideo();
  nextVideo.paused = true;
  browser.setVideo(nextVideo);
  assertStopped(previousPlayer);
  await browser.flush();
  assert.equal(browser.audioPlayers.length, 1);
  const count = browser.postedMessages.length;
  await previousVideo.play();
  previousVideo.emit("volumechange");
  await browser.flush();
  assert.equal(browser.postedMessages.length, count);
  await nextVideo.play();
  await browser.flush();
  const nextPlayer = browser.audioPlayers[1];
  assert.equal(nextPlayer.paused, false);
  previousVideo.pause();
  assert.equal(nextPlayer.paused, false);
  await apply(browser, { enabled: false });
  assertStopped(nextPlayer);
});

test("removal stops noise even before OFF and OFF prevents a later video from restarting it", async () => {
  const browser = createBrowser();
  browser.runTrainer();
  await apply(browser, noise());
  const player = browser.audioPlayers[0];
  player.currentTime = 34;
  browser.setVideo(null);
  assertStopped(player);
  await browser.flush();
  assert.equal(lastStatus(browser).status, "waiting-video");
  assert.equal((await apply(browser, { enabled: false, mode: "noise" })).status, "applied");
  browser.setVideo(new MockVideo());
  await browser.flush();
  assert.equal(browser.audioPlayers.length, 1);
  assertStopped(player);
});

test("switching the noise URL resets the old player and old media errors are ignored", async () => {
  const browser = createBrowser();
  browser.runTrainer();
  await apply(browser, noise());
  const previous = browser.audioPlayers[0];
  previous.currentTime = 20;
  await apply(browser, noise(0.2, "chrome-extension://test/assets/noise/second.mp3"));
  assertStopped(previous);
  const next = browser.audioPlayers[1];
  assert.equal(next.src, "chrome-extension://test/assets/noise/second.mp3");
  assert.equal(next.volume, 0.2);
  const count = browser.postedMessages.length;
  previous.emit("error");
  await browser.flush();
  assert.equal(next.paused, false);
  assert.equal(browser.postedMessages.length, count);
});

test("speed, lowpass, noise, and OFF retain their original effects and dry original audio", async () => {
  const browser = createBrowser();
  browser.runTrainer();
  await apply(browser, speed(2.5));
  await apply(browser, noise());
  assert.equal(browser.video.playbackRate, 1);
  await apply(browser, lowpass("light"));
  assertStopped(browser.audioPlayers[0]);
  const context = browser.audioContexts[0];
  assertCutoff(context, 4000);
  assert.equal(isBlurred(context), true);
  await apply(browser, noise(0.5));
  assertDry(context);
  assert.equal(browser.audioContexts.length, 1);
  await apply(browser, speed(3));
  assertStopped(browser.audioPlayers[1]);
  assert.equal(browser.video.playbackRate, 3);
  assertDry(context);
  await apply(browser, lowpass("heavy"));
  assertCutoff(context, 900);
  await apply(browser, { enabled: false });
  assert.equal(browser.video.playbackRate, 1);
  assertDry(context);
});

test("noise restores a cached lowpass graph's dry audio and never reports success while it is blocked", async () => {
  let blocked = true;
  const browser = createBrowser({ audioContextState: "suspended", resumeAudioContext: () => {
    if (blocked) throw Object.assign(new Error("Gesture required"), { name: "NotAllowedError" });
  } });
  browser.runTrainer();
  assert.equal((await apply(browser, lowpass())).status, "waiting-user-gesture");
  const context = browser.audioContexts[0];
  assert.equal(context.state, "suspended");
  const waiting = await apply(browser, noise());
  assert.equal(waiting.status, "waiting-user-gesture");
  assert.equal(waiting.reason, "audio-context-blocked");
  assert.equal(context.resumeCalls, 2);
  assert.equal(browser.audioContexts.length, 1);
  assert.equal(browser.audioPlayers.length, 0);
  assert.equal(isDry(context), true);

  blocked = false;
  assert.equal((await apply(browser, noise())).status, "applied");
  assertDry(context);
  assert.equal(browser.audioContexts.length, 1);
  assert.equal(browser.audioPlayers[0].paused, false);
});

test("OFF invalidates a noise request waiting for an old lowpass graph to resume", async () => {
  const pending = [];
  const browser = createBrowser({ audioContextState: "suspended", resumeAudioContext: () => {
    const resume = deferred();
    pending.push(resume);
    return resume.promise;
  } });
  browser.runTrainer();
  await apply(browser, lowpass());
  await apply(browser, noise());
  assert.equal(browser.audioContexts.length, 1);
  assert.equal(browser.audioPlayers.length, 0);
  assert.equal((await apply(browser, { enabled: false })).status, "applied");
  const count = browser.postedMessages.length;
  pending[1].resolve();
  pending[0].resolve();
  await browser.flush();
  assertDry(browser.audioContexts[0]);
  assert.equal(browser.audioPlayers.length, 0);
  assert.equal(browser.postedMessages.length, count);
  assert.equal(lastStatus(browser).status, "applied");
});

test("pagehide stops noise synchronously and pageshow restores it once", async () => {
  const browser = createBrowser();
  browser.runTrainer();
  await apply(browser, noise());
  const previous = browser.audioPlayers[0];
  previous.currentTime = 37;
  browser.dispatchWindowEvent("pagehide", { persisted: true });
  assertStopped(previous);
  browser.video.emit("play");
  await browser.flush();
  assert.equal(browser.audioPlayers.length, 1);
  browser.dispatchWindowEvent("pageshow", { persisted: true });
  await browser.flush();
  assert.equal(browser.audioPlayers.length, 2);
  assert.equal(browser.audioPlayers[1].paused, false);
});

test("blocked noise reports waiting-user-gesture and a later video play retries successfully", async () => {
  let blocked = true;
  const browser = createBrowser({ playNoise: () => {
    if (blocked) throw Object.assign(new Error("Gesture required"), { name: "NotAllowedError" });
  } });
  browser.runTrainer();
  const status = await apply(browser, noise());
  assert.equal(status.status, "waiting-user-gesture");
  assert.equal(status.reason, "noise-play-blocked");
  assert.equal(browser.audioPlayers[0].paused, true);
  blocked = false;
  browser.video.emit("play");
  await browser.flush();
  assert.equal(browser.audioPlayers[0].paused, false);
  assert.equal(lastStatus(browser).status, "applied");
});

test("noise play and media failures are reported without claiming success", async () => {
  const browser = createBrowser({ noisePlayError: new Error("Missing resource") });
  browser.runTrainer();
  const status = await apply(browser, noise());
  assert.equal(status.status, "failed");
  assert.equal(status.reason, "noise-play-failed");
  assert.equal(browser.audioPlayers[0].paused, true);
  assert.equal((await apply(browser, noise(0.3, ""))).reason, "noise-url-missing");

  const playing = createBrowser();
  playing.runTrainer();
  await apply(playing, noise());
  playing.audioPlayers[0].emit("error");
  await playing.flush();
  assertStopped(playing.audioPlayers[0]);
  assert.equal(lastStatus(playing).reason, "noise-media-failed");
});

for (const settle of ["resolve", "reject"]) {
  test(`OFF immediately stops pending noise and its late ${settle} cannot restart it`, async () => {
    const play = deferred();
    const browser = createBrowser({ playNoise: () => play.promise });
    browser.runTrainer();
    await apply(browser, noise());
    const player = browser.audioPlayers[0];
    assert.equal(player.playCalls, 1);
    assert.equal((await apply(browser, { enabled: false })).status, "applied");
    assertStopped(player);
    const count = browser.postedMessages.length;
    if (settle === "resolve") play.resolve();
    else play.reject(new Error("Late failure"));
    await browser.flush();
    assertStopped(player);
    assert.equal(lastStatus(browser).status, "applied");
    assert.equal(browser.postedMessages.length, count);
  });
}

for (const interruption of ["pause", "mute", "replace", "url"]) {
  test(`a pending player invalidated by ${interruption} cannot stop a newer successful player`, async () => {
    const pending = [];
    const browser = createBrowser({ playNoise: () => {
      const operation = deferred();
      pending.push(operation);
      return operation.promise;
    } });
    browser.runTrainer();
    await apply(browser, noise());
    const previous = browser.audioPlayers[0];
    if (interruption === "pause") {
      browser.video.pause();
      await browser.video.play();
    } else if (interruption === "mute") {
      browser.video.muted = true;
      browser.video.emit("volumechange");
      browser.video.muted = false;
      browser.video.emit("volumechange");
    } else if (interruption === "replace") {
      browser.setVideo(new MockVideo());
    } else {
      await apply(browser, noise(0.2, "chrome-extension://test/assets/noise/second.mp3"));
    }
    await browser.flush();
    const next = browser.audioPlayers[1];
    assertStopped(previous);
    assert.ok(next);
    assert.notEqual(previous, next);
    pending[1].resolve();
    await browser.flush();
    assert.equal(next.paused, false);
    const pauseCalls = next.pauseCalls;
    const count = browser.postedMessages.length;
    pending[0].resolve();
    await browser.flush();
    assertStopped(previous);
    assert.equal(next.paused, false);
    assert.equal(next.pauseCalls, pauseCalls);
    assert.equal(browser.postedMessages.length, count);
    assert.equal(lastStatus(browser).status, "applied");
  });
}

test("an old player's rejected promise cannot overwrite the replacement's applied status", async () => {
  const pending = [];
  const browser = createBrowser({ playNoise: () => {
    const operation = deferred();
    pending.push(operation);
    return operation.promise;
  } });
  browser.runTrainer();
  await apply(browser, noise());
  browser.setVideo(new MockVideo());
  await browser.flush();
  pending[1].resolve();
  await browser.flush();
  const next = browser.audioPlayers[1];
  const pauseCalls = next.pauseCalls;
  const count = browser.postedMessages.length;
  pending[0].reject(Object.assign(new Error("Old blocked request"), { name: "NotAllowedError" }));
  await browser.flush();
  assertStopped(browser.audioPlayers[0]);
  assert.equal(next.paused, false);
  assert.equal(next.pauseCalls, pauseCalls);
  assert.equal(browser.postedMessages.length, count);
  assert.equal(lastStatus(browser).status, "applied");
});

test("repeated play or volume events share one pending play request", async () => {
  const play = deferred();
  const browser = createBrowser({ playNoise: () => play.promise });
  browser.runTrainer();
  await apply(browser, noise());
  for (let count = 0; count < 10; count += 1) {
    browser.video.emit("play");
    browser.video.emit("volumechange");
  }
  await browser.flush();
  assert.equal(browser.audioPlayers.length, 1);
  assert.equal(browser.audioPlayers[0].playCalls, 1);
  play.resolve();
  await browser.flush();
  assert.equal(browser.audioPlayers[0].paused, false);
  assert.equal(lastStatus(browser).status, "applied");
});

test("a removed video's pending noise stays stopped after OFF without a video and later attachment", async () => {
  const play = deferred();
  const browser = createBrowser({ playNoise: () => play.promise });
  browser.runTrainer();
  await apply(browser, noise());
  const previous = browser.audioPlayers[0];
  browser.setVideo(null);
  assertStopped(previous);
  await browser.flush();
  assert.equal(lastStatus(browser).status, "waiting-video");
  assert.equal((await apply(browser, { enabled: false })).status, "applied");
  browser.setVideo(new MockVideo());
  await browser.flush();
  const count = browser.postedMessages.length;
  play.resolve();
  await browser.flush();
  assertStopped(previous);
  assert.equal(browser.audioPlayers.length, 1);
  assert.equal(browser.postedMessages.length, count);
  assert.equal(lastStatus(browser).status, "applied");
});

test("pagehide invalidates pending noise and a late start cannot revive it", async () => {
  const play = deferred();
  const browser = createBrowser({ playNoise: () => play.promise });
  browser.runTrainer();
  await apply(browser, noise());
  const player = browser.audioPlayers[0];
  browser.dispatchWindowEvent("pagehide", { persisted: true });
  assertStopped(player);
  const count = browser.postedMessages.length;
  play.resolve();
  await browser.flush();
  assertStopped(player);
  assert.equal(browser.postedMessages.length, count);
});
