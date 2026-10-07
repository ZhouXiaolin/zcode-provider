import assert from "node:assert/strict";
import { createCipheriv, createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { loadTypeScript } from "../fixtures/load-typescript.mjs";

const root = fileURLToPath(new URL("../extensions/zcode-start-plan/", import.meta.url));
const { StartPlanClient } = await loadTypeScript(join(root, "client.ts"));
const { readStartPlanLogin } = await loadTypeScript(join(root, "credentials.ts"));
const { parseStartPlanGrant } = await loadTypeScript(join(root, "balance.ts"));
const providerId = "account:zai-start-plan";
const modelId = "GLM-5.3-Flash";
const nowMs = 1_800_000_000_000;
const balance = () => ({ code: 0, data: {
  server_time: nowMs / 1000,
  plans: [{ plan_id: "trust", user_plan_id: "plan-user-1", status: "active", ends_at: nowMs / 1000 + 3600 }],
  balances: [{ plan_id: "trust", user_plan_id: "plan-user-1", capabilities: ["model:glm-5.3-flash"], available_units: 100, expires_at: nowMs / 1000 + 60 }],
} });
const bundle = { revision: 30, config: {
  providerConfigRules: { providerRules: ["zai", "bigmodel"].map(family => ({
    providerId: `account:${family}-start-plan`, config: {
      access: { type: "zhipu-account", mode: "start-plan", accountType: family },
      builtinModelIds: [modelId, "GLM-5.2"],
    },
  })) },
  modelConfigRules: { modelRules: [{ modelMatch: ".*", config: {
    properties: { contextWindow: 1_000_000 },
    optionSpecs: { maxOutputTokens: { max: 128000 }, reasoningLevel: { values: ["low", "high", "max"] } },
  } }] },
} };
function fixture(t, fetchImpl, now = () => nowMs) {
  const directory = mkdtempSync(join(tmpdir(), "start-plan-unit-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const credentials = join(directory, "credentials.json");
  const login = { "oauth:active_provider": "zai", zcodejwttoken: "fixture-token" };
  writeFileSync(credentials, JSON.stringify(login));
  writeFileSync(join(directory, "telemetry-state.json"), JSON.stringify({ deviceMid: "11111111-1111-4111-8111-111111111111" }));
  const bundledPath = join(directory, "bundle.json"); writeFileSync(bundledPath, JSON.stringify(bundle));
  const calls = [];
  const client = new StartPlanClient({ directory, bundledPath, appVersion: "3.14.4", now,
    fetch: fetchImpl || (async (url, options) => { calls.push({ url: String(url), options }); return Response.json(balance()); }),
  });
  return { directory, credentials, login, client, calls };
}
const authParams = (overrides = {}) => ({
  providerId, modelSelection: { providerId, modelId },
  accountAccess: { type: "zhipu-account", mode: "start-plan", accountType: "zai" }, reason: "model-request", ...overrides,
});

test("separate Start Plan catalog, native account snapshot, memory-only auth", async t => {
  const { client, calls, credentials } = fixture(t);
  const before = readFileSync(credentials, "utf8");
  const models = client.catalog();
  assert.equal(models[0].id, "Z.ai - Start Plan/GLM-5.3-Flash");
  assert.equal(models[0].contextWindow, 1_000_000);
  assert.deepEqual(models[0].reasoningVariants, ["low", "high", "max"]);
  const snapshot = await client.prepare(providerId, modelId);
  assert.deepEqual(snapshot.providers[providerId].builtinModelIds, [modelId]);
  assert.equal(snapshot.states[providerId].entitled, true);
  assert.match(snapshot.basedOnZCodeBuiltinRevision, /^zcode-builtin:30:[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(snapshot).includes("fixture-token"));
  const auth = await client.runtimeAuth(authParams());
  assert.equal(auth.requestAuth.apiKey, "fixture-token");
  assert.equal(calls[0].url, "https://zcode.z.ai/api/v1/zcode-plan/billing/balance?app_version=3.14.4");
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(calls[0].options.headers.Authorization, "Bearer fixture-token");
  assert.equal(readFileSync(credentials, "utf8"), before);
  client.clear();
  await assert.rejects(client.runtimeAuth(authParams()), /Unexpected/);
});

test("native authorization denies foreign providers, models, account types and CAPTCHA retry", async t => {
  const { client } = fixture(t); await client.prepare(providerId, modelId);
  for (const override of [
    { providerId: "other" }, { modelSelection: { providerId, modelId: "GLM-5.2" } },
    { accountAccess: { type: "zhipu-account", mode: "individual-coding-plan", accountType: "zai" } },
    { accountAccess: { type: "zhipu-account", mode: "start-plan", accountType: "bigmodel" } },
  ]) await assert.rejects(client.runtimeAuth(authParams(override)), /Unexpected/);
  await assert.rejects(client.runtimeAuth(authParams({ reason: "captcha-retry" })), /CAPTCHA/);
});

test("missing grant and disabled models cannot switch to Coding Plan", async t => {
  const { client, directory } = fixture(t);
  await assert.rejects(client.prepare(providerId, "GLM-5.2"), /does not include/);
  await assert.rejects(client.runtimeAuth(authParams()), /Unexpected/);
  writeFileSync(join(directory, "provider_config.json"), JSON.stringify({ config: { modelConfigRules: {
    providerModelRules: [{ providerId, modelId, config: { enabled: false } }],
  } } }));
  assert.ok(!client.catalog().some(model => model.modelId === modelId));
  await assert.rejects(client.prepare(providerId, modelId), /disabled/);
});

test("login rotation and logout invalidate authorization, next turn re-reads credentials", async t => {
  const { client, credentials, login } = fixture(t); await client.prepare(providerId, modelId);
  writeFileSync(credentials, JSON.stringify({ ...login, zcodejwttoken: "rotated-token" }));
  await assert.rejects(client.runtimeAuth(authParams()), /login changed/);
  await client.prepare(providerId, modelId);
  assert.equal((await client.runtimeAuth(authParams())).requestAuth.apiKey, "rotated-token");
  writeFileSync(credentials, "{}");
  assert.deepEqual(client.catalog(), []);
  await assert.rejects(client.runtimeAuth(authParams()), /login changed/);
});

test("foreign family is discovered separately and cannot reuse another family's grant", async t => {
  const { client, credentials, login } = fixture(t);
  writeFileSync(credentials, JSON.stringify({ ...login, "oauth:active_provider": "bigmodel" }));
  assert.equal(client.catalog()[0].id, "BigModel - Start Plan/GLM-5.3-Flash");
  await assert.rejects(client.prepare(providerId, modelId), /signed out/);
});

test("HTTP failure, malformed response, network error and cancellation fail closed without body leaks", async t => {
  const { client } = fixture(t, async () => new Response("private backend payload", { status: 401 }));
  await assert.rejects(client.prepare(providerId, modelId), error => /HTTP 401/.test(error.message) && !error.message.includes("private"));
  const malformed = fixture(t, async () => new Response("private broken json"));
  await assert.rejects(malformed.client.prepare(providerId, modelId), /Invalid.*response/);
  const network = fixture(t, async () => { throw new Error("secret transport details"); });
  await assert.rejects(network.client.prepare(providerId, modelId), error => /network error/.test(error.message) && !error.message.includes("secret"));
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(client.prepare(providerId, modelId, cancelled.signal));
});

test("grant excludes expired, future, exhausted and unrelated buckets", () => {
  assert.deepEqual(parseStartPlanGrant(balance(), nowMs), { modelIds: ["glm-5.3-flash"], expiresAtMs: nowMs + 60000 });
  for (const mutate of [
    b => { b.data.plans[0].ends_at = nowMs / 1000 - 1; },
    b => { b.data.plans[0].status = "expired"; },
    b => { b.data.plans[0].starts_at = nowMs / 1000 + 60; },
    b => { b.data.balances[0].available_units = 0; },
    b => { b.data.balances[0].available_units = "not-a-number"; },
    b => { b.data.balances[0].expires_at = "invalid-time"; },
    b => { b.data.balances[0].expires_at = nowMs / 1000; },
    b => { b.data.balances[0].period_start = nowMs / 1000 + 1; },
    b => { b.data.balances[0].user_plan_id = "different-user-plan"; },
    b => { b.code = 123; },
  ]) { const payload = balance(); mutate(payload); assert.throws(() => parseStartPlanGrant(payload, nowMs)); }
});

test("long turns revalidate expired grants and fail closed when the package expires", async t => {
  let clock = nowMs;
  let requests = 0;
  const { client } = fixture(t, async () => {
    requests += 1;
    const payload = balance();
    payload.data.server_time = clock / 1000;
    return Response.json(payload);
  }, () => clock);
  await client.prepare(providerId, modelId);
  clock += 61000;
  await assert.rejects(client.runtimeAuth(authParams()), /no active model quota/);
  assert.equal(requests, 2);
  await assert.rejects(client.runtimeAuth(authParams()), /Unexpected/);
});

test("account changes during entitlement lookup cannot authorize either account", async t => {
  let resolveResponse;
  const { client, credentials, login } = fixture(t, () => new Promise(resolve => { resolveResponse = resolve; }));
  const pending = client.prepare(providerId, modelId);
  writeFileSync(credentials, JSON.stringify({ ...login, zcodejwttoken: "new-account-token" }));
  resolveResponse(Response.json(balance()));
  await assert.rejects(pending, /login changed/);
  await assert.rejects(client.runtimeAuth(authParams()), /Unexpected/);
});

test("shared encrypted credentials are read without rewriting; wrong secret fails safely", t => {
  const { directory, credentials } = fixture(t);
  const secret = "fixture-encryption-secret";
  const encrypt = value => {
    const iv = Buffer.alloc(12, 1);
    const cipher = createCipheriv("aes-256-gcm", createHash("sha256").update(secret).digest(), iv);
    const data = Buffer.concat([cipher.update(value), cipher.final()]);
    return `enc:v1:${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${data.toString("base64url")}`;
  };
  const raw = JSON.stringify({ "oauth:active_provider": encrypt("zai"), zcodejwttoken: encrypt("private-fixture-jwt") });
  writeFileSync(credentials, raw);
  assert.equal(readStartPlanLogin(directory, { ZCODE_CREDENTIAL_SECRET: secret }).token, "private-fixture-jwt");
  assert.equal(readFileSync(credentials, "utf8"), raw);
  assert.throws(() => readStartPlanLogin(directory, { ZCODE_CREDENTIAL_SECRET: "wrong" }), /Cannot decrypt/);
});
