import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SETTINGS,
  activeCueText,
  buildCaptureFilename,
  chooseTrack,
  isLikelyBlackFrame,
  normalizeSettings,
  parseClock,
  parseSubtitle,
  sanitizeFolder
} from "../src/shared/core.js";

test("parses supported subtitle clock formats", () => {
  assert.equal(parseClock("00:01:02.500"), 62500);
  assert.equal(parseClock("01:02,250"), 62250);
  assert.equal(parseClock("2.5s"), 2500);
  assert.equal(parseClock("1250ms"), 1250);
});

test("parses WebVTT and strips markup", () => {
  const cues = parseSubtitle(`WEBVTT\n\n1\n00:00:01.000 --> 00:00:03.000 align:center\nHello <b>world</b>\n\n00:00:03.000 --> 00:00:04.000\nSecond`, "text/vtt");
  assert.deepEqual(cues, [
    { startMs: 1000, endMs: 3000, text: "Hello world" },
    { startMs: 3000, endMs: 4000, text: "Second" }
  ]);
});

test("parses TTML end and duration cues", () => {
  const cues = parseSubtitle(`<tt><body><div><p begin="1s" end="2.5s">こんにちは<br/>世界</p><p begin="3s" dur="1s">次</p></div></body></tt>`, "application/ttml+xml");
  assert.deepEqual(cues, [
    { startMs: 1000, endMs: 2500, text: "こんにちは\n世界" },
    { startMs: 3000, endMs: 4000, text: "次" }
  ]);
});

test("returns all overlapping cue text without duplicates", () => {
  const cues = [
    { startMs: 0, endMs: 2000, text: "A" },
    { startMs: 1000, endMs: 3000, text: "B" },
    { startMs: 1200, endMs: 2200, text: "B" }
  ];
  assert.equal(activeCueText(cues, 1500), "A\nB");
  assert.equal(activeCueText(cues, 3500), "");
});

test("prefers exact language and non-SDH tracks", () => {
  const tracks = [
    { language: "en-US", isSdh: false, url: "https://example/en-us" },
    { language: "en", isSdh: true, url: "https://example/en-sdh" },
    { language: "en", isSdh: false, url: "https://example/en" }
  ];
  assert.equal(chooseTrack(tracks, "en").url, "https://example/en");
  assert.equal(chooseTrack(tracks, "ja"), null);
});

test("normalizes invalid settings and download paths", () => {
  const settings = normalizeSettings({ fontSize: "huge", position: "side", downloadSubdirectory: " ../Bad:*Folder/ " });
  assert.equal(settings.fontSize, DEFAULT_SETTINGS.fontSize);
  assert.equal(settings.position, DEFAULT_SETTINGS.position);
  assert.equal(settings.downloadSubdirectory, "Bad__Folder");
  assert.equal(sanitizeFolder(""), "Netflix Captures");
  const filename = buildCaptureFilename({
    folder: "Netflix Captures",
    title: "Bad: Title?",
    episode: "S1/E2",
    currentTime: 62.9,
    now: new Date(2026, 7, 2, 12, 3, 4)
  });
  assert.equal(filename, "Netflix Captures/Bad_ Title__S1_E2_00-01-02_20260802-120304.png");
});

test("detects almost entirely black opaque frames", () => {
  const black = new Uint8ClampedArray(400).fill(0);
  for (let index = 3; index < black.length; index += 4) black[index] = 255;
  assert.equal(isLikelyBlackFrame(black), true);
  black[0] = 255;
  black[1] = 255;
  black[2] = 255;
  black[16] = 255;
  black[17] = 255;
  black[18] = 255;
  assert.equal(isLikelyBlackFrame(black), false);
});
