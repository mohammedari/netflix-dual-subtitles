import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

async function loadDisneyBridge(playlist, { video = null, status = "", timeline = null, player = null } = {}) {
  const source = await readFile(new URL("../src/page/disney-bridge.js", import.meta.url), "utf8");
  const posted = [];
  const listeners = new Map();
  const dispatchedKeys = [];
  const videoListeners = new Map();
  const timers = new Map();
  let nextTimerId = 1;
  if (video) {
    video.addEventListener = (type, listener) => {
      const callbacks = videoListeners.get(type) || [];
      callbacks.push(listener);
      videoListeners.set(type, callbacks);
    };
  }
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
      this.isConnected = true;
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
        host: this,
        appendChild: (child) => children.push(child),
        querySelector: () => children.find((child) => child.dataset?.dualSubtitlesNative !== undefined) || null,
        querySelectorAll: (selector) => {
          if (selector === '[aria-valuenow][aria-valuemax]' && this.timelineForTest) return [this.timelineForTest];
          if (selector === "[aria-label]") return this.seekControlsForTest || [];
          return [];
        }
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
        if (selector === "disney-web-player") return player ? [player] : [];
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
    setTimeout: (callback, delay) => {
      if (delay === 0) return 0;
      const id = nextTimerId++;
      timers.set(id, callback);
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    window,
    XMLHttpRequest: MockXmlHttpRequest
  });
  await window.fetch(response.url);
  await new Promise((resolve) => setImmediate(resolve));
  return {
    dispatchedKeys,
    dispatchVideoEvent: (type) => {
      for (const listener of videoListeners.get(type) || []) listener();
    },
    Element: MockElement,
    flushTimers: () => {
      const callbacks = [...timers.values()];
      timers.clear();
      for (const callback of callbacks) callback();
    },
    listeners,
    posted,
    window
  };
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

test("Disney bridge falls back to native arrow shortcuts when player controls are unavailable", async () => {
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

test("Disney bridge uses the player 10-second controls for seek actions", async () => {
  const bridge = await loadDisneyBridge("#EXTM3U");
  const clicks = [];
  const player = new bridge.Element();
  player.seekControlsForTest = [
    {
      click: () => clicks.push("backward"),
      getAttribute: (name) => name === "aria-label" ? "10秒前にスキップ" : null
    },
    {
      click: () => clicks.push("forward"),
      getAttribute: (name) => name === "aria-label" ? "Skip forward 10 seconds" : null
    }
  ];
  player.attachShadow({ mode: "closed" });
  const listener = bridge.listeners.get("message");
  for (const action of ["seek-backward", "seek-forward"]) {
    listener({
      source: bridge.window,
      origin: "https://www.disneyplus.com",
      data: { source: "netflix-dual-subtitles", type: "PLAYER_SHORTCUT", payload: { action } }
    });
  }

  assert.deepEqual(clicks, ["backward", "forward"]);
  assert.deepEqual(bridge.dispatchedKeys, []);
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

test("Disney bridge prefers the absolute internal playback-session timeline", async () => {
  const video = { clientWidth: 1280, clientHeight: 720, currentTime: 35.8359 };
  const player = {
    isConnected: true,
    mediaElement: video,
    mediaPlayer: {
      playbackSession: {
        timeline: { playheadPositionMs: 35835, zeroPositionProgramDateTimeMs: 1849000 }
      }
    }
  };
  const timeline = {
    getAttribute: (name) => ({ "aria-valuenow": "1800", "aria-valuemax": "2200" })[name] ?? null
  };
  const bridge = await loadDisneyBridge("#EXTM3U", {
    video,
    player,
    timeline,
    status: "1750000で一時停止しています。"
  });
  bridge.listeners.get("message")({
    source: bridge.window,
    origin: "https://www.disneyplus.com",
    data: { source: "netflix-dual-subtitles", type: "REQUEST_TRACKS", payload: {} }
  });
  const clock = bridge.posted.find((message) => message.type === "PLAYBACK_CLOCK");
  assert.equal(clock.payload.presentationTimeMs, 1884835);
  assert.ok(Math.abs(clock.payload.offsetMs - 1848999) <= 1);
});

test("Disney bridge ignores an internal timeline without an absolute zero position", async () => {
  const video = { clientWidth: 1280, clientHeight: 720, currentTime: 35 };
  const player = {
    isConnected: true,
    mediaElement: video,
    mediaPlayer: {
      playbackSession: {
        timeline: { playheadPositionMs: 35000, zeroPositionProgramDateTimeMs: null }
      }
    }
  };
  const timeline = {
    getAttribute: (name) => ({ "aria-valuenow": "1884", "aria-valuemax": "2200" })[name] ?? null
  };
  const bridge = await loadDisneyBridge("#EXTM3U", { video, player, timeline });
  bridge.listeners.get("message")({
    source: bridge.window,
    origin: "https://www.disneyplus.com",
    data: { source: "netflix-dual-subtitles", type: "REQUEST_TRACKS", payload: {} }
  });
  const clock = bridge.posted.find((message) => message.type === "PLAYBACK_CLOCK");
  assert.equal(clock.payload.presentationTimeMs, 1884000);
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

test("Disney bridge accepts a new media timeline after seeking", async () => {
  const video = { clientWidth: 1280, clientHeight: 720, currentTime: 30.154654 };
  let presentationTime = 1575.671;
  const timeline = {
    getAttribute: (name) => ({ "aria-valuenow": String(presentationTime), "aria-valuemax": "2200" })[name] ?? null
  };
  const bridge = await loadDisneyBridge("#EXTM3U", { video, timeline });
  const requestClock = () => bridge.listeners.get("message")({
    source: bridge.window,
    origin: "https://www.disneyplus.com",
    data: { source: "netflix-dual-subtitles", type: "REQUEST_TRACKS", payload: {} }
  });

  requestClock();
  presentationTime += 10;
  video.currentTime = 12.65476;
  requestClock();

  const clocks = bridge.posted.filter((message) => message.type === "PLAYBACK_CLOCK");
  assert.equal(clocks.length, 2);
  assert.equal(clocks[0].payload.presentationTimeMs, 1575671);
  assert.ok(Math.abs(clocks[0].payload.videoTimeMs - 30154.654) < 0.001);
  assert.equal(clocks[1].payload.offsetMs, 1573016);
});

test("Disney bridge republishes the anchor after the video seek settles", async () => {
  const video = { clientWidth: 1280, clientHeight: 720, currentTime: 30.154654, seeking: false };
  let presentationTime = 1575.671;
  const timeline = {
    getAttribute: (name) => ({ "aria-valuenow": String(presentationTime), "aria-valuemax": "2200" })[name] ?? null
  };
  const bridge = await loadDisneyBridge("#EXTM3U", { video, timeline });
  bridge.listeners.get("message")({
    source: bridge.window,
    origin: "https://www.disneyplus.com",
    data: { source: "netflix-dual-subtitles", type: "REQUEST_TRACKS", payload: {} }
  });

  presentationTime += 10;
  video.currentTime = 12.65476;
  bridge.dispatchVideoEvent("seeked");
  bridge.flushTimers();

  const clocks = bridge.posted.filter((message) => message.type === "PLAYBACK_CLOCK");
  assert.equal(clocks.length, 2);
  assert.equal(clocks[1].payload.presentationTimeMs, 1585671);
  assert.ok(Math.abs(clocks[1].payload.videoTimeMs - 12654.76) < 0.001);
});

test("Disney bridge does not reuse a stale accessibility status after seeking", async () => {
  const video = { clientWidth: 1280, clientHeight: 720, currentTime: 30.154654, seeking: false };
  const bridge = await loadDisneyBridge("#EXTM3U", { video, status: "1575671で一時停止しています。" });
  bridge.listeners.get("message")({
    source: bridge.window,
    origin: "https://www.disneyplus.com",
    data: { source: "netflix-dual-subtitles", type: "REQUEST_TRACKS", payload: {} }
  });

  video.currentTime = 12.65476;
  bridge.dispatchVideoEvent("seeked");
  bridge.flushTimers();

  const clocks = bridge.posted.filter((message) => message.type === "PLAYBACK_CLOCK");
  assert.equal(clocks.length, 1);
  assert.equal(clocks[0].payload.presentationTimeMs, 1575671);
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

test("Disney bridge ignores a detached player timeline after the player is replaced", async () => {
  const video = { clientWidth: 1280, clientHeight: 720, currentTime: 10 };
  const bridge = await loadDisneyBridge("#EXTM3U", { video });
  const firstPlayer = new bridge.Element();
  firstPlayer.timelineForTest = {
    getAttribute: (name) => ({ "aria-valuenow": "100", "aria-valuemax": "2200" })[name] ?? null
  };
  firstPlayer.attachShadow({ mode: "closed" });
  const requestClock = () => bridge.listeners.get("message")({
    source: bridge.window,
    origin: "https://www.disneyplus.com",
    data: { source: "netflix-dual-subtitles", type: "REQUEST_TRACKS", payload: {} }
  });
  requestClock();

  firstPlayer.isConnected = false;
  video.currentTime = 20;
  const replacementPlayer = new bridge.Element();
  replacementPlayer.timelineForTest = {
    getAttribute: (name) => ({ "aria-valuenow": "200", "aria-valuemax": "2200" })[name] ?? null
  };
  replacementPlayer.attachShadow({ mode: "closed" });
  requestClock();

  const clocks = bridge.posted.filter((message) => message.type === "PLAYBACK_CLOCK");
  assert.deepEqual(Array.from(clocks, (clock) => clock.payload.presentationTimeMs), [100000, 200000]);
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
