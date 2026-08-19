import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

async function loadBridge(manifest, { netflix = null, schedule = () => 0 } = {}) {
  const source = await readFile(new URL("../src/page/netflix-bridge.js", import.meta.url), "utf8");
  const posted = [];
  const listeners = new Map();
  const dispatchedKeys = [];
  const response = {
    url: "https://www.netflix.com/manifest",
    clone: () => ({ json: async () => manifest })
  };
  function MockXmlHttpRequest() {}
  MockXmlHttpRequest.prototype.open = function () {};
  MockXmlHttpRequest.prototype.send = function () {};
  const activeElement = { dispatchEvent: (event) => dispatchedKeys.push(event.key) };
  const window = {
    fetch: async () => response,
    postMessage: (message) => posted.push(message),
    addEventListener: (type, listener) => listeners.set(type, listener)
  };
  if (netflix) window.netflix = netflix;
  window.window = window;
  vm.runInNewContext(source, {
    URL,
    console,
    document: { activeElement, body: activeElement },
    KeyboardEvent: class {
      constructor(_type, options) { Object.assign(this, options); }
    },
    location: { origin: "https://www.netflix.com" },
    setTimeout: schedule,
    window,
    XMLHttpRequest: MockXmlHttpRequest
  });
  await window.fetch("https://www.netflix.com/manifest");
  await new Promise((resolve) => setImmediate(resolve));
  return { dispatchedKeys, listeners, posted, window };
}

test("bridge discovers only timed-text tracks from a manifest", async () => {
  const subtitleUrl = "https://subtitle.example.nflxvideo.net/?token=sanitized";
  const audioUrl = "https://audio.example.nflxvideo.net/range/0-4095?token=sanitized";
  const bridge = await loadBridge({
    result: {
      audio_tracks: [{ language: "en", urls: [{ url: audioUrl }] }],
      timedtexttracks: [{
        language: "en",
        ttDownloadables: { "dfxp-ls-sdh": { downloadUrls: { main: subtitleUrl } } }
      }]
    }
  });
  const discovery = bridge.posted.find((message) => message.type === "TRACKS_DISCOVERED");
  assert.equal(discovery.payload.tracks.length, 1);
  assert.equal(discovery.payload.tracks[0].url, subtitleUrl);
  assert.ok(!discovery.payload.tracks.some((track) => track.url === audioUrl));
});

test("bridge maps seek actions to Netflix native arrow shortcuts", async () => {
  const bridge = await loadBridge({});
  const listener = bridge.listeners.get("message");
  listener({
    source: bridge.window,
    origin: "https://www.netflix.com",
    data: { source: "netflix-dual-subtitles", type: "PLAYER_SHORTCUT", payload: { action: "seek-backward" } }
  });
  listener({
    source: bridge.window,
    origin: "https://www.netflix.com",
    data: { source: "netflix-dual-subtitles", type: "PLAYER_SHORTCUT", payload: { action: "seek-forward" } }
  });
  assert.deepEqual(bridge.dispatchedKeys, ["ArrowLeft", "ArrowRight"]);
});

test("bridge resolves current encrypted-manifest tracks from player state", async () => {
  const entries = [];
  const tracks = [
    { isNoneTrack: true, trackId: "none", language: "none" },
    { trackId: "ja-regular", language: "ja", displayName: "日本語", rawTrackType: "subtitles" },
    { trackId: "en-regular", language: "en", displayName: "English", rawTrackType: "subtitles" }
  ];
  let activeTrack = tracks[0];
  const player = {
    getTimedTextTrackList: () => tracks,
    getTimedTextTrack: () => activeTrack,
    setTimedTextTrack(track) {
      activeTrack = track;
      if (!track.isNoneTrack && !entries.some((entry) => entry.trackId === track.trackId)) {
        entries.push({
          trackId: track.trackId,
          profile: "dfxp-ls-sdh",
          urls: [{ url: `https://subtitle.example.nflxvideo.net/${track.trackId}` }]
        });
      }
    }
  };
  const manager = {
    getAllPlayerSessionIds: () => ["watch-main"],
    getVideoPlayerBySessionId: () => player
  };
  const netflix = {
    appContext: { state: { playerApp: { getAPI: () => ({ videoPlayer: manager }) } } },
    player: { MediaSession: { entries } }
  };
  const bridge = await loadBridge({}, { netflix, schedule: (callback) => setImmediate(callback) });
  await new Promise((resolve) => setImmediate(resolve));
  const discovery = bridge.posted.find((message) => message.type === "TRACKS_DISCOVERED");
  assert.deepEqual(Array.from(discovery.payload.tracks, (track) => track.language), ["ja", "en"]);
  assert.equal(activeTrack.trackId, "none");
});
