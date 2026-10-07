import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
for (const includeCodingPlan of [true, false]) test(`Pi authenticates two Start Plan turns without persisting JWT (Coding Plan configured: ${includeCodingPlan})`, async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-start-plan-protocol-"));
  const bundle = join(dir, "bundle.json");
  const bridge = join(dir, "bridge.json");
  const trace = join(dir, "trace.jsonl");
  const providerId = "account:zai-start-plan", modelId = "GLM-5.3-Flash";
  const legacyProvider = { name: "Z.ai - Coding Plan", enabled: true, kind: "anthropic",
    options: { apiKey: "fixture-coding-key", baseURL: "https://example.invalid" }, models: { [modelId]: {} } };
  await writeFile(join(dir, "desktop.json"), JSON.stringify({ provider: includeCodingPlan ? { "builtin:zai-coding-plan": legacyProvider } : {} }));
  await writeFile(bundle, JSON.stringify({ revision: 30, config: {
    providerConfigRules: { providerRules: [{ providerId, config: {
      access: { type: "zhipu-account", mode: "start-plan", accountType: "zai" }, builtinModelIds: [modelId],
    } }] }, modelConfigRules: { modelRules: [{ modelMatch: ".*", config: {
      properties: { contextWindow: 1000000 }, optionSpecs: {
        reasoningLevel: { values: ["low", "high", "max"] }, maxOutputTokens: { max: 128000 },
      },
    } }] },
  } }));
  const credentials = JSON.stringify({ "oauth:active_provider": "zai", zcodejwttoken: "fixture-jwt" });
  await writeFile(join(dir, "credentials.json"), credentials);
  await writeFile(join(dir, "telemetry-state.json"), JSON.stringify({ deviceMid: "11111111-1111-4111-8111-111111111111" }));
  const child = spawn(process.env.PI_BIN || "pi", [
    "--mode", "rpc", "--no-session", "--no-extensions", "--extension", join(root, "extensions/zcode-provider.ts"),
    "--provider", "zcode", "--model", "Z.ai - Start Plan/GLM-5.3-Flash", "--thinking", "low",
    "--no-tools", "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-themes",
  ], { cwd: dir, env: { ...process.env,
    NODE_OPTIONS: `--import=${pathToFileURL(join(root, "fixtures/fake-start-plan-balance.mjs"))}`,
    ZCODE_SERVE_CMD: `${process.execPath} ${join(root, "fixtures/fake-start-plan-server.mjs")}`,
    ZCODE_SETTINGS: join(dir, "cli.json"), ZCODE_V2_CONFIG: join(dir, "desktop.json"),
    ZCODE_V2_SETTING: join(dir, "setting.json"), ZCODE_BRIDGE_PROVIDER_CONFIG: bridge,
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: bundle, ZCODE_PROTOCOL_VARIANT: "modern", ZCODE_APP_VERSION: "3.14.4",
    FAKE_START_TRACE: trace, ZCODE_DEBUG: "1",
  }, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "", stdout = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  const lines = createInterface({ input: child.stdout });
  const messages = [];
  let catalog;
  let resolveDone, rejectDone;
  const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  const timer = setTimeout(() => rejectDone(new Error(`Start Plan protocol timeout: ${stderr}`)), 30000);
  const send = value => child.stdin.write(JSON.stringify(value) + "\n");
  lines.on("line", line => {
    stdout += line + "\n";
    const event = JSON.parse(line);
    if (event.type === "response" && event.command === "get_available_models") catalog = event.data.models;
    if (event.type !== "message_end" || event.message?.role !== "assistant") return;
    messages.push(event.message);
    if (messages.length === 1 && event.message.stopReason !== "error") send({ type: "prompt", message: "second" });
    else resolveDone();
  });
  child.on("exit", code => rejectDone(new Error(`Pi exited ${code}: ${stderr}`)));
  try {
    send({ type: "get_available_models" });
    send({ type: "prompt", message: "first" });
    await done;
    assert.equal(messages.length, 2, `${stderr}\n${messages.map(message => message.errorMessage).join("\n")}`);
    assert.deepEqual(messages.map(message => message.content.find(part => part.type === "text")?.text), ["START-1-OK", "START-2-OK"]);
    assert.ok(catalog.some(model => model.id === "Z.ai - Start Plan/GLM-5.3-Flash"));
    assert.equal(catalog.some(model => model.id === "Z.ai - Coding Plan/GLM-5.3-Flash"), includeCodingPlan);
    const events = (await readFile(trace, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(events.filter(event => event.accountReady).length, 2);
    assert.equal(events.filter(event => event.authorized).length, 2);
    assert.equal(events.filter(event => event.foreignSessionDenied).length, 2);
    assert.ok(!(await readFile(bridge, "utf8")).includes("fixture-jwt"));
    assert.equal(await readFile(join(dir, "credentials.json"), "utf8"), credentials);
    assert.ok(!stderr.includes("fixture-jwt"));
    assert.ok(!stdout.includes("fixture-jwt"));
  } finally {
    clearTimeout(timer);
    const exit = new Promise(resolve => child.once("exit", resolve));
    child.kill("SIGTERM");
    await exit;
    lines.close();
    await rm(dir, { recursive: true, force: true });
  }
});
