import(chrome.runtime.getURL("src/shared/core.js")).then((core) => start(core)).catch((error) => {
  console.error("[Netflix Dual Subtitles] failed to start", error);
});

async function start(core) {
  const { DEFAULT_SETTINGS, MESSAGE_SOURCE, activeCueText, buildCaptureFilename, chooseTrack, normalizeSettings, parseSubtitle, shortcutAction } = core;
  let settings = normalizeSettings(await chrome.storage.local.get(DEFAULT_SETTINGS));
  let currentTracks = [];
  let cuesByLanguage = { ja: [], en: [] };
  let trackState = { ja: "searching", en: "searching" };
  let lastError = null;
  let playerFound = false;
  let overlay;
  let nativeStyle;
  let renderFrame;
  let route = location.href;
  let capturedCueText = null;
  let sessionGeneration = 0;

  function ensureOverlay() {
    if (overlay?.isConnected) return overlay;
    if (!document.documentElement) return null;
    overlay = document.createElement("netflix-dual-subtitles");
    overlay.setAttribute("aria-live", "off");
    const shadow = overlay.attachShadow({ mode: "closed" });
    shadow.innerHTML = `
      <style>
        :host { position: fixed; inset: 0; z-index: 2147483646; pointer-events: none; font-family: Arial, "Noto Sans JP", sans-serif; }
        .captions { position: absolute; left: 5%; right: 5%; display: flex; flex-direction: column; align-items: center; gap: .3em; }
        .captions.bottom { bottom: 8%; } .captions.center { top: 47%; } .captions.top { top: 8%; }
        .captions.small { font-size: clamp(18px, 2.2vw, 34px); }
        .captions.medium { font-size: clamp(22px, 2.8vw, 44px); }
        .captions.large { font-size: clamp(27px, 3.5vw, 56px); }
        .line { display: none; max-width: 92%; padding: .08em .3em; color: white; text-align: center; white-space: pre-line; line-height: 1.25; font-weight: 600; text-shadow: -2px -2px 2px #000, 2px -2px 2px #000, -2px 2px 2px #000, 2px 2px 2px #000; background: rgba(0,0,0,.28); border-radius: .15em; }
        .line.visible { display: block; }
        .line[data-language="ja"] { font-family: "Noto Sans JP", "Yu Gothic UI", sans-serif; }
        .toast { position: absolute; top: 8%; left: 50%; transform: translateX(-50%); max-width: 80%; padding: 10px 14px; border-radius: 6px; background: rgba(0,0,0,.82); color: white; font-size: 15px; opacity: 0; transition: opacity .15s; }
        .toast.visible { opacity: 1; }
      </style>
      <div class="captions bottom medium"><div class="line upper"></div><div class="line lower"></div></div>
      <div class="toast" role="status"></div>`;
    overlay._captions = shadow.querySelector(".captions");
    overlay._upper = shadow.querySelector(".upper");
    overlay._lower = shadow.querySelector(".lower");
    overlay._toast = shadow.querySelector(".toast");
    document.documentElement.appendChild(overlay);
    return overlay;
  }

  function applySettings() {
    const view = ensureOverlay();
    if (!view) return;
    view.style.display = settings.enabled ? "block" : "none";
    view._captions.className = `captions ${settings.position} ${settings.fontSize}`;
    updateNativeCaptionVisibility();
  }

  function updateNativeCaptionVisibility() {
    setNativeCaptionsHidden(settings.enabled && Object.values(trackState).includes("ready"));
  }

  function setNativeCaptionsHidden(hidden) {
    if (!document.documentElement) return;
    if (!nativeStyle) {
      nativeStyle = document.createElement("style");
      nativeStyle.id = "netflix-dual-subtitles-native-style";
      nativeStyle.textContent = `html.nds-enabled .player-timedtext, html.nds-enabled [data-uia="player-subtitle-text"] { visibility: hidden !important; }`;
      document.documentElement.appendChild(nativeStyle);
    }
    document.documentElement.classList.toggle("nds-enabled", Boolean(hidden));
  }

  let toastTimer;
  function toast(message, duration = 3500) {
    const view = ensureOverlay();
    if (!view) return;
    clearTimeout(toastTimer);
    view._toast.textContent = message;
    view._toast.classList.add("visible");
    toastTimer = setTimeout(() => view?._toast?.classList.remove("visible"), duration);
  }

  function getVideo() {
    const videos = [...document.querySelectorAll("video")];
    const video = videos.sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight))[0] || null;
    playerFound = Boolean(video);
    return video;
  }

  function render() {
    if (!settings.enabled) return;
    const view = ensureOverlay();
    const video = getVideo();
    if (!view || !video) return;
    const timeMs = video.currentTime * 1000;
    const text = capturedCueText || {
      ja: activeCueText(cuesByLanguage.ja, timeMs),
      en: activeCueText(cuesByLanguage.en, timeMs)
    };
    const upper = settings.upperLanguage;
    const lower = upper === "ja" ? "en" : "ja";
    setLine(view._upper, upper, text[upper]);
    setLine(view._lower, lower, text[lower]);
  }

  function setLine(element, language, text) {
    element.dataset.language = language;
    element.lang = language;
    element.textContent = text || "";
    element.classList.toggle("visible", Boolean(text));
  }

  function animationLoop() {
    render();
    renderFrame = requestAnimationFrame(animationLoop);
  }

  function resetForRoute() {
    sessionGeneration += 1;
    cuesByLanguage = { ja: [], en: [] };
    currentTracks = [];
    trackState = { ja: "searching", en: "searching" };
    lastError = null;
    updateNativeCaptionVisibility();
    window.postMessage({ source: MESSAGE_SOURCE, type: "REQUEST_TRACKS", payload: {} }, location.origin);
  }

  async function loadLanguage(language) {
    const generation = sessionGeneration;
    const track = chooseTrack(currentTracks, language);
    if (!track) {
      cuesByLanguage[language] = [];
      trackState[language] = "unavailable";
      updateNativeCaptionVisibility();
      toast(`${language === "ja" ? "日本語" : "英語"}字幕を利用できません`);
      return;
    }
    trackState[language] = "loading";
    try {
      const payload = await Promise.race([
        chrome.runtime.sendMessage({ type: "FETCH_SUBTITLE", url: track.url }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Subtitle request timed out")), 12000))
      ]);
      if (!payload?.ok) throw new Error(payload?.error || "Subtitle request failed");
      const cues = parseSubtitle(payload.text, payload.contentType);
      if (!cues.length) throw new Error("Unsupported or empty subtitle format");
      if (generation !== sessionGeneration) return;
      cuesByLanguage[language] = cues;
      trackState[language] = "ready";
      updateNativeCaptionVisibility();
    } catch (error) {
      if (generation !== sessionGeneration) return;
      cuesByLanguage[language] = [];
      trackState[language] = "error";
      updateNativeCaptionVisibility();
      lastError = "SUBTITLE_LOAD_FAILED";
      toast(`${language === "ja" ? "日本語" : "英語"}字幕を取得できません`);
      console.warn("[Netflix Dual Subtitles]", error);
    }
  }

  function handlePageMessage(event) {
    if (event.source !== window || event.origin !== location.origin || event.data?.source !== MESSAGE_SOURCE) return;
    const { type, payload = {} } = event.data;
    if (type === "TRACKS_DISCOVERED") {
      currentTracks = Array.isArray(payload.tracks) ? payload.tracks : [];
      if (settings.enabled) Promise.allSettled([loadLanguage("ja"), loadLanguage("en")]);
    } else if (type === "BRIDGE_ERROR") {
      lastError = payload.code || "BRIDGE_ERROR";
    }
  }

  function isVisible(element) {
    if (!element || element.getAttribute("aria-hidden") === "true" || !element.getClientRects().length) return false;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && style.visibility !== "collapse";
  }

  function isTypingOrDialog() {
    const active = document.activeElement;
    if (active && (active.matches("input, textarea, select, [contenteditable='true']") || active.closest("[role='dialog']"))) return true;
    return [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')].some(isVisible);
  }

  function seek(delta) {
    window.postMessage({
      source: MESSAGE_SOURCE,
      type: "PLAYER_SHORTCUT",
      payload: { action: delta < 0 ? "seek-backward" : "seek-forward" }
    }, location.origin);
  }

  function togglePlayback() {
    const video = getVideo();
    if (!video) return;
    if (video.paused || video.ended) {
      video.play().catch((error) => {
        lastError = "PLAYBACK_FAILED";
        toast("再生できませんでした");
        console.warn("[Netflix Dual Subtitles]", error);
      });
    } else {
      video.pause();
    }
  }

  function extractMetadata() {
    const title = document.querySelector('[data-uia="video-title"]')?.textContent?.trim()
      || document.querySelector(".ellipsize-text h4")?.textContent?.trim()
      || document.title.replace(/\s*-\s*Netflix\s*$/i, "").trim()
      || "netflix_capture";
    const episode = document.querySelector('[data-uia="video-title"] span')?.textContent?.trim()
      || document.querySelector(".ellipsize-text")?.textContent?.replace(title, "").trim()
      || "";
    return { title, episode };
  }

  async function capture() {
    const video = getVideo();
    if (!video) return;
    const wasPlaying = !video.paused && !video.ended;
    capturedCueText = {
      ja: activeCueText(cuesByLanguage.ja, video.currentTime * 1000),
      en: activeCueText(cuesByLanguage.en, video.currentTime * 1000)
    };
    if (wasPlaying) video.pause();
    render();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const { title, episode } = extractMetadata();
    const filename = buildCaptureFilename({
      folder: settings.downloadSubdirectory,
      title,
      episode,
      currentTime: video.currentTime
    });
    try {
      const result = await Promise.race([
        chrome.runtime.sendMessage({ type: "CAPTURE_VISIBLE_TAB", filename }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Capture timed out")), 3000))
      ]);
      if (!result?.ok) throw new Error(result?.error || "Capture failed");
      toast(result.likelyBlack ? "保存しました（映像が黒い可能性があります）" : "スクリーンショットを保存しました");
    } catch (error) {
      lastError = "CAPTURE_FAILED";
      toast(/activeTab|<all_urls>/i.test(String(error?.message || error))
        ? "ポップアップでキャプチャ権限を許可してください"
        : "スクリーンショットを保存できませんでした");
      console.warn("[Netflix Dual Subtitles]", error);
    } finally {
      capturedCueText = null;
      if (wasPlaying && video.paused && !video.ended) video.play().catch(() => {});
    }
  }

  function handleKeydown(event) {
    if (!settings.enabled || !settings.shortcutsEnabled || !getVideo() || isTypingOrDialog()) return;
    if (event.ctrlKey || event.altKey || event.metaKey) return;
    const action = shortcutAction(event.key, event.repeat);
    if (!action) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (action === "seek-backward") seek(-10);
    if (action === "toggle-playback") togglePlayback();
    if (action === "seek-forward") seek(10);
    if (action === "capture") capture();
  }

  function publicStatus() {
    return {
      enabled: settings.enabled,
      playerFound,
      trackState,
      availableLanguages: [...new Set(currentTracks.map((track) => track.language))],
      lastError
    };
  }

  window.addEventListener("message", handlePageMessage);
  window.postMessage({ source: MESSAGE_SOURCE, type: "REQUEST_TRACKS", payload: {} }, location.origin);
  window.addEventListener("keydown", handleKeydown, true);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    const update = Object.fromEntries(Object.entries(changes).map(([key, change]) => [key, change.newValue]));
    settings = normalizeSettings({ ...settings, ...update });
    applySettings();
    if (settings.enabled && currentTracks.length) Promise.allSettled([loadLanguage("ja"), loadLanguage("en")]);
  });
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "GET_STATUS") sendResponse(publicStatus());
  });

  const observer = new MutationObserver(() => {
    getVideo();
    if (location.href !== route) {
      route = location.href;
      resetForRoute();
    }
    if (!overlay?.isConnected) applySettings();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  applySettings();
  animationLoop();
  window.addEventListener("pagehide", () => {
    cancelAnimationFrame(renderFrame);
    observer.disconnect();
    document.documentElement.classList.remove("nds-enabled");
  }, { once: true });
}
