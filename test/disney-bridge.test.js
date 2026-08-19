import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

async function loadDisneyBridge(playlist, { video = null, status = "", timeline = null } = {}) {
  const source = await readFile(new URL("../src/page/disney-bridge.js", import.meta.url), "utf8");
  const posted = [];
  const listeners = new Map();
  const dispatchedKeys = [];
  const response = {
    ok: true,
    url: "https://vod.example.media.dssott.com/path/master.m3u8?token=sanitized",
    headers: { get: () => "application/vnd.apple.mpegurl" },
    clone: () => ({ text: async () => playlist }),
    text: async () => playlist
  };
  function MockXmlHttpRequest() {}
  MockXmlHttpRequest.prototype.open = function () {};
  MockXmlHttpRequest.prototype.send = function () {};
  const window = {
    fetch: async () => response,
    postMessage: (message) => posted.push(message),
    addEventListener: (type, listener) => listeners.set(type, listener)
  };
  window.window = window;
  const activeElement = { dispatchEvent: (event) => dispatchedKeys.push(event.key) };
  const statusElement = { textContent: status };
  class MockElement {
    constructor() {
      this.attributes = new Map();
    }
    getAttribute(name) {
      return this.attributes.get(name) ?? null;
    }
    setAttribute(name, value) {
      this.attributes.set(name, String(value));
    }
    attachShadow() {
      const children = [];
      this.shadowRootForTest = {
        appendChild: (child) => children.push(child),
        querySelector: () => children.find((child) => child.dataset?.dualSubtitlesNative !== undefined) || null,
        querySelectorAll: (selector) => selector === '[aria-valuenow][aria-valuemax]' && this.timelineForTest
          ? [this.timelineForTest]
          : []
      };
      return this.shadowRootForTest;
    }
  }
  vm.runInNewContext(source, {
    Element: MockElement,
    URL,
    document: {
      activeElement,
      body: activeElement,
      createElement: () => ({ dataset: {}, textContent: "" }),
      documentElement: {},
      querySelector: (selector) => selector === ".text-to-speech-status" && status ? statusElement : null,
      querySelectorAll: (selector) => {
        if (selector === "video") return video ? [video] : [];
        if (selector === '[aria-valuenow][aria-valuemax]') return timeline ? [timeline] : [];
        return [];
      }
    },
    KeyboardEvent: class {
      constructor(_type, options) { Object.assign(this, options); }
    },
    MutationObserver: class { observe() {} },
    location: {
      href: "https://www.disneyplus.com/ja-jp/play/sanitized",
      origin: "https://www.disneyplus.com"
    },
    performance: { getEntriesByType: () => [] },
    setInterval: () => 0,
    setTimeout: () => 0,
    window,
    XMLHttpRequest: MockXmlHttpRequest
  });
  await window.fetch(response.url);
  await new Promise((resolve) => setImmediate(resolve));
  return { dispatchedKeys, Element: MockElement, listeners, posted, window };
}

test("Disney bridge discovers subtitle tracks from an HLS master playlist", async () => {
  const bridge = await loadDisneyBridge(`#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",LANGUAGE="en",NAME="English",URI="audio/en.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",LANGUAGE="ja-JP",NAME="日本語",AUTOSELECT=YES,FORCED=NO,URI="text/ja.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",LANGUAGE="en",NAME="English [CC]",CHARACTERISTICS="public.accessibility.describes-music-and-sound",URI="text/en.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",LANGUAGE="en",NAME="English Forced",FORCED=YES,URI="text/en-forced.m3u8"`);
  const discovery = bridge.posted.find((message) => message.type === "TRACKS_DISCOVERED");
  assert.equal(discovery.payload.tracks.length, 3);
  assert.deepEqual(Array.from(discovery.payload.tracks, (track) => track.language), ["ja-jp", "en", "en"]);
  assert.equal(discovery.payload.tracks[0].url, "https://vod.example.media.dssott.com/path/text/ja.m3u8");
  assert.equal(discovery.payload.tracks[1].isSdh, true);
  assert.equal(discovery.payload.tracks[2].isForced, true);
});

test("Disney bridge ignores subtitle playlists outside the Disney media CDN", async () => {
  const bridge = await loadDisneyBridge(`#EXTM3U
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",LANGUAGE="en",NAME="English",URI="https://example.com/subtitles.m3u8"`);
  assert.equal(bridge.posted.some((message) => message.type === "TRACKS_DISCOVERED"), false);
});

test("Disney bridge maps seek actions to native arrow shortcuts", async () => {
  const bridge = await loadDisneyBridge("#EXTM3U");
  const listener = bridge.listeners.get("message");
  listener({
    source: bridge.window,
    origin: "https://www.disneyplus.com",
    data: { source: "netflix-dual-subtitles", type: "PLAYER_SHORTCUT", payload: { action: "seek-backward" } }
  });
  assert.deepEqual(bridge.dispatchedKeys, ["ArrowLeft"]);
  listener({
    source: bridge.window,
    origin: "https://www.disneyplus.com",
    data: { source: "netflix-dual-subtitles", type: "PLAYER_SHORTCUT", payload: { action: "seek-forward" } }
  });
  assert.deepEqual(bridge.dispatchedKeys, ["ArrowLeft", "ArrowRight"]);
});

test("Disney bridge publishes the presentation-time offset", async () => {
  const video = { clientWidth: 1280, clientHeight: 720, currentTime: 19.5 };
  const bridge = await loadDisneyBridge("#EXTM3U", { video, status: "2118500で一時停止しています。" });
  bridge.listeners.get("message")({
    source: bridge.window,
    origin: "https://www.disneyplus.com",
    data: { source: "netflix-dual-subtitles", type: "REQUEST_TRACKS", payload: {} }
  });
  const clock = bridge.posted.find((message) => message.type === "PLAYBACK_CLOCK");
  assert.equal(clock.payload.offsetMs, 2099000);
});

test("Disney bridge uses the player timeline when the live status has no clock value", async () => {
  const video = { clientWidth: 1280, clientHeight: 720, currentTime: 479.466 };
  const timeline = {
    getAttribute: (name) => ({ "aria-valuenow": "3395", "aria-valuemax": "8186" })[name] ?? null
  };
  const bridge = await loadDisneyBridge("#EXTM3U", { video, status: "再生中", timeline });
  bridge.listeners.get("message")({
    source: bridge.window,
    origin: "https://www.disneyplus.com",
    data: { source: "netflix-dual-subtitles", type: "REQUEST_TRACKS", payload: {} }
  });
  const clock = bridge.posted.find((message) => message.type === "PLAYBACK_CLOCK");
  assert.equal(clock.payload.offsetMs, 2915534);
  video.currentTime += 1;
  bridge.listeners.get("message")({
    source: bridge.window,
    origin: "https://www.disneyplus.com",
    data: { source: "netflix-dual-subtitles", type: "REQUEST_TRACKS", payload: {} }
  });
  assert.equal(bridge.posted.filter((message) => message.type === "PLAYBACK_CLOCK").length, 1);
});

test("Disney bridge finds the player timeline inside a closed shadow root", async () => {
  const video = { clientWidth: 1280, clientHeight: 720, currentTime: 479.466 };
  const timeline = {
    getAttribute: (name) => ({ "aria-valuenow": "3395", "aria-valuemax": "8186" })[name] ?? null
  };
  const bridge = await loadDisneyBridge("#EXTM3U", { video, status: "再生中" });
  const player = new bridge.Element();
  player.timelineForTest = timeline;
  player.attachShadow({ mode: "closed" });
  bridge.listeners.get("message")({
    source: bridge.window,
    origin: "https://www.disneyplus.com",
    data: { source: "netflix-dual-subtitles", type: "REQUEST_TRACKS", payload: {} }
  });
  const clock = bridge.posted.find((message) => message.type === "PLAYBACK_CLOCK");
  assert.equal(clock.payload.offsetMs, 2915534);
});

test("Disney bridge hides and restores native captions inside closed shadow roots", async () => {
  const bridge = await loadDisneyBridge("#EXTM3U");
  const player = new bridge.Element();
  const root = player.attachShadow({ mode: "closed" });
  const listener = bridge.listeners.get("message");
  listener({
    source: bridge.window,
    origin: "https://www.disneyplus.com",
    data: { source: "netflix-dual-subtitles", type: "NATIVE_CAPTIONS", payload: { hidden: true } }
  });
  assert.match(root.querySelector("style[data-dual-subtitles-native]").textContent, /visibility: hidden/);
  assert.match(root.querySelector("style[data-dual-subtitles-native]").textContent, /TimedTextOverlay/);
  listener({
    source: bridge.window,
    origin: "https://www.disneyplus.com",
    data: { source: "netflix-dual-subtitles", type: "NATIVE_CAPTIONS", payload: { hidden: false } }
  });
  assert.equal(root.querySelector("style[data-dual-subtitles-native]").textContent, "");
});
