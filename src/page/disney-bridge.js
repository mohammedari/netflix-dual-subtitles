(() => {
  "use strict";
  if (window.__dualSubtitlesDisneyBridgeInstalled) return;
  window.__dualSubtitlesDisneyBridgeInstalled = true;

  const SOURCE = "netflix-dual-subtitles";
  const allowedSubtitleHosts = /(^|\.)media\.dssott\.com$/i;
  let lastFingerprint = "";
  let lastTracks = [];
  let lastRoute = location.href;
  let lastClockOffset = null;
  let lastPresentationTimeMs = null;
  let clockTimer = null;
  let scheduledClockForce = false;
  let nativeCaptionsHidden = false;
  const inspectedPlaylists = new Set();
  const playerShadowRoots = new Set();
  const observedVideos = new WeakSet();

  const emit = (type, payload = {}) => window.postMessage({ source: SOURCE, type, payload }, location.origin);

  function updateShadowCaptionStyle(root) {
    if (!root?.querySelector || !root?.appendChild) return;
    let style = root.querySelector("style[data-dual-subtitles-native]");
    if (!style) {
      style = document.createElement("style");
      style.dataset.dualSubtitlesNative = "";
      root.appendChild(style);
    }
    style.textContent = nativeCaptionsHidden
      ? ".dss-hls-subtitle-overlay, .TimedTextOverlay, .hive-subtitle-renderer-cue-positioning-box { visibility: hidden !important; }"
      : "";
  }

  function setNativeCaptionsHidden(hidden) {
    nativeCaptionsHidden = Boolean(hidden);
    for (const root of activePlayerRoots().slice(1)) updateShadowCaptionStyle(root);
  }

  function activePlayerRoots() {
    const roots = [document];
    for (const root of playerShadowRoots) {
      if (root.host?.isConnected === false) {
        playerShadowRoots.delete(root);
        continue;
      }
      roots.push(root);
    }
    return roots;
  }

  const originalAttachShadow = globalThis.Element?.prototype?.attachShadow;
  if (originalAttachShadow) {
    globalThis.Element.prototype.attachShadow = function (...args) {
      const root = originalAttachShadow.apply(this, args);
      playerShadowRoots.add(root);
      updateShadowCaptionStyle(root);
      return root;
    };
  }

  function normalizeLanguage(value) {
    const normalized = String(value || "").replace("_", "-").toLowerCase();
    if (normalized === "jpn" || normalized.startsWith("jpn-")) return `ja${normalized.slice(3)}`;
    if (normalized === "eng" || normalized.startsWith("eng-")) return `en${normalized.slice(3)}`;
    return normalized;
  }

  function parseAttributeList(line) {
    const attributes = {};
    const input = String(line).replace(/^#EXT-X-MEDIA:/i, "");
    const pattern = /([A-Z0-9-]+)=(?:"([^"]*)"|([^,]*))(?:,|$)/gi;
    for (const match of input.matchAll(pattern)) attributes[match[1].toUpperCase()] = match[2] ?? match[3] ?? "";
    return attributes;
  }

  function isAllowedSubtitleUrl(value) {
    try {
      const parsed = new URL(value);
      return parsed.protocol === "https:" && allowedSubtitleHosts.test(parsed.hostname);
    } catch {
      return false;
    }
  }

  function subtitleTracksFromPlaylist(text, playlistUrl) {
    const tracks = [];
    for (const line of String(text || "").replace(/\r/g, "").split("\n")) {
      if (!line.startsWith("#EXT-X-MEDIA:")) continue;
      const attributes = parseAttributeList(line);
      if (attributes.TYPE !== "SUBTITLES" || !attributes.URI) continue;
      let url;
      try { url = new URL(attributes.URI, playlistUrl).href; } catch { continue; }
      if (!isAllowedSubtitleUrl(url)) continue;
      const language = normalizeLanguage(attributes.LANGUAGE || attributes["ASSOC-LANGUAGE"] || attributes.NAME);
      if (!language) continue;
      const description = `${attributes.NAME || ""} ${attributes.CHARACTERISTICS || ""}`;
      tracks.push({
        id: String(attributes["GROUP-ID"] || `${language}:${url}`),
        language,
        label: String(attributes.NAME || language),
        isForced: String(attributes.FORCED || "").toUpperCase() === "YES",
        isSdh: /sdh|closed.?caption|hearing|describes-music-and-sound|\bcc\b/i.test(description),
        url
      });
    }
    return tracks;
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

  function inspectPlaylist(text, playlistUrl) {
    try {
      publishTracks(subtitleTracksFromPlaylist(text, playlistUrl));
    } catch {
      emit("BRIDGE_ERROR", { code: "DISNEY_PLAYLIST_PARSE_FAILED" });
    }
  }

  function shouldInspectPlaylist(url, contentType = "") {
    return /\.m3u8(?:[?#]|$)/i.test(String(url || "")) || /mpegurl/i.test(String(contentType || ""));
  }

  function inspectFetchResponse(response, fallbackUrl = "") {
    const url = String(response?.url || fallbackUrl || "");
    const contentType = response?.headers?.get?.("content-type") || "";
    if (!shouldInspectPlaylist(url, contentType)) return;
    response.clone().text().then((text) => inspectPlaylist(text, url)).catch(() => {});
  }

  function syncRoute() {
    if (lastRoute === location.href) return;
    lastRoute = location.href;
    lastFingerprint = "";
    lastTracks = [];
    lastClockOffset = null;
    lastPresentationTimeMs = null;
    if (clockTimer) clearTimeout(clockTimer);
    clockTimer = null;
    scheduledClockForce = false;
    inspectedPlaylists.clear();
  }

  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);
    inspectFetchResponse(response, String(args[0]?.url || args[0] || ""));
    return response;
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__dualSubtitlesUrl = String(url || "");
    return originalOpen.call(this, method, url, ...rest);
  };
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    if (shouldInspectPlaylist(this.__dualSubtitlesUrl)) {
      this.addEventListener("load", () => {
        try {
          const text = typeof this.response === "string" ? this.response : this.responseText;
          inspectPlaylist(text, this.responseURL || this.__dualSubtitlesUrl);
        } catch {}
      }, { once: true });
    }
    return originalSend.apply(this, args);
  };

  function discoverObservedPlaylists() {
    syncRoute();
    if (lastTracks.length) emit("TRACKS_DISCOVERED", { tracks: lastTracks });
    let resources = [];
    try { resources = performance.getEntriesByType("resource").map((entry) => entry.name); } catch {}
    const candidates = resources.filter((url) => shouldInspectPlaylist(url)).slice(-40);
    for (const url of candidates) {
      if (inspectedPlaylists.has(url)) continue;
      inspectedPlaylists.add(url);
      originalFetch(url, { credentials: "omit" })
        .then((response) => {
          if (!response.ok) return null;
          return response.text().then((text) => inspectPlaylist(text, response.url || url));
        })
        .catch(() => {});
    }
  }

  function dispatchPlayerKey(key, target = null) {
    const code = key === "ArrowLeft" ? 37 : 39;
    const event = new KeyboardEvent("keydown", { key, code: key, bubbles: true, cancelable: true });
    Object.defineProperties(event, {
      keyCode: { value: code },
      which: { value: code }
    });
    (target || document.activeElement || document.body || window).dispatchEvent(event);
  }

  function seekWithPlayerControl(action) {
    const roots = activePlayerRoots();
    const directionPattern = action === "seek-backward" ? /前|戻|back|rewind/i : /先|進|forward/i;
    const controls = roots.flatMap((root) => [...(root.querySelectorAll?.("[aria-label]") || [])]);
    const button = controls.find((element) => {
      const label = element.getAttribute?.("aria-label") || "";
      return /(?:10|１０)/.test(label) && directionPattern.test(label) && element.getAttribute?.("aria-disabled") !== "true";
    });
    if (button?.click) {
      button.click();
      return;
    }

    const timeline = roots
      .flatMap((root) => [...(root.querySelectorAll?.('[aria-valuenow][aria-valuemax]') || [])])
      .map((element) => ({ element, maximum: Number(element.getAttribute("aria-valuemax")) }))
      .filter(({ maximum }) => Number.isFinite(maximum) && maximum > 60)
      .sort((a, b) => b.maximum - a.maximum)[0]?.element;
    dispatchPlayerKey(action === "seek-backward" ? "ArrowLeft" : "ArrowRight", timeline);
  }

  function activeVideo() {
    const video = [...document.querySelectorAll("video")]
      .sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight))[0] || null;
    if (video && !observedVideos.has(video)) {
      observedVideos.add(video);
      for (const type of ["seeked", "loadedmetadata", "durationchange"]) {
        video.addEventListener?.(type, () => schedulePlaybackClock(100, true));
      }
    }
    return video;
  }

  function timelinePresentationTimeMs() {
    const selector = '[aria-valuenow][aria-valuemax]';
    const roots = activePlayerRoots();
    const elements = roots.flatMap((root) => [...(root.querySelectorAll?.(selector) || [])]);
    const candidates = elements
      .map((element) => ({
        current: Number(element.getAttribute("aria-valuenow")),
        maximum: Number(element.getAttribute("aria-valuemax"))
      }))
      .filter(({ current, maximum }) => Number.isFinite(current) && Number.isFinite(maximum) && maximum > 60 && current >= 0 && current <= maximum)
      .sort((a, b) => b.maximum - a.maximum);
    return candidates.length ? candidates[0].current * 1000 : NaN;
  }

  function publishPlaybackClock(force = false) {
    const video = activeVideo();
    const status = document.querySelector(".text-to-speech-status")?.textContent || "";
    const values = status.match(/\d{4,}/g) || [];
    const timelineTimeMs = timelinePresentationTimeMs();
    const statusTimeMs = Number(values.at(-1));
    const hasTimelineTime = Number.isFinite(timelineTimeMs);
    const presentationTimeMs = hasTimelineTime ? timelineTimeMs : statusTimeMs;
    if (!video || !Number.isFinite(video.currentTime) || !Number.isFinite(presentationTimeMs)) return;
    if (video.seeking) {
      schedulePlaybackClock(100);
      return;
    }
    // The accessibility status often stays at the reload position after seeking.
    // Only a real player timeline may correct an already-published presentation time.
    if (presentationTimeMs === lastPresentationTimeMs && !(force && hasTimelineTime)) return;
    lastPresentationTimeMs = presentationTimeMs;
    const videoTimeMs = video.currentTime * 1000;
    const offsetMs = Math.round(presentationTimeMs - videoTimeMs);
    if (Math.abs(offsetMs) > 86_400_000 || offsetMs === lastClockOffset) return;
    lastClockOffset = offsetMs;
    emit("PLAYBACK_CLOCK", { presentationTimeMs, videoTimeMs, offsetMs });
  }

  function schedulePlaybackClock(delayMs = 100, force = false) {
    scheduledClockForce ||= force;
    if (clockTimer) clearTimeout(clockTimer);
    clockTimer = setTimeout(() => {
      clockTimer = null;
      const publishForced = scheduledClockForce;
      scheduledClockForce = false;
      publishPlaybackClock(publishForced);
    }, delayMs);
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin || event.data?.source !== SOURCE) return;
    if (event.data.type === "REQUEST_TRACKS") {
      discoverObservedPlaylists();
      publishPlaybackClock();
    } else if (event.data.type === "NATIVE_CAPTIONS") {
      setNativeCaptionsHidden(event.data.payload?.hidden === true);
    } else if (event.data.type === "PLAYER_SHORTCUT") {
      const action = event.data.payload?.action;
      if (action === "seek-backward" || action === "seek-forward") seekWithPlayerControl(action);
    }
  });

  emit("BRIDGE_READY");
  const clockObserver = new MutationObserver(() => schedulePlaybackClock(100));
  if (document.documentElement) clockObserver.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  setTimeout(discoverObservedPlaylists, 0);
  setTimeout(publishPlaybackClock, 0);
  setInterval(() => schedulePlaybackClock(100), 1000);
})();
