import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("manifest is valid MV3 with narrowly scoped permissions", async () => {
  const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, "1.1.1");
  assert.equal(packageJson.version, manifest.version);
  assert.deepEqual(manifest.permissions.sort(), ["activeTab", "downloads", "storage"]);
  assert.deepEqual(manifest.host_permissions, [
    "https://www.netflix.com/*",
    "https://*.nflxvideo.net/*",
    "https://*.nflxso.net/*",
    "https://*.nflximg.net/*",
    "https://www.disneyplus.com/*",
    "https://*.media.dssott.com/*"
  ]);
  assert.deepEqual(manifest.optional_host_permissions, ["<all_urls>"]);
  assert.equal(manifest.background.type, "module");
  assert.ok(manifest.content_scripts.some((script) => script.world === "MAIN" && script.run_at === "document_start"));
  assert.ok(manifest.content_scripts.some((script) => script.world === "ISOLATED"));
  assert.ok(manifest.content_scripts.some((script) => script.world === "MAIN" && script.matches.includes("https://www.disneyplus.com/*")));
  assert.ok(manifest.content_scripts.some((script) => script.world === "ISOLATED" && script.matches.includes("https://www.disneyplus.com/*")));
});

test("all manifest-referenced files exist", async () => {
  const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
  const paths = [
    manifest.background.service_worker,
    manifest.action.default_popup,
    ...manifest.content_scripts.flatMap((script) => script.js),
    ...manifest.web_accessible_resources.flatMap((resource) => resource.resources)
  ];
  for (const path of paths) {
    const content = await readFile(new URL(`../${path}`, import.meta.url));
    assert.ok(content.length > 0, `${path} should not be empty`);
  }
});
