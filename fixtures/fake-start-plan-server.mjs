// Minimal ZCode Desktop 3.14 account protocol fixture, not a complete server.
import assert from "node:assert/strict";
import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
const sessionId = "start-plan-fixture-session";
let selected;
let accountReady = false;
let turn = 0;
const send = message => process.stdout.write(JSON.stringify(message) + "\n");
const event = (type, payload = {}) => send({ method: "session/event", params: { sessionId, type, payload } });
const trace = value => appendFileSync(process.env.FAKE_START_TRACE, JSON.stringify(value) + "\n");
createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  const { id, method, params } = message;
  if (!method) {
    if (String(id).startsWith("foreign-")) {
      assert.equal(message.result.headersApplied, false);
      trace({ foreignSessionDenied: true });
      return;
    }
    assert.equal(message.result.headersApplied, true);
    assert.equal(message.result.requestAuth.apiKey, "fixture-jwt");
    trace({ authorized: true, providerId: selected.providerId });
    event("model.streaming", { kind: "text_delta", assistantMessageId: `a-${turn}`, delta: `START-${turn}-OK` });
    event("model.streaming", { kind: "text_end", assistantMessageId: `a-${turn}` });
    event("turn.completed", { response: `START-${turn}-OK` });
    return;
  }
  if (method === "provider/updateAccountConfig") {
    assert.deepEqual(params.providers["account:zai-start-plan"].builtinModelIds, ["GLM-5.3-Flash"]);
    assert.equal(params.states["account:zai-start-plan"].entitled, true);
    assert.ok(!JSON.stringify(params).includes("fixture-jwt"));
    const repository = readFileSync(process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE, "utf8");
    assert.ok(!repository.includes("fixture-jwt"));
    accountReady = true;
    trace({ accountReady: true });
  }
  if (method === "session/create") {
    assert.equal(accountReady, true);
    send({ id, result: { session: { sessionId } } }); return;
  }
  if (method === "session/setModel") {
    selected = params.model;
    assert.equal(selected.providerId, "account:zai-start-plan");
    assert.equal(selected.options.reasoningLevel, "low");
    assert.equal(accountReady, true);
    trace({ selected: selected.providerId });
  }
  if (method === "session/send") {
    assert.equal(accountReady, true);
    accountReady = false;
    assert.ok(!("runtimeModel" in params));
    turn += 1;
    send({ id, result: { accepted: true } });
    event("turn.started");
    const auth = { sessionId, providerId: selected.providerId, modelSelection: selected,
      accountAccess: { type: "zhipu-account", mode: "start-plan", accountType: "zai", entitled: true }, reason: "model-request" };
    send({ id: `foreign-${turn}`, method: "interaction/requestProviderRuntimeHeaders", params: { ...auth, sessionId: "foreign-session" } });
    send({ id: `auth-${turn}`, method: "interaction/requestProviderRuntimeHeaders", params: auth });
    return;
  }
  if (method === "session/read") {
    send({ id, result: { runtime: {}, settings: { model: { available: [] } } } }); return;
  }
  if (method === "session/messages") { send({ id, result: { messages: [] } }); return; }
  send({ id, result: {} });
});
