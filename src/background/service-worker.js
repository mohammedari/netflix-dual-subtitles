import { isLikelyBlackFrame, sanitizeFolder } from "../shared/core.js";

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
  const pieces = String(filename || "Netflix Captures/netflix_capture.png").split("/").filter(Boolean);
  const file = (pieces.pop() || "netflix_capture.png").replace(/[<>:"\\|?*\u0000-\u001f]/g, "_");
  return `${sanitizeFolder(pieces.join("/") || "Netflix Captures")}/${file.endsWith(".png") ? file : `${file}.png`}`;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "CAPTURE_VISIBLE_TAB") return undefined;
  (async () => {
    try {
      if (!sender.tab?.id || !sender.tab.url?.startsWith("https://www.netflix.com/")) throw new Error("Capture is only available on Netflix");
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
