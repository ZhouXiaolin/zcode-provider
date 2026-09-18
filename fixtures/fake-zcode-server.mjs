// Test fixture — NOT an official or complete ZCode app-server implementation.
//
// This hand-written fake models only the NDJSON messages used by this test. Its
// event ordering is based on behavior observed from the app-server bundled with
// ZCode Desktop 0.16.5: on a subsequent turn, a state.updated notification with
// reason prompt_completed can arrive after turn.started but before the new
// model output and turn.completed event. Keep this fixture version-scoped and
// revalidate it against the real app-server when ZCode's protocol changes.
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const input = createInterface({ input: process.stdin });
let turn = 0;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function event(type, payload = {}) {
  send({ method: "session/event", params: { sessionId: "fixture-session", type, payload } });
}

input.on("line", (line) => {
  const request = JSON.parse(line);
  const { id, method } = request;

  if (method === "session/create") {
    send({ id, result: { session: { sessionId: "fixture-session" } } });
    return;
  }
  if (method === "session/setModel") {
    if (process.env.FAKE_ZCODE_PROTOCOL_VARIANT === "modern") {
      const model = request.params?.model;
      if (
        model?.providerId !== "zcode-provider:zai-coding-plan" ||
        model?.options?.reasoningLevel !==
          (process.env.FAKE_EXPECT_REASONING_LEVEL ?? "max")
      ) {
        send({ id, error: { message: "modern model materialization was not used" } });
        return;
      }
    }
    send({ id, result: {} });
    return;
  }
  if (method === "session/setThoughtLevel") {
    const expected = process.env.FAKE_EXPECT_THOUGHT_LEVEL;
    if (expected && request.params?.thoughtLevel !== expected) {
      send({ id, error: { message: "unexpected reasoning level" } });
      return;
    }
    send({ id, result: {} });
    return;
  }
  if (method === "session/subscribe") {
    send({ id, result: {} });
    return;
  }
  if (method === "session/send") {
    if (
      process.env.FAKE_ZCODE_PROTOCOL_VARIANT === "modern" &&
      "runtimeModel" in (request.params ?? {})
    ) {
      send({ id, error: { message: "Invalid params: runtimeModel" } });
      return;
    }
    turn += 1;
    const answer =
      turn === 1 && process.env.FAKE_ZCODE_FIRST_RESPONSE_CHARS
        ? "X".repeat(Number(process.env.FAKE_ZCODE_FIRST_RESPONSE_CHARS))
        : `FIXTURE-TURN-${turn}-OK`;
    send({ id, result: {} });

    // Reproduce the observed second-turn race: prompt_completed from prior
    // state arrives after the next turn starts but before its model output and
    // authoritative terminal event. A broken bridge returns an empty response.
    event("turn.started");
    if (turn > 1) {
      send({
        method: "state.updated",
        params: {
          scope: "session",
          sessionId: "fixture-session",
          reason: "prompt_completed",
          patch: { status: "idle" },
        },
      });
    }

    setTimeout(() => {
      event("model.streaming", {
        kind: "text_delta",
        assistantMessageId: `assistant-${turn}`,
        delta: answer,
      });
      event("model.streaming", {
        kind: "text_end",
        assistantMessageId: `assistant-${turn}`,
      });
      event("turn.completed", {
        response: answer,
        usage: {
          inputTokens: 100,
          outputTokens: 7,
          totalTokens: 107,
          cacheReadTokens: 40,
          cacheWriteTokens: 0,
        },
      });
    }, 500);
    return;
  }
  if (method === "session/read") {
    send({
      id,
      result: {
        runtime: {
          contextUsage: {
            used: turn > 0 ? 87 : 0,
            size: 200_000,
            cache: {
              inputTokens: 80,
              cacheReadTokens: 30,
              cacheWriteTokens: 0,
            },
          },
        },
        settings: {
          model: {
            available: [{
              ref: {
                providerId: "zcode-provider:zai-coding-plan",
                modelId: "GLM-5.3-Flash",
              },
              contextWindow: 200_000,
              maxOutputTokens: 128_000,
              reasoning: {
                levels: ["low", "high", "max"].map((value) => ({ value, label: value })),
              },
            }],
          },
        },
      },
    });
    return;
  }
  if (method === "session/compact") {
    if (process.env.FAKE_ZCODE_COMPACT_MARKER) {
      writeFileSync(process.env.FAKE_ZCODE_COMPACT_MARKER, JSON.stringify(request.params));
    }
    send({ id, result: { compact: { state: "accepted" } } });
    setTimeout(() => {
      send({
        method: "state.updated",
        params: {
          scope: "session",
          sessionId: "fixture-session",
          reason: "session_compacted",
          patch: { status: "idle" },
        },
      });
    }, 10);
    return;
  }
  if (method === "session/messages") {
    send({ id, result: { messages: [] } });
    return;
  }
  if (method === "session/stop") {
    send({ id, result: {} });
    event("turn.failed", { error: { message: "stopped" } });
    return;
  }

  send({ id, result: {} });
});
