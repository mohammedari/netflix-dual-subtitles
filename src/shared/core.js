export const MESSAGE_SOURCE = "netflix-dual-subtitles";

export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  upperLanguage: "ja",
  fontSize: "medium",
  position: "bottom",
  subtitleOffsetMs: -500,
  shortcutsEnabled: true,
  downloadSubdirectory: "Dual Subtitle Captures"
});

export function normalizeSettings(value = {}) {
  const upperLanguage = value.upperLanguage === "en" ? "en" : "ja";
  const rawSubtitleOffsetMs = value.subtitleOffsetMs === "" ? NaN : Number(value.subtitleOffsetMs);
  const subtitleOffsetMs = Number.isFinite(rawSubtitleOffsetMs)
    ? Math.max(-10000, Math.min(10000, Math.round(rawSubtitleOffsetMs)))
    : DEFAULT_SETTINGS.subtitleOffsetMs;
  return {
    enabled: value.enabled !== false,
    upperLanguage,
    fontSize: ["small", "medium", "large"].includes(value.fontSize) ? value.fontSize : "medium",
    position: ["top", "center", "bottom"].includes(value.position) ? value.position : "bottom",
    subtitleOffsetMs,
    shortcutsEnabled: value.shortcutsEnabled !== false,
    downloadSubdirectory: sanitizeFolder(value.downloadSubdirectory || DEFAULT_SETTINGS.downloadSubdirectory)
  };
}

export function shortcutAction(key, repeat = false) {
  const normalizedKey = String(key || "").toLowerCase();
  if (repeat && ["k", "c"].includes(normalizedKey)) return null;
  return {
    j: "seek-backward",
    k: "toggle-playback",
    l: "seek-forward",
    c: "capture"
  }[normalizedKey] || null;
}

export function sanitizeFolder(value) {
  const cleaned = String(value)
    .replace(/[<>:"|?*\\]/g, "_")
    .replace(/\.{2,}/g, ".")
    .replace(/^[/\s.]+|[/\s.]+$/g, "")
    .slice(0, 80);
  return cleaned || DEFAULT_SETTINGS.downloadSubdirectory;
}

export function sanitizeFilename(value) {
  return String(value || "capture")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 120) || "capture";
}

export function formatMediaTime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return [hours, minutes, secs].map((part) => String(part).padStart(2, "0")).join("-");
}

export function buildCaptureFilename({ folder, title, episode, currentTime, now = new Date() }) {
  const date = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0")
  ].join("");
  const clock = [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map((part) => String(part).padStart(2, "0"))
    .join("");
  const parts = [sanitizeFilename(title), episode && sanitizeFilename(episode), formatMediaTime(currentTime), `${date}-${clock}`].filter(Boolean);
  return `${sanitizeFolder(folder)}/${parts.join("_")}.png`;
}

export function parseClock(value, { tickRate = 1, frameRate = 30 } = {}) {
  const input = String(value || "").trim();
  if (!input) return NaN;
  const unit = input.match(/^([\d.]+)(ms|s|m|h|f|t)$/i);
  if (unit) {
    const safeTickRate = Number(tickRate) > 0 ? Number(tickRate) : 1;
    const safeFrameRate = Number(frameRate) > 0 ? Number(frameRate) : 30;
    const multipliers = { ms: 1, s: 1000, m: 60000, h: 3600000, f: 1000 / safeFrameRate, t: 1000 / safeTickRate };
    return Number(unit[1]) * multipliers[unit[2].toLowerCase()];
  }
  const parts = input.replace(",", ".").split(":").map(Number);
  if (parts.some(Number.isNaN) || parts.length < 2 || parts.length > 4) return NaN;
  if (parts.length === 4) {
    const [hours, minutes, seconds, frames] = parts;
    return ((hours * 3600 + minutes * 60 + seconds) * 1000) + (frames * 1000 / 30);
  }
  const seconds = parts.pop();
  const minutes = parts.pop();
  const hours = parts.pop() || 0;
  return (hours * 3600 + minutes * 60 + seconds) * 1000;
}

function cleanText(value) {
  return String(value || "")
    .replace(/<(?:[\w-]+:)?br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .trim();
}

export function parseWebVtt(text) {
  const normalized = String(text).replace(/^\uFEFF/, "").replace(/\r/g, "");
  const cues = [];
  const documents = normalized.split(/(?=^WEBVTT(?:[ \t]|$))/m).filter((document) => document.trim());
  for (const document of documents.length ? documents : [normalized]) {
    const local = document.match(/X-TIMESTAMP-MAP[^\n]*\bLOCAL:([^,\s]+)/i)?.[1];
    const mpegTs = Number(document.match(/X-TIMESTAMP-MAP[^\n]*\bMPEGTS:(\d+)/i)?.[1]);
    const localMs = parseClock(local);
    const offsetMs = Number.isFinite(mpegTs) && Number.isFinite(localMs) ? (mpegTs / 90) - localMs : 0;
    for (const block of document.split(/\n{2,}/)) {
      const lines = block.trim().split("\n");
      const timingIndex = lines.findIndex((line) => line.includes("-->"));
      if (timingIndex < 0) continue;
      const [rawStart, rawEnd] = lines[timingIndex].split("-->");
      const startMs = parseClock(rawStart.trim()) + offsetMs;
      const endMs = parseClock(rawEnd.trim().split(/\s+/)[0]) + offsetMs;
      const cueText = cleanText(lines.slice(timingIndex + 1).join("\n"));
      if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs && cueText) {
        cues.push({ startMs, endMs, text: cueText });
      }
    }
  }
  return [...new Map(cues.map((cue) => [`${cue.startMs}|${cue.endMs}|${cue.text}`, cue])).values()]
    .sort((a, b) => a.startMs - b.startMs);
}

export function parseHlsSubtitleSegmentUrls(text, baseUrl) {
  const urls = [];
  for (const line of String(text || "").replace(/\r/g, "").split("\n")) {
    const value = line.trim();
    if (!value || value.startsWith("#")) continue;
    try {
      const parsed = new URL(value, baseUrl);
      if (parsed.protocol === "https:" && /\.vtt$/i.test(parsed.pathname)) urls.push(parsed.href);
    } catch {}
  }
  return [...new Set(urls)];
}

export function subtitleLookupTimeMs(playbackTimeMs, subtitleOffsetMs) {
  return Number(playbackTimeMs) - Number(subtitleOffsetMs);
}

export function parseTtml(text) {
  const input = String(text);
  const cues = [];
  const tickRate = Number(input.match(/\b(?:ttp:)?tickRate=["']([\d.]+)["']/i)?.[1]) || 1;
  const frameRate = Number(input.match(/\b(?:ttp:)?frameRate=["']([\d.]+)["']/i)?.[1]) || 30;
  const paragraphPattern = /<(?:[\w-]+:)?p\b([^>]*)>([\s\S]*?)<\/(?:[\w-]+:)?p>/gi;
  for (const match of input.matchAll(paragraphPattern)) {
    const attrs = match[1];
    const begin = attrs.match(/\bbegin=["']([^"']+)["']/i)?.[1];
    const end = attrs.match(/\bend=["']([^"']+)["']/i)?.[1];
    const duration = attrs.match(/\bdur=["']([^"']+)["']/i)?.[1];
    const clockOptions = { tickRate, frameRate };
    const startMs = parseClock(begin, clockOptions);
    const endMs = end ? parseClock(end, clockOptions) : startMs + parseClock(duration, clockOptions);
    const cueText = cleanText(match[2]);
    if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs && cueText) {
      cues.push({ startMs, endMs, text: cueText });
    }
  }
  return cues.sort((a, b) => a.startMs - b.startMs);
}

export function parseSubtitle(text, contentType = "") {
  const input = String(text || "");
  if (/vtt/i.test(contentType) || /^\s*WEBVTT/i.test(input)) return parseWebVtt(input);
  if (/xml|ttml|dfxp/i.test(contentType) || /<tt[\s>]|<p\b/i.test(input)) return parseTtml(input);
  return [];
}

export function activeCueText(cues, timeMs) {
  if (!Array.isArray(cues) || !cues.length) return "";
  let low = 0;
  let high = cues.length - 1;
  let candidate = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (cues[mid].startMs <= timeMs) {
      candidate = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  if (candidate < 0) return "";
  const matches = [];
  for (let index = candidate; index >= 0 && cues[index].startMs <= timeMs; index -= 1) {
    if (cues[index].endMs > timeMs) matches.unshift(cues[index].text);
    if (candidate - index > 20) break;
  }
  return [...new Set(matches)].join("\n");
}

function languageRank(track, desired) {
  const language = String(track.language || "").toLowerCase();
  const normalized = language.replace("_", "-");
  if (normalized === desired) return 0;
  if (normalized.startsWith(`${desired}-`)) return 1;
  return 99;
}

export function chooseTrack(tracks, desiredLanguage) {
  return [...(tracks || [])]
    .filter((track) => languageRank(track, desiredLanguage) < 99 && track.url)
    .sort((a, b) => {
      const languageDifference = languageRank(a, desiredLanguage) - languageRank(b, desiredLanguage);
      if (languageDifference) return languageDifference;
      const forcedDifference = Number(Boolean(a.isForced)) - Number(Boolean(b.isForced));
      if (forcedDifference) return forcedDifference;
      return Number(Boolean(a.isSdh)) - Number(Boolean(b.isSdh));
    })[0] || null;
}

export function isLikelyBlackFrame(pixelData, { threshold = 5, requiredRatio = 0.95 } = {}) {
  if (!pixelData?.length) return false;
  let dark = 0;
  let total = 0;
  for (let index = 0; index + 3 < pixelData.length; index += 16) {
    if (pixelData[index + 3] < 220) continue;
    total += 1;
    const luminance = 0.2126 * pixelData[index] + 0.7152 * pixelData[index + 1] + 0.0722 * pixelData[index + 2];
    if (luminance <= threshold) dark += 1;
  }
  return total > 0 && dark / total >= requiredRatio;
}
