(() => {
  "use strict";
  if (window.__netflixDualSubtitlesBridgeInstalled) return;
  window.__netflixDualSubtitlesBridgeInstalled = true;

  const SOURCE = "netflix-dual-subtitles";
  const allowedSubtitleHosts = /(^|\.)(netflix\.com|nflxvideo\.net|nflxso\.net|nflximg\.net)$/i;
  let lastFingerprint = "";
  let lastTracks = [];
  let lastRoute = location.href;
  let internalTrackContainer = null;
  let playerDiscoveryRunning = false;

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

  function subtitleUrls(track) {
    const downloadables = track.ttDownloadables || track.downloadables || {};
    const preferredProfiles = ["webvtt-lssdh-ios8", "webvtt-lssdh", "dfxp-ls-sdh", "simplesdh"];
    const preferred = preferredProfiles.flatMap((profile) => collectUrls(downloadables[profile]));
    return [...preferred, ...collectUrls(track.urls), ...collectUrls(downloadables), ...collectUrls(track)];
  }

  function normalizeTrack(track) {
    const language = String(languageOf(track)).replace("_", "-").toLowerCase();
    if (!language) return null;
    const urls = [...new Set(subtitleUrls(track))];
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

  function netflixPlayer() {
    try {
      const manager = window.netflix?.appContext?.state?.playerApp?.getAPI?.()?.videoPlayer;
      const sessionIds = manager?.getAllPlayerSessionIds?.() || [];
      const watchIds = sessionIds.filter((id) => String(id).includes("watch"));
      const sessionId = watchIds.at(-1) || sessionIds.at(-1);
      return sessionId ? manager.getVideoPlayerBySessionId(sessionId) : null;
    } catch {
      return null;
    }
  }

  function preferredPlayerTrack(tracks, language) {
    return [...tracks]
      .filter((track) => {
        const normalized = String(languageOf(track)).replace("_", "-").toLowerCase();
        return normalized === language || normalized.startsWith(`${language}-`);
      })
      .sort((a, b) => {
        const aLanguage = String(languageOf(a)).replace("_", "-").toLowerCase();
        const bLanguage = String(languageOf(b)).replace("_", "-").toLowerCase();
        const languageDifference = Number(aLanguage !== language) - Number(bLanguage !== language);
        if (languageDifference) return languageDifference;
        const aType = `${a.rawTrackType || ""} ${a.displayName || ""}`;
        const bType = `${b.rawTrackType || ""} ${b.displayName || ""}`;
        return Number(/sdh|closed.?caption|\bcc\b/i.test(aType)) - Number(/sdh|closed.?caption|\bcc\b/i.test(bType));
      })[0] || null;
  }

  function isResolvedSubtitleEntry(value) {
    return value && typeof value === "object"
      && (typeof value.trackId === "string" || typeof value.trackId === "number")
      && Array.isArray(value.urls)
      && value.urls.some((item) => typeof item?.url === "string");
  }

  function findInternalTrackContainer() {
    const root = window.netflix?.player?.MediaSession;
    if (!root || typeof root !== "object") return null;
    const visited = new WeakSet();
    let visitedCount = 0;
    let found = null;
    function walk(value, depth) {
      if (found || !value || typeof value !== "object" || depth > 16 || visited.has(value) || visitedCount >= 100000) return;
      visited.add(value);
      visitedCount += 1;
      if (Array.isArray(value) && value.some(isResolvedSubtitleEntry)) {
        found = value;
        return;
      }
      let keys;
      try { keys = Object.getOwnPropertyNames(value); } catch { return; }
      for (const key of keys) {
        if (key === "__proto__") continue;
        let child;
        try { child = value[key]; } catch { continue; }
        if (child && typeof child === "object") walk(child, depth + 1);
      }
    }
    walk(root, 0);
    return found;
  }

  function resolvedSubtitleUrl(trackId) {
    const id = String(trackId || "");
    if (!id) return null;
    if (!internalTrackContainer?.some(isResolvedSubtitleEntry)) internalTrackContainer = findInternalTrackContainer();
    let entry = internalTrackContainer?.find((item) => String(item?.trackId) === id && isResolvedSubtitleEntry(item));
    if (!entry) {
      internalTrackContainer = findInternalTrackContainer();
      entry = internalTrackContainer?.find((item) => String(item?.trackId) === id && isResolvedSubtitleEntry(item));
    }
    const url = entry?.urls?.find((item) => typeof item?.url === "string")?.url;
    if (!url) return null;
    try {
      const parsed = new URL(url);
      return parsed.protocol === "https:" && allowedSubtitleHosts.test(parsed.hostname) ? parsed.href : null;
    } catch {
      return null;
    }
  }

  async function waitForSubtitleUrl(trackId) {
    for (let attempt = 0; attempt < 48; attempt += 1) {
      const url = resolvedSubtitleUrl(trackId);
      if (url) return url;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return null;
  }

  function publishTracks(tracks) {
    const unique = [...new Map(tracks.map((track) => [`${track.language}|${track.url}`, track])).values()];
    if (!unique.length) return false;
    const fingerprint = unique.map((track) => `${track.language}|${track.url}`).sort().join(";");
    if (fingerprint === lastFingerprint) return true;
    lastFingerprint = fingerprint;
    lastTracks = unique;
    emit("TRACKS_DISCOVERED", { tracks: unique });
    return true;
  }

  async function discoverTracksFromPlayer() {
    if (playerDiscoveryRunning) return;
    const player = netflixPlayer();
    const available = player?.getTimedTextTrackList?.()?.filter((track) => !track?.isNoneTrack) || [];
    if (!player || !available.length) return;
    playerDiscoveryRunning = true;
    const previous = player.getTimedTextTrack?.() || null;
    const noneTrack = player.getTimedTextTrackList?.()?.find((track) => track?.isNoneTrack) || null;
    const resolved = [];
    try {
      for (const language of ["ja", "en"]) {
        const track = preferredPlayerTrack(available, language);
        const trackId = track?.trackId || track?.new_track_id;
        if (!track || !trackId) continue;
        player.setTimedTextTrack(track);
        const url = await waitForSubtitleUrl(trackId);
        if (!url) continue;
        const normalized = normalizeTrack({ ...track, urls: [{ url }] });
        if (normalized) resolved.push(normalized);
      }
      publishTracks(resolved);
    } catch {
      emit("BRIDGE_ERROR", { code: "PLAYER_TRACK_DISCOVERY_FAILED" });
    } finally {
      try {
        if (previous) player.setTimedTextTrack(previous);
        else if (noneTrack) player.setTimedTextTrack(noneTrack);
      } catch {}
      playerDiscoveryRunning = false;
    }
  }

  function syncRoute() {
    if (lastRoute === location.href) return;
    lastRoute = location.href;
    lastFingerprint = "";
    lastTracks = [];
    internalTrackContainer = null;
  }

  function schedulePlayerDiscovery(attempt = 0) {
    syncRoute();
    discoverTracksFromPlayer();
    if (!lastTracks.length && attempt < 30) setTimeout(() => schedulePlayerDiscovery(attempt + 1), 1000);
  }

  function findTrackArrays(value, output = [], depth = 0) {
    if (!value || typeof value !== "object" || depth > 12) return output;
    if (Array.isArray(value)) {
      for (const child of value) findTrackArrays(child, output, depth + 1);
      return output;
    }
    for (const [key, child] of Object.entries(value)) {
      if (Array.isArray(child) && /timed.?text|subtitle|caption/i.test(key)) {
        const normalized = child.map(normalizeTrack).filter(Boolean);
        if (normalized.length) output.push(...normalized);
      }
      findTrackArrays(child, output, depth + 1);
    }
    return output;
  }

  function dispatchPlayerKey(key) {
    const code = key === "ArrowLeft" ? 37 : 39;
    const event = new KeyboardEvent("keydown", { key, code: key, bubbles: true, cancelable: true });
    Object.defineProperties(event, {
      keyCode: { value: code },
      which: { value: code }
    });
    (document.activeElement || document.body || window).dispatchEvent(event);
  }

  function inspectManifest(value) {
    try {
      const tracks = findTrackArrays(value);
      publishTracks(tracks);
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

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin || event.data?.source !== SOURCE) return;
    if (event.data.type === "REQUEST_TRACKS") {
      syncRoute();
      if (lastTracks.length) emit("TRACKS_DISCOVERED", { tracks: lastTracks });
      schedulePlayerDiscovery();
    } else if (event.data.type === "PLAYER_SHORTCUT") {
      const action = event.data.payload?.action;
      if (action === "seek-backward") dispatchPlayerKey("ArrowLeft");
      if (action === "seek-forward") dispatchPlayerKey("ArrowRight");
    }
  });

  emit("BRIDGE_READY");
  schedulePlayerDiscovery();
})();
