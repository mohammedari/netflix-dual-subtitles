import { DEFAULT_SETTINGS, normalizeSettings } from "../shared/core.js";

const fieldIds = ["enabled", "upperLanguage", "fontSize", "position", "shortcutsEnabled", "downloadSubdirectory"];
const elements = Object.fromEntries(fieldIds.map((id) => [id, document.getElementById(id)]));
const statusElement = document.getElementById("status");
const capturePermissionButton = document.getElementById("capturePermission");

async function refreshCapturePermission() {
  const granted = await chrome.permissions.contains({ origins: ["<all_urls>"] });
  capturePermissionButton.textContent = granted ? "キャプチャ権限: 許可済み" : "キャプチャ権限を許可";
  capturePermissionButton.classList.toggle("granted", granted);
  capturePermissionButton.disabled = granted;
}

async function load() {
  const settings = normalizeSettings(await chrome.storage.local.get(DEFAULT_SETTINGS));
  for (const [key, element] of Object.entries(elements)) {
    if (element.type === "checkbox") element.checked = settings[key];
    else element.value = settings[key];
    element.addEventListener(element.type === "text" ? "change" : "input", save);
  }
  capturePermissionButton.addEventListener("click", async () => {
    await chrome.permissions.request({ origins: ["<all_urls>"] });
    await refreshCapturePermission();
  });
  await refreshCapturePermission();
  refreshStatus();
}

async function save() {
  const settings = normalizeSettings({
    enabled: elements.enabled.checked,
    upperLanguage: elements.upperLanguage.value,
    fontSize: elements.fontSize.value,
    position: elements.position.value,
    shortcutsEnabled: elements.shortcutsEnabled.checked,
    downloadSubdirectory: elements.downloadSubdirectory.value
  });
  elements.downloadSubdirectory.value = settings.downloadSubdirectory;
  await chrome.storage.local.set(settings);
}

async function refreshStatus() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("no tab");
    const status = await chrome.tabs.sendMessage(tab.id, { type: "GET_STATUS" });
    if (!status.playerFound) {
      showStatus("Netflixの動画を再生してください。", "warning");
      return;
    }
    const names = { ready: "取得済み", loading: "取得中", searching: "検索中", unavailable: "利用不可", error: "エラー" };
    const text = `プレイヤー検出済み\n日本語: ${names[status.trackState.ja]} / 英語: ${names[status.trackState.en]}`;
    showStatus(text, status.lastError ? "error" : (status.trackState.ja === "ready" && status.trackState.en === "ready" ? "ready" : "warning"));
  } catch {
    showStatus("Netflixのページで使用できます。", "warning");
  }
}

function showStatus(message, level) {
  statusElement.textContent = message;
  statusElement.className = `status ${level}`;
}

load();
