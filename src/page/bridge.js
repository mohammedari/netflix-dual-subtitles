(() => {
  "use strict";
  if (window.__netflixDualSubtitlesBridgeInstalled) return;
  window.__netflixDualSubtitlesBridgeInstalled = true;

  const SOURCE = "netflix-dual-subtitles";
  const allowedSubtitleHosts = /(^|\.)(netflix\.com|nflxvideo\.net|nflxso\.net|nflximg\.net)$/i;
  let lastFingerprint = "";
  let lastTracks = [];

  const emit = (type, payload = {}) => window.postMessage({ source: SOURCE, type, payload }, location.origin);

  function languageOf(value) {
    return value?.bcp47 || value?.language || value?.languageCode || value?.lang || value?.locale || "";
  }

  function collectUrls(value, output = []) {
    if (typeof value === "string") {
      if (/^https:\/\//i.test(value)) output.push(value);
      return output;
    }
    if (!value || typeof value !== "object") return output;
    for (const child of Object.values(value)) collectUrls(child, output);
    return output;
  }

  function normalizeTrack(track) {
    const language = String(languageOf(track)).replace("_", "-").toLowerCase();
    if (!language) return null;
    const urls = [...new Set(collectUrls(track.downloadables || track.urls || track.ttDownloadables || track))];
    const url = urls.find((candidate) => {
      try { return allowedSubtitleHosts.test(new URL(candidate).hostname); } catch { return false; }
    });
    if (!url) return null;
    const label = track.displayName || track.languageDescription || track.label || language;
    const rawType = `${track.rawTrackType || ""} ${track.trackType || ""} ${label}`;
    return {
      id: String(track.trackId || track.id || `${language}:${url}`),
      language,
      label: String(label),
      isSdh: /sdh|closed.?caption|\bcc\b/i.test(rawType),
      url
    };
  }

  function findTrackArrays(value, output = [], depth = 0) {
    if (!value || typeof value !== "object" || depth > 12) return output;
    if (Array.isArray(value)) {
      const normalized = value.map(normalizeTrack).filter(Boolean);
      if (normalized.length) output.push(...normalized);
      for (const child of value) findTrackArrays(child, output, depth + 1);
      return output;
    }
    for (const child of Object.values(value)) findTrackArrays(child, output, depth + 1);
    return output;
  }

  function inspectManifest(value) {
    try {
      const tracks = findTrackArrays(value);
      const unique = [...new Map(tracks.map((track) => [`${track.language}|${track.url}`, track])).values()];
      if (!unique.length) return;
      const fingerprint = unique.map((track) => `${track.language}|${track.url}`).sort().join(";");
      if (fingerprint === lastFingerprint) return;
      lastFingerprint = fingerprint;
      lastTracks = unique;
      emit("TRACKS_DISCOVERED", { tracks: unique });
    } catch (error) {
      emit("BRIDGE_ERROR", { code: "MANIFEST_PARSE_FAILED", detail: String(error?.message || error) });
    }
  }

  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);
    const url = String(response.url || args[0]?.url || args[0] || "");
    if (/manifest|playapi|metadata/i.test(url)) {
      response.clone().json().then(inspectManifest).catch(() => {});
    }
    return response;
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__ndsUrl = String(url || "");
    return originalOpen.call(this, method, url, ...rest);
  };
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    if (/manifest|playapi|metadata/i.test(this.__ndsUrl || "")) {
      this.addEventListener("load", () => {
        try {
          const value = this.responseType === "json" ? this.response : JSON.parse(this.responseText);
          inspectManifest(value);
        } catch {}
      }, { once: true });
    }
    return originalSend.apply(this, args);
  };

  window.addEventListener("message", async (event) => {
    if (event.source !== window || event.origin !== location.origin || event.data?.source !== SOURCE) return;
    if (event.data.type === "REQUEST_TRACKS") {
      if (lastTracks.length) emit("TRACKS_DISCOVERED", { tracks: lastTracks });
      return;
    }
    if (event.data.type !== "FETCH_SUBTITLE") return;
    const { requestId, url } = event.data.payload || {};
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" || !allowedSubtitleHosts.test(parsed.hostname)) throw new Error("Subtitle URL is not allowed");
      const response = await originalFetch(parsed.href, { credentials: "include" });
      if (!response.ok) throw new Error(`Subtitle request failed (${response.status})`);
      const text = await response.text();
      emit("SUBTITLE_RESPONSE", { requestId, ok: true, text, contentType: response.headers.get("content-type") || "" });
    } catch (error) {
      emit("SUBTITLE_RESPONSE", { requestId, ok: false, error: String(error?.message || error) });
    }
  });

  emit("BRIDGE_READY");
})();
