# AGENTS.md

## Project overview

This repository contains a build-free Manifest V3 Chrome extension for Netflix. It shows Japanese and English subtitles together, seeks by 10 seconds with `j`/`k`, and saves a subtitle-visible PNG with `c`.

The supported production environment is the latest Google Chrome on Windows. Netflix integration is unofficial and may break when Netflix changes its player or manifest responses.

## Repository layout

- `manifest.json`: extension entry point and permissions.
- `src/page/bridge.js`: runs in the page's `MAIN` world and observes Netflix manifest/subtitle traffic.
- `src/content/content.js`: runs in the extension's isolated world; renders subtitles and handles `j`/`k`/`c`.
- `src/background/service-worker.js`: captures the visible tab, detects likely black frames, and downloads PNG files.
- `src/shared/core.js`: pure shared parsing, selection, settings, filename, and image-analysis functions.
- `src/popup/`: settings and status UI.
- `test/`: Node built-in test suite.
- `MANUAL_TESTS.md`: real-Netflix acceptance checklist.
- `scripts/package.ps1`: produces the unpacked release and ZIP under ignored `release/`.

## Development commands

Use Node.js 24 LTS when possible; Node.js 20 or newer is supported. The extension has no runtime or npm dependencies.

```powershell
npm test
npm run check
npm run package
```

Run `npm test` and `npm run check` after every code change. Run `npm run package` when changing release-facing files or before delivery. Do not commit `release/` or generated ZIP files.

## Architecture rules

- Keep the extension build-free ES Modules unless the user explicitly approves a toolchain change.
- Keep Netflix-specific, undocumented behavior inside `src/page/bridge.js`; do not leak internal player assumptions into shared modules or popup code.
- The `MAIN`-world bridge must not use Chrome extension APIs. Pass schema-validated data to the isolated content script through `window.postMessage`.
- Treat messages from the page as untrusted. Validate message source, origin, type, request IDs, URLs, and payload shape before acting.
- Subtitle fetches must remain HTTPS-only and restricted to the existing Netflix/CDN allowlist.
- Keep `src/shared/core.js` free of DOM and Chrome API dependencies so its behavior remains unit-testable.
- Preserve SPA and episode-transition isolation: old subtitle requests must never overwrite a newer player session.
- When the extension is disabled, unloaded, or errors, restore Netflix's native subtitle visibility and avoid changing native playback state.
- `c` capture must restore the pre-capture playback state in success, failure, and timeout paths.

## Product and security constraints

- Use only subtitle tracks supplied by Netflix. Do not add machine translation or external services without explicit approval.
- Do not bypass DRM, alter protected media pipelines, or claim that video pixels can always be captured. Black-video detection is advisory and must not prevent saving the PNG.
- Do not persist subtitle text, viewing history, screenshots, account details, cookies, tokens, or Netflix response bodies in extension storage or logs.
- Keep permissions minimal. Do not add broad host permissions, `tabs`, browsing-history access, remote code, analytics, or telemetry without an explicit requirement and documented justification.
- Never log subtitle URLs containing tokens or full Netflix response payloads.
- Do not commit credentials, downloaded screenshots, user data, or diagnostic dumps.

## Behavior and compatibility

- Keyboard handling applies only when a Netflix video is present and no input, editable element, or modal dialog is active.
- Preserve `j = -10 seconds`, `k = +10 seconds`, and `c = one capture`; only `j` and `k` may repeat on key hold.
- Prefer exact `ja`/`en` tracks, then regional variants; prefer regular subtitles over SDH/CC.
- Missing tracks must be reported as unavailable rather than silently translated or fabricated.
- Parse subtitle formats defensively. Unknown formats should produce a clear unsupported/error state, not guessed timing.
- Maintain usable popup and overlay text in Japanese. Keep status and failure messages understandable without DevTools.

## Testing expectations

- Add or update unit tests for parser changes, language selection, cue timing, settings normalization, filenames, permissions, and black-frame detection.
- Manifest changes require tests confirming referenced files exist and permissions remain intentionally scoped.
- For Netflix-adapter changes, add a sanitized fixture-based test where practical. Never commit real account URLs, tokens, cookies, or complete captured manifests.
- Real Netflix behavior cannot be fully automated in this repository. Follow `MANUAL_TESTS.md` for release verification and state clearly which manual cases were not run.
- Verify both normal and fullscreen capture, seek boundaries, missing-language behavior, SPA navigation, episode changes, settings updates, and native-subtitle restoration before release.

## Git workflow

- Keep changes focused and preserve unrelated user edits.
- Do not rewrite history, reset user changes, or delete untracked files.
- Use concise commits that describe observable behavior.
- Before handing off, report automated test results, manual-test coverage, known Netflix compatibility risks, and the generated ZIP path when packaging was requested.
