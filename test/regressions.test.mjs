import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(
  new URL("../extensions/zcode-provider.ts", import.meta.url),
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
