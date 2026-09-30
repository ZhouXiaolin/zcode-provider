import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const extension = join(root, "extensions/zcode-provider.ts");
const fixture = join(root, "fixtures/fake-zcode-server.mjs");

test("supports the modern provider repository and protocol", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-zcode-provider-modern-test-"));
  const settings = join(dir, "cli.json");
  const desktop = join(dir, "v2.json");
  const bridge = join(dir, "provider-config.json");
  const provider = {
    name: "Z.ai - Coding Plan",
    kind: "anthropic",
    enabled: true,
    source: "custom",
    options: {
      apiKey: "fixture-key",
      baseURL: "https://example.invalid/anthropic",
      apiKeyRequired: true,
    },
    models: {
      "GLM-5.3-Flash": {
        reasoning: {
          enabled: true,
          variants: ["low", "high", "max"],
          defaultVariant: "max",
        },
        limit: { context: 1_000_000, output: 128_000 },
      },
    },
  };
  await writeFile(settings, `${JSON.stringify({
    // A stale alias may coexist after an upgrade. Both map to one modern
    // runtime provider and must not produce duplicate repository rules.
    provider: {
      "builtin:zai-coding-plan": provider,
      "zcode-provider:zai-coding-plan": provider,
    },
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
      "--no-tools", "--no-context-files", "--no-skills", "--no-prompt-templates",
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
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const lines = createInterface({ input: child.stdout });
  const result = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`modern turn timed out: ${stderr}`)), 20_000);
    lines.on("line", (line) => {
      const event = JSON.parse(line);
      if (event.type === "message_end" && event.message?.role === "assistant") {
        clearTimeout(timer);
        resolve(event.message);
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Pi exited early (${code}): ${stderr}`));
    });
  });

  try {
    child.stdin.write(`${JSON.stringify({ id: "1", type: "prompt", message: "ping" })}\n`);
    const message = await result;
    assert.equal(message.content.find((part) => part.type === "text")?.text, "FIXTURE-TURN-1-OK");
    assert.deepEqual(message.usage, {
      input: 60,
      output: 7,
      cacheRead: 40,
      cacheWrite: 0,
      totalTokens: 107,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    });
    const repository = JSON.parse(await readFile(bridge, "utf8"));
    assert.equal(repository.config.providerConfigRules.providerRules.length, 1);
    assert.equal(
      repository.config.providerConfigRules.providerRules[0].providerId,
      "zcode-provider:zai-coding-plan",
    );
    const unchanged = JSON.parse(await readFile(settings, "utf8"));
    assert.deepEqual(Object.keys(unchanged.provider), [
      "builtin:zai-coding-plan",
      "zcode-provider:zai-coding-plan",
    ]);
  } finally {
    child.kill("SIGTERM");
    lines.close();
    await rm(dir, { recursive: true, force: true });
  }
});
