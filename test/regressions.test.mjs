import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(
  new URL("../extensions/zcode-provider.ts", import.meta.url),
  "utf8",
);

const clientSource = await readFile(
  new URL("../extensions/zcode-start-plan/client.ts", import.meta.url),
  "utf8",
);

test("only explicitly enabled Desktop providers are synchronized", () => {
  assert.match(source, /enabled\?: boolean \}\)\.enabled !== true/);
});

test("prompt_completed cannot terminate a turn", () => {
  assert.doesNotMatch(source, /reason === ["']prompt_completed["'][^\n]*settled\s*=\s*true/);
  assert.match(source, /ev\.type === ["']turn\.completed["']/);
  assert.match(source, /ev\.type === ["']turn\.failed["']/);
});

test("headless config watchers are unreferenced", () => {
  assert.match(source, /watcher\.unref\(\)/);
});

test("ZCode model limits are exposed to Pi and refreshed from runtime", () => {
  assert.match(source, /runtime\?\.contextWindow \?\? m\.contextWindow \?\? 200000/);
  assert.match(source, /runtime\?\.maxTokens \?\? m\.maxTokens \?\? 8192/);
  assert.match(source, /applyRuntimeModelMetadata\(snapshot, ref, model\)/);
});

test("ZCode owns compaction while Pi only reports completed auto-compactions", () => {
  assert.match(source, /pi\.on\("session_before_compact"/);
  assert.match(source, /ctx\.model\?\.provider !== "zcode"/);
  assert.match(source, /return \{ cancel: true \}/);
  assert.match(source, /pl\.trigger === "auto"/);
  assert.match(source, /ZCode automatically compacted its context/);
  assert.doesNotMatch(source, /request[^\n]*"session\/compact"/);
});

test("context usage comes from the final app-server snapshot", () => {
  assert.match(source, /applyContextSnapshotUsage\(output, snapshot\.runtime\?\.contextUsage\)/);
});

test("only exact ZCode reasoning variants are exposed to Pi", () => {
  assert.match(source, /xhigh: available\.has\("xhigh"\) \? "xhigh" : null/);
  assert.match(source, /medium: available\.has\("medium"\) \? "medium" : null/);
  assert.match(source, /"session\/setThoughtLevel"/);
});

test("modern layout detection works on every platform, not only darwin", () => {
  // ZCode Desktop 3.12+ ships the moved catalog on Linux too (deb at /opt/ZCode);
  // detection must come from the install layout, never from process.platform.
  const detection = source.slice(
    source.indexOf("const MODERN_PROTOCOL"),
    source.indexOf("const STEER_MODE"),
  );
  assert.doesNotMatch(detection, /process\.platform === ["']darwin["']/);
  assert.match(source, /LINUX_RESOURCES = "\/opt\/ZCode\/resources"/);
  assert.match(source, /`\$\{LINUX_RESOURCES\}\/config\/provider\/zcode-builtin\.json`/);
  assert.match(source, /`\$\{LINUX_RESOURCES\}\/glm\/provider\/zcode-builtin\.json`/);
  // An explicit catalog override must win over the layout scan.
  assert.match(
    source,
    /MODERN_BUNDLED_PROVIDER_PATH =\s*\n\s*process\.env\.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE \?\?/,
  );
});

test("Start Plan app version falls back to the Linux app.asar package.json", () => {
  assert.match(clientSource, /linuxAsarAppVersion\(\)/);
  assert.match(clientSource, /resolve\(this\.options\.bundledPath, "\.\.\/\.\.\/\.\.\/app\.asar"\)/);
});

test("the placeholder fallback model resolves instead of dying", () => {
  assert.match(source, /const FALLBACK_MODEL_ID = "zcode-agent"/);
  assert.match(source, /if \(id !== FALLBACK_MODEL_ID\) throw new Error\(`unknown zcode model: \$\{id\}`\)/);
  assert.match(source, /modelRefOf\(cfg\.model\) \?\? firstModelRef\(cfg\.provider\)/);
  assert.match(
    source,
    /ZCode has no usable models\. Sign in to ZCode Desktop \(Start Plan\) or configure an API-key provider/,
  );
});

test("compaction cancellation is safe on a stale extension ctx", () => {
  // pi invalidates every ctx getter on session dispose/reload (e.g. a
  // pi-subagents child settling while the post-run compaction check races it).
  // The handler must swallow that instead of surfacing an extension error.
  const handler = source.slice(
    source.indexOf('pi.on("session_before_compact"'),
    source.indexOf('pi.registerCommand("zcode-probe"'),
  );
  assert.match(handler, /try \{/);
  assert.match(handler, /\} catch \{\s*\n\s*return undefined;/s);
  assert.match(handler, /ctx\.model\?\.provider !== "zcode"/);
  assert.match(handler, /return \{ cancel: true \}/);
});

test("the captured ui ctx is only touched behind a stale guard", () => {
  // uiCtx is captured at session_start; after a session replacement its getters
  // throw, so the notify call must sit inside a try/catch.
  assert.match(source, /try \{\s*\n\s*uiCtx\?\.ui\.notify\(/);
});
