import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const extension = join(root, "extensions/zcode-provider.ts");
const fixture = join(root, "fixtures/fake-zcode-server.mjs");

test("reports ZCode auto-compaction without initiating compaction", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-zcode-compact-test-"));
  const settings = join(dir, "cli.json");
  const desktop = join(dir, "v2.json");
  const bridge = join(dir, "provider.json");
  const provider = {
    name: "Z.ai - Coding Plan",
    kind: "anthropic",
    enabled: true,
    options: {
      apiKey: "fixture-key",
      baseURL: "https://example.invalid/anthropic",
      apiKeyRequired: true,
    },
    models: {
      "GLM-5.3-Flash": {
        reasoning: { enabled: true, variants: ["low", "high", "max"], defaultVariant: "max" },
        limit: { context: 1_000_000, output: 128_000 },
      },
    },
  };
  await writeFile(settings, `${JSON.stringify({
    provider: { "builtin:zai-coding-plan": provider },
    model: "builtin:zai-coding-plan/GLM-5.3-Flash",
  })}\n`);
  await writeFile(desktop, `${JSON.stringify({
    provider: { "builtin:zai-coding-plan": provider },
  })}\n`);

  const child = spawn(
    process.env.PI_BIN || "pi",
    [
      "--mode", "rpc", "--no-session", "--no-extensions", "--extension", extension,
      "--provider", "zcode", "--model", "Z.ai - Coding Plan/GLM-5.3-Flash",
      "--thinking", "max", "--no-tools", "--no-context-files", "--no-skills", "--no-prompt-templates",
      "--no-themes",
    ],
    {
      env: {
        ...process.env,
        ZCODE_SERVE_CMD: `${process.execPath} ${fixture}`,
        ZCODE_SETTINGS: settings,
        ZCODE_V2_CONFIG: desktop,
        ZCODE_V2_SETTING: join(dir, "setting.json"),
        ZCODE_BRIDGE_PROVIDER_CONFIG: bridge,
        ZCODE_PROTOCOL_VARIANT: "modern",
        FAKE_ZCODE_PROTOCOL_VARIANT: "modern",
        FAKE_ZCODE_AUTO_COMPACT: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const lines = createInterface({ input: child.stdout });
  const waitFor = (predicate, label) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out: ${stderr}`)), 30_000);
    const onLine = (line) => {
      const event = JSON.parse(line);
      if (!predicate(event)) return;
      clearTimeout(timer);
      lines.off("line", onLine);
      resolve(event);
    };
    lines.on("line", onLine);
  });

  try {
    const notification = waitFor(
      (event) => event.type === "extension_ui_request" && event.method === "notify",
      "auto-compaction notification",
    );
    child.stdin.write(`${JSON.stringify({ id: "prompt", type: "prompt", message: "compact internally" })}\n`);
    const event = await notification;
    assert.equal(event.notifyType, "info");
    assert.match(event.message, /ZCode automatically compacted its context/);
    assert.match(event.message, /980,000 → 72,000 tokens/);
  } finally {
    child.kill("SIGTERM");
    lines.close();
    await rm(dir, { recursive: true, force: true });
  }
});
