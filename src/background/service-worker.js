import { isLikelyBlackFrame, parseHlsSubtitleSegmentUrls, sanitizeFolder } from "../shared/core.js";

const allowedSubtitleHosts = /(^|\.)(netflix\.com|nflxvideo\.net|nflxso\.net|nflximg\.net|media\.dssott\.com)$/i;
const allowedPageHosts = /(^|\.)(netflix\.com|disneyplus\.com)$/i;
const MAX_SUBTITLE_LENGTH = 5_000_000;

function allowedHttpsUrl(url, allowedHosts = allowedSubtitleHosts) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || !allowedHosts.test(parsed.hostname)) throw new Error("URL is not allowed");
  return parsed;
}

async function fetchText(url) {
  const parsed = allowedHttpsUrl(url);
  const response = await fetch(parsed.href, { credentials: "omit" });
  if (!response.ok) throw new Error(`Subtitle request failed (${response.status})`);
  const text = await response.text();
  if (text.length > MAX_SUBTITLE_LENGTH) throw new Error("Subtitle response is too large");
  return { text, contentType: response.headers.get("content-type") || "", url: response.url || parsed.href };
}

async function fetchHlsSubtitle(playlist) {
  const segmentUrls = parseHlsSubtitleSegmentUrls(playlist.text, playlist.url);
  if (!segmentUrls.length || segmentUrls.length > 500) throw new Error("Unsupported or empty subtitle playlist");
  const segments = new Array(segmentUrls.length);
  let cursor = 0;
  let totalLength = 0;
  async function worker() {
    while (cursor < segmentUrls.length) {
      const index = cursor;
      cursor += 1;
      const segment = await fetchText(segmentUrls[index]);
      totalLength += segment.text.length;
      if (totalLength > MAX_SUBTITLE_LENGTH) throw new Error("Subtitle response is too large");
      segments[index] = segment.text;
    }
  }
  await Promise.all(Array.from({ length: Math.min(6, segmentUrls.length) }, () => worker()));
  return { text: segments.join("\n\n"), contentType: "text/vtt" };
}

async function fetchSubtitle(url) {
  const payload = await fetchText(url);
  if (/\.m3u8(?:[?#]|$)/i.test(payload.url) || /mpegurl/i.test(payload.contentType)) return fetchHlsSubtitle(payload);
  return { text: payload.text, contentType: payload.contentType };
}

async function detectBlackFrame(dataUrl) {
  try {
    const blob = await (await fetch(dataUrl)).blob();
    const bitmap = await createImageBitmap(blob);
    const width = Math.max(1, Math.floor(bitmap.width * 0.5));
    const height = Math.max(1, Math.floor(bitmap.height * 0.5));
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(bitmap, bitmap.width * 0.25, bitmap.height * 0.2, width, height, 0, 0, width, height);
    bitmap.close();
    return isLikelyBlackFrame(context.getImageData(0, 0, width, height).data);
  } catch {
    return false;
  }
}

function safeDownloadPath(filename) {
  const pieces = String(filename || "Dual Subtitle Captures/capture.png").split("/").filter(Boolean);
  const file = (pieces.pop() || "capture.png").replace(/[<>:"\\|?*\u0000-\u001f]/g, "_");
  return `${sanitizeFolder(pieces.join("/") || "Dual Subtitle Captures")}/${file.endsWith(".png") ? file : `${file}.png`}`;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!["CAPTURE_VISIBLE_TAB", "FETCH_SUBTITLE"].includes(message?.type)) return undefined;
  (async () => {
    try {
      const pageUrl = sender.tab?.url ? allowedHttpsUrl(sender.tab.url, allowedPageHosts) : null;
      if (!sender.tab?.id || !pageUrl) throw new Error("This action is only available on supported streaming pages");
      if (message.type === "FETCH_SUBTITLE") {
        sendResponse({ ok: true, ...await fetchSubtitle(message.url) });
        return;
      }
      const dataUrl = await chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: "png" });
      const likelyBlack = await detectBlackFrame(dataUrl);
      const downloadId = await chrome.downloads.download({
        url: dataUrl,
        filename: safeDownloadPath(message.filename),
        saveAs: false,
        conflictAction: "uniquify"
      });
      sendResponse({ ok: true, downloadId, likelyBlack });
    } catch (error) {
      sendResponse({ ok: false, error: String(error?.message || error) });
    }
  })();
  return true;
});
