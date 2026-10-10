const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createBrowser, createPopup, assertCutoff, blurCutoff, isDry, isBlurred, graphNodes
} = require("./helpers/browser.cjs");

const LEVELS = { 1: 4000, 2: 2800, 3: 2000, 4: 1400, 5: 900 };
const blur = (level) => ({ enabled: true, mode: "gaussian", blurLevel: level });

function lastStatus(browser) {
  return browser.postedMessages.filter((message) => message.type === "TRAINER_STATUS").at(-1)?.payload;
}

async function apply(browser, settings) {
  browser.window.postMessage({ source: "PROF_FANG_EXTENSION", type: "APPLY_SETTINGS", payload: settings }, "*");
  await browser.flush();
  return lastStatus(browser);
}

async function settle(browser, rounds = 5) {
  for (let i = 0; i < rounds; i += 1) {
    await browser.flush();
    await new Promise(setImmediate);
  }
}

function convolvers(context) {
  return context.nodes.filter((node) => node.kind === "convolver");
}

function connectedChains(context) {
  const { input } = graphNodes(context);
  return convolvers(context).filter((node) => input.connections.has(node));
}

function activeConvolver(context) {
  const { mix } = graphNodes(context);
  return connectedChains(context).find((node) => {
    const gain = [...node.connections][0];
    return gain.gain.value > 0 && gain.connections.has(mix);
  });
}

// Magnitude of the FIR kernel's frequency response, in dB.
function responseDb(convolver, frequency) {
  const kernel = convolver.buffer.getChannelData(0);
  const rate = convolver.buffer.sampleRate;
  let re = 0;
  let im = 0;
  kernel.forEach((value, index) => {
    const phase = -2 * Math.PI * frequency * index / rate;
    re += value * Math.cos(phase);
    im += value * Math.sin(phase);
  });
  return 20 * Math.log10(Math.hypot(re, im));
}

test("each blur level is a Gaussian kernel with the documented cutoff", async () => {
  for (const sampleRate of [44100, 48000]) {
    const browser = createBrowser({ sampleRate });
    browser.runTrainer();
    for (const [level, cutoff] of Object.entries(LEVELS)) {
      assert.equal((await apply(browser, blur(Number(level)))).status, "applied");
      const context = browser.audioContexts[0];
      assertCutoff(context, cutoff);
      const convolver = activeConvolver(context);
      const kernel = Array.from(convolver.buffer.getChannelData(0));
      assert.equal(convolver.normalize, false);
      assert.equal(convolver.buffer.sampleRate, sampleRate);
      assert.equal(kernel.length % 2, 1);
      assert.ok(Math.abs(kernel.reduce((a, b) => a + b, 0) - 1) < 1e-6);
      assert.deepEqual(kernel, [...kernel].reverse());
      const peak = kernel.indexOf(Math.max(...kernel));
      assert.equal(peak, (kernel.length - 1) / 2);
    }
  }
});

test("the frequency response is Gaussian: -3 dB at cutoff, then falls faster", async () => {
  const browser = createBrowser();
  browser.runTrainer();
  for (const [level, cutoff] of Object.entries(LEVELS)) {
    await apply(browser, blur(Number(level)));
    const convolver = activeConvolver(browser.audioContexts[0]);
    assert.ok(Math.abs(responseDb(convolver, 0)) < 0.01);
    assert.ok(Math.abs(responseDb(convolver, cutoff) + 3.01) < 0.3, `level ${level} at cutoff`);
    // A Gaussian is -12 dB at 2x and -48 dB at 4x; a 2nd-order biquad is
    // only about -12 dB and -24 dB there.
    assert.ok(Math.abs(responseDb(convolver, cutoff * 2) + 12.04) < 1, `level ${level} at 2x`);
    if (cutoff * 4 < 20000) {
      assert.ok(responseDb(convolver, cutoff * 4) < -40, `level ${level} at 4x`);
    }
  }
});

test("blur turns on and off by crossfading, never by cutting the dry path", async () => {
  const browser = createBrowser();
  browser.runTrainer();
  await apply(browser, blur(3));
  const context = browser.audioContexts[0];
  const { input, dry, mix } = graphNodes(context);
  assert.equal(isBlurred(context), true);
  assert.equal(input.connections.has(dry), true);
  assert.equal(dry.connections.has(mix), true);
  const wetGain = [...activeConvolver(context).connections][0];
  assert.equal(wetGain.gain.value, 1.12);
  for (const param of [dry.gain, wetGain.gain]) {
    const target = param.events.filter(([kind]) => kind === "target").at(-1);
    assert.equal(target[3], 0.01);
  }

  await apply(browser, { enabled: false });
  assert.equal(isDry(context), true);
  assert.equal(input.connections.has(dry), true);
  // The faded chain stays connected while it ramps down.
  assert.equal(wetGain.gain.value, 0);
});

test("changing level crossfades, then releases the silent old chain", async () => {
  const browser = createBrowser();
  browser.runTrainer();
  await apply(browser, blur(1));
  await apply(browser, blur(3));
  const context = browser.audioContexts[0];
  assertCutoff(context, 2000);
  // The old chain keeps playing while it ramps down: no hard cut.
  assert.equal(connectedChains(context).length, 2);
  browser.advanceTimers(200);
  assert.equal(connectedChains(context).length, 1);
  assertCutoff(context, 2000);

  await apply(browser, blur(5));
  await apply(browser, blur(2));
  await apply(browser, blur(4));
  assertCutoff(context, 1400);
  browser.advanceTimers(200);
  assert.equal(connectedChains(context).length, 1);
  assertCutoff(context, 1400);

  await apply(browser, { enabled: false });
  browser.advanceTimers(200);
  assert.equal(connectedChains(context).length, 0);
  assert.equal(isDry(context), true);
  assert.equal(browser.timers.size, 0);
  assert.equal(browser.audioContexts.length, 1);
});

test("reapplying the same level reuses its chain without a gap", async () => {
  const browser = createBrowser();
  browser.runTrainer();
  await apply(browser, blur(4));
  const context = browser.audioContexts[0];
  const first = activeConvolver(context);
  await apply(browser, blur(4));
  await apply(browser, blur(4));
  assert.equal(activeConvolver(context), first);
  assert.equal(convolvers(context).length, 1);
  assertCutoff(context, 1400);
});

test("an explicit blur level wins over a legacy preset, and invalid levels fall back", async () => {
  const browser = createBrowser();
  browser.runTrainer();
  await apply(browser, { enabled: true, mode: "lowpass", lowPassPreset: "light", blurLevel: 4 });
  assertCutoff(browser.audioContexts[0], 1400);
  await apply(browser, blur(9));
  assertCutoff(browser.audioContexts[0], 2000);
  await apply(browser, { enabled: true, mode: "lowpass", lowPassPreset: "unknown" });
  assertCutoff(browser.audioContexts[0], 2000);
});

test("speed and noise leave a previously blurred graph fully dry", async () => {
  const browser = createBrowser();
  browser.runTrainer();
  await apply(browser, blur(5));
  const context = browser.audioContexts[0];
  await apply(browser, { enabled: true, mode: "speed", speed: 2 });
  assert.equal(isDry(context), true);
  assert.equal(blurCutoff(context), null);
  assert.equal(browser.video.playbackRate, 2);
});

test("the popup migrates a saved Low-Pass setting to Gaussian blur", async () => {
  const browser = createBrowser({ storedState: { enabled: true, mode: "lowpass", lowPassPreset: "heavy" } });
  browser.runContent();
  browser.loadTrainer();
  await settle(browser);
  assertCutoff(browser.audioContexts[0], 900);

  const popup = createPopup(browser);
  await settle(browser);
  assert.equal(popup.modeRadios.find((radio) => radio.checked).value, "gaussian");
  assert.equal(popup.element("blurLevel").value, "5");
  assert.equal(popup.element("blurLevelLabel").textContent, "Heavy · ~900 Hz");
  assert.equal(popup.element("blurSettings").classList.contains("hidden"), false);
  assert.equal(popup.status, "Applied");

  const slider = popup.element("blurLevel");
  slider.value = "2";
  slider.fire("input");
  assert.equal(popup.element("blurLevelLabel").textContent, "Mild · ~2800 Hz");
  slider.fire("change");
  await settle(browser);
  assertCutoff(browser.audioContexts[0], 2800);
  assert.equal(popup.status, "Applied");
  assert.equal(browser.storedState.mode, "gaussian");
  assert.equal(browser.storedState.blurLevel, 2);
  assert.equal("lowPassPreset" in browser.storedState, false);
});

test("choosing Gaussian Blur in the popup applies the default medium level", async () => {
  const browser = createBrowser();
  browser.runContent();
  browser.loadTrainer();
  await settle(browser);
  const popup = createPopup(browser);
  await settle(browser);
  popup.setEnabled(true);
  await settle(browser);
  popup.setMode("gaussian");
  await settle(browser);
  assertCutoff(browser.audioContexts[0], 2000);
  assert.equal(popup.element("blurLevelLabel").textContent, "Medium · ~2000 Hz");
  assert.equal(popup.status, "Applied");
});
