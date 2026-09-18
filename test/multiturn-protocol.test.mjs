import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const extension =
  process.env.ZCODE_EXTENSION_UNDER_TEST || join(root, "extensions/zcode-provider.ts");
const fixtureSource = join(root, "fixtures/fake-zcode-server.mjs");

function sendPrompt(child, id, message, state) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`turn ${id} timed out`)), 20_000);
    state.waiters.push({
      resolve(value) {
        clearTimeout(timer);
        resolve(value);
      },
      reject(error) {
        clearTimeout(timer);
        reject(error);
      },
    });
    child.stdin.write(`${JSON.stringify({ id, type: "prompt", message })}\n`);
  });
}

test("ignores racy prompt_completed snapshots across consecutive turns", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-zcode-provider-test-"));
  const fixture = join(dir, "fake-zcode-server.mjs");
  const settings = join(dir, "cli.json");
  const desktop = join(dir, "v2.json");
  await copyFile(fixtureSource, fixture);
  const activeProvider = {
    name: "Fixture",
    enabled: true,
    models: { fixture: { limit: { context: 4096, output: 1024 } } },
  };
  const staleProvider = {
    name: "Inactive API-key variant",
    options: { apiKey: "" },
    models: { stale: {} },
  };
  await writeFile(settings, `${JSON.stringify({
    provider: { "fixture-provider": activeProvider, "stale-provider": staleProvider },
    model: "fixture-provider/fixture",
  })}\n`);
  await writeFile(desktop, `${JSON.stringify({
    provider: {
      "fixture-provider": activeProvider,
      "stale-provider": staleProvider,
    },
  })}\n`);

  const state = { waiters: [], text: [], usages: [] };
  const child = spawn(
    process.env.PI_BIN || "pi",
    [
      "--mode", "rpc", "--no-session", "--no-extensions", "--extension", extension,
      "--provider", "zcode", "--model", "Fixture/fixture", "--no-tools",
      "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-themes",
    ],
    {
      env: {
        ...process.env,
        ZCODE_SERVE_CMD: `${process.execPath} ${fixture}`,
        ZCODE_SETTINGS: settings,
        ZCODE_V2_CONFIG: desktop,
        ZCODE_V2_SETTING: join(dir, "setting.json"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const event = JSON.parse(line);
    if (event.type === "message_end" && event.message?.role === "assistant") {
      state.text.push(
        ...(event.message.content || [])
          .filter((part) => part.type === "text")
          .map((part) => part.text || ""),
      );
      state.usages.push(event.message.usage);
    }
    if (event.type === "agent_end") {
      state.waiters.shift()?.resolve(state.text);
      state.text = [];
    }
  });
  child.on("exit", (code) => {
    const error = new Error(`Pi exited early (${code}): ${stderr}`);
    for (const waiter of state.waiters.splice(0)) waiter.reject(error);
  });

  try {
    for (let turn = 1; turn <= 3; turn += 1) {
      const answer = await sendPrompt(child, String(turn), `turn ${turn}`, state);
      assert.deepEqual(answer, [`FIXTURE-TURN-${turn}-OK`]);
    }
    assert.deepEqual(state.usages.at(-1), {
      input: 50,
      output: 7,
      cacheRead: 30,
      cacheWrite: 0,
      totalTokens: 87,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    });
    const merged = JSON.parse(await readFile(settings, "utf8"));
    assert.equal(merged.provider["stale-provider"], undefined);
  } finally {
    child.kill("SIGTERM");
    lines.close();
    await rm(dir, { recursive: true, force: true });
  }
});
