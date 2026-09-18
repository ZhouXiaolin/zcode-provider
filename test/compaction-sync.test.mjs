import assert from "node:assert/strict";
import { existsSync } from "node:fs";
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

test("mirrors successful Pi compaction to the ZCode session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-zcode-compact-test-"));
  const settings = join(dir, "cli.json");
  const desktop = join(dir, "v2.json");
  const bridge = join(dir, "provider.json");
  const marker = join(dir, "compact.json");
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
        limit: { context: 200_000, output: 128_000 },
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
        FAKE_ZCODE_FIRST_RESPONSE_CHARS: "300000",
        FAKE_ZCODE_COMPACT_MARKER: marker,
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
    const answer = waitFor(
      (event) => event.type === "message_end" && event.message?.role === "assistant",
      "first turn",
    );
    child.stdin.write(`${JSON.stringify({ id: "prompt", type: "prompt", message: "produce history" })}\n`);
    await answer;

    const compacted = waitFor((event) => event.type === "compaction_end", "Pi compaction");
    child.stdin.write(`${JSON.stringify({
      id: "compact",
      type: "compact",
      customInstructions: "Keep the latest task state.",
    })}\n`);
    const event = await compacted;
    assert.equal(event.errorMessage, undefined);
    assert.equal(existsSync(marker), true, `ZCode compact was not called: ${stderr}`);
    const params = JSON.parse(await readFile(marker, "utf8"));
    assert.equal(params.sessionId, "fixture-session");
    assert.match(params.instructions, /Preserve the active task/);
  } finally {
    child.kill("SIGTERM");
    lines.close();
    await rm(dir, { recursive: true, force: true });
  }
});
