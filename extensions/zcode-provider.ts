// ZCode provider bridge for pi.
//
// Turns the ZCode CLI agent (`zcodex app-server`, a.k.a. "ZCode Protocol"
// stdio NDJSON server) into a pi model provider named "zcode". pi is the chat
// frontend; the ZCode agent keeps its own session, runs its own tools (edits,
// shell, ...), and its text reply is streamed back to pi.
//
// One pi model per ZCode provider/model, listed from the app-server's settings
// file (default ~/.zcode/cli/config.json; override ZCODE_SETTINGS). Selecting a
// pi model calls session/setModel so the ZCode agent runs the chosen
// provider/model for the turn.
//
// Auto-sync: providers configured in the ZCode v2 config (default
// ~/.zcode/v2/config.json; override ZCODE_V2_CONFIG) are merged into the
// settings file at server spawn and on config-file changes (the app-server
// re-reads its settings file live). pi re-reads the catalog on every /model
// open via refreshModels, so new providers/models show up without a reload.
//
// Wire protocol (ZCode Protocol v1, NDJSON over stdio), verified live:
//   request:       {"id": N, "method": "...", "params": {...}}
//   response:      {"id": N, "result": {...}} | {"id": N, "error": {...}}
//   srv->cli req:  {"id": "server-N", "method": "...", "params": {...}}
//                  (answer with {"id": "server-N", "result": {...}})
//   notification:  {"method": "...", "params": {...}}
//
// Flow: session/create {workspace:{workspacePath, workspaceKey}} -> answer
// session/requestRuntimePreferences (runtime-materialization and
// user-execution scopes) -> session/send {sessionId, content} -> wait for
// state.updated reason "prompt_completed" -> session/messages -> text parts.
//
// Server command overridable via env ZCODE_SERVE_CMD. Permission requests are
// auto-allowed unless ZCODE_AUTO_ALLOW=0 (the point is that the ZCode agent
// executes tasks). Verify raw traffic with /zcode-probe.
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, readFileSync, watch, writeFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { dirname } from "node:path";

const SETTINGS_PATH =
  process.env.ZCODE_SETTINGS ?? `${process.env.HOME ?? "~"}/.zcode/cli/config.json`;
const V2_CONFIG_PATH =
  process.env.ZCODE_V2_CONFIG ?? `${process.env.HOME ?? "~"}/.zcode/v2/config.json`;

interface CatalogModel {
  id: string; // `${providerName}/${modelId}`, the pi model id
  providerId: string;
  modelId: string;
}

// The app-server resolves models only from its settings file provider map; the
// v2 config the ZCode UI writes is not read. Keep a fallback single model so an
// unreadable/absent settings file still yields a working bridge.
function readCatalog(): CatalogModel[] {
  try {
    const cfg = JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) as {
      provider?: Record<string, { name?: string; models?: Record<string, unknown> }>;
    };
    return Object.entries(cfg.provider ?? {}).flatMap(([providerId, p]) =>
      Object.keys(p.models ?? {}).map((modelId) => ({
        id: `${p.name ?? providerId}/${modelId}`,
        providerId,
        modelId,
      })),
    );
  } catch {
    return [];
  }
}

function resolveModelRef(id: string): { providerId: string; modelId: string } {
  const slash = id.indexOf("/");
  if (slash < 0) throw new Error(`unknown zcode model: ${id}`);
  const head = id.slice(0, slash);
  const modelId = id.slice(slash + 1);
  const cfg = JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) as {
    provider?: Record<string, { name?: string }>;
  };
  const byId = Object.keys(cfg.provider ?? {}).find((pid) => pid === head);
  if (byId) return { providerId: byId, modelId };
  const byName = Object.entries(cfg.provider ?? {}).filter(([, p]) => p.name === head);
  if (byName.length === 1) return { providerId: byName[0][0], modelId };
  if (byName.length === 0)
    throw new Error(`provider ${head} not found in ${SETTINGS_PATH}`);
  throw new Error(`provider name ${head} is ambiguous in ${SETTINGS_PATH}`);
}

// The app-server resolves models only from its settings file, but the ZCode UI
// writes providers to the v2 config; merge v2 providers in (additive) so
// anything configured in ZCode reaches the server. Called before spawn and on
// config-file changes; the server re-reads the settings file live, so no
// restart is needed for newly merged providers.
function mergeV2Providers(): string[] {
  try {
    const v2 = JSON.parse(readFileSync(V2_CONFIG_PATH, "utf8")) as {
      provider?: Record<string, unknown>;
    };
    const cli = JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) as {
      provider?: Record<string, unknown>;
    };
    const added: string[] = [];
    for (const [pid, p] of Object.entries(v2.provider ?? {})) {
      // Skip disabled entries: the app-server catalog rejects them at load
      // ("Model config is missing"), and the user did not enable them anyway.
      if ((p as { enabled?: boolean }).enabled === false) continue;
      if (!(pid in (cli.provider ?? {}))) {
        cli.provider ??= {};
        cli.provider[pid] = p;
        added.push(pid);
      }
    }
    if (added.length) {
      copyFileSync(
        SETTINGS_PATH,
        `${SETTINGS_PATH}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`,
      );
      writeFileSync(SETTINGS_PATH, JSON.stringify(cli, null, 2) + "\n");
    }
    return added;
  } catch {
    return [];
  }
}

function watchConfigs(): void {
  // Watch the parent dirs: editors replace files via rename, which breaks
  // file-level watches. Debounce the burst of rename events.
  let timer: NodeJS.Timeout | undefined;
  const onChange = () => {
    clearTimeout(timer);
    timer = setTimeout(() => mergeV2Providers(), 300);
  };
  for (const dir of [dirname(SETTINGS_PATH), dirname(V2_CONFIG_PATH)]) {
    try {
      watch(dir, (_event, filename) => {
        if (filename === "config.json") onChange();
      });
    } catch {
      /* dir may not exist yet; the spawn-time merge covers that case */
    }
  }
}

const SERVE_CMD =
  process.env.ZCODE_SERVE_CMD ?? "node /opt/ZCode/resources/glm/zcode.cjs app-server";

const RUNTIME_PREFS = {
  nativeSearchEnhancementsEnabled: false,
  memoryEnabled: false,
  askUserQuestionAutoResolutionEnabled: true,
  modelContextBudgetStrategy: "preflight-v1",
};

const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let nextId = 1;
let proc: ChildProcess | null = null;
const listeners = new Set<(msg: unknown) => void>();
let sessionId: string | null = null;
let lastModelId: string | null = null;
let probeLog: ((line: string) => void) | null = null;

function startServer(): void {
  if (proc) return;
  mergeV2Providers();
  const [bin, ...args] = SERVE_CMD.split(" ");
  const child = spawn(bin, args, { stdio: ["pipe", "pipe", "inherit"] });
  proc = child;
  const rl = createInterface({ input: child.stdout! });
  rl.on("line", (line) => {
    probeLog?.(line);
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.id != null && msg.method == null) {
      const p = pending.get(String(msg.id));
      if (p) {
        pending.delete(String(msg.id));
        if (msg.error) p.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      }
      return;
    }
    if (msg.method === "session/requestRuntimePreferences") {
      child.stdin!.write(JSON.stringify({ id: msg.id, result: RUNTIME_PREFS }) + "\n");
    } else if (msg.method === "interaction/requestPermission") {
      const allow = process.env.ZCODE_AUTO_ALLOW !== "0";
      child.stdin!.write(
        JSON.stringify({
          id: msg.id,
          result: { decision: allow ? "allow" : "deny", reason: "pi zcode bridge" },
        }) + "\n",
      );
    }
    for (const l of listeners) l(msg);
  });
  const fail = (err: Error) => {
    if (proc !== child) return;
    proc = null;
    sessionId = null;
    for (const [, p] of pending) p.reject(err);
    pending.clear();
  };
  child.on("error", (e) => fail(new Error(`cannot start zcode app-server: ${e.message}`)));
  child.on("exit", (code) => fail(new Error(`zcode app-server exited (code ${code})`)));
}

function request<T = unknown>(method: string, params?: unknown): Promise<T> {
  startServer();
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(String(id), { resolve: resolve as (v: unknown) => void, reject });
    proc!.stdin!.write(JSON.stringify({ id, method, params }) + "\n");
  });
}

interface ZcodeMessagePart {
  type: string;
  text?: string;
}
interface ZcodeMessage {
  info: { role: string };
  parts: ZcodeMessagePart[];
}

function streamSimple(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const out = createAssistantMessageEventStream();
  const output: AssistantMessage = {
    role: "assistant",
    content: [],
    api: "zcode",
    provider: "zcode",
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "pending",
    timestamp: Date.now(),
  };

  (async () => {
    out.push({ type: "start", partial: output });
    let text = "";
    const emit = (t: string) => {
      if (!t) return;
      text += t;
      out.push({ type: "text_delta", contentIndex: 0, delta: t, partial: output });
    };
    const finish = (reason: "stop" | "error" | "aborted", errorMessage?: string) => {
      if (output.stopReason !== "pending") return;
      output.content = text ? [{ type: "text", text }] : [];
      if (reason === "stop") {
        output.stopReason = "stop";
        out.push({ type: "done", reason: "stop", message: output });
      } else {
        output.stopReason = reason;
        output.errorMessage = errorMessage ?? output.errorMessage;
        out.push({ type: "error", reason, error: output });
      }
    };
    try {
      const ref = resolveModelRef(model.id);
      if (!sessionId) {
        const created = await request<{ session: { sessionId: string } }>("session/create", {
          workspace: { workspacePath: process.cwd(), workspaceKey: process.cwd() },
        });
        sessionId = created.session.sessionId;
        lastModelId = null;
      }
      if (lastModelId !== model.id) {
        await request("session/setModel", { sessionId, model: ref });
        lastModelId = model.id;
      }
      const last = [...context.messages].reverse().find((m) => m.role === "user");
      const prompt =
        typeof last?.content === "string"
          ? last.content
          : (last?.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join("");
      if (!prompt) throw new Error("no user message in context");
      await request("session/send", { sessionId, content: prompt });
    } catch (e) {
      finish("error", e instanceof Error ? e.message : String(e));
      return;
    }

    let settled = false;
    const onEvent = (msg: any) => {
      if (msg.method !== "state.updated") return;
      const p = msg.params ?? {};
      if (p.reason === "prompt_completed") settled = true;
    };
    listeners.add(onEvent);
    const abortHandler = () => {
      listeners.delete(onEvent);
      void request("session/stop", { sessionId }).catch(() => {});
      finish("aborted", "aborted by user");
    };
    options?.signal?.addEventListener("abort", abortHandler, { once: true });
    const timer = setTimeout(() => {
      listeners.delete(onEvent);
      finish("error", "timeout waiting for zcode turn");
    }, 30 * 60 * 1000);
    timer.unref?.();

    while (!settled) {
      if (output.stopReason !== "pending") return; // aborted/error already finished
      await new Promise((r) => setTimeout(r, 250));
    }
    clearTimeout(timer);
    listeners.delete(onEvent);

    try {
      // Small settle delay so the final message is queryable.
      await new Promise((r) => setTimeout(r, 500));
      const msgs = await request<{ messages: ZcodeMessage[] }>("session/messages", { sessionId });
      const lastAssistant = [...(msgs.messages ?? [])]
        .reverse()
        .find((m) => m.info?.role === "assistant");
      emit(
        (lastAssistant?.parts ?? [])
          .filter((p) => p.type === "text")
          .map((p) => p.text ?? "")
          .join(""),
      );
      finish("stop");
    } catch (e) {
      finish("error", e instanceof Error ? e.message : String(e));
    }
  })();
  return out;
}

const FALLBACK_MODELS = [
  {
    id: "zcode-agent",
    name: "ZCode Agent",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 8192,
  },
];

function toPiModels(catalog: CatalogModel[]) {
  return catalog.length
    ? catalog.map((m) => ({
        id: m.id,
        name: m.id,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      }))
    : FALLBACK_MODELS;
}

export default function (pi: ExtensionAPI) {
  pi.registerProvider("zcode", {
    name: "ZCode (app-server)",
    baseUrl: "zcode://app-server",
    api: "zcode",
    // Dummy key: the bridge talks to the local app-server over stdio and does
    // not authenticate; a resolvable key merely marks the provider configured.
    apiKey: "zcode-bridge",
    models: toPiModels(readCatalog()),
    // pi calls this on every /model open, so the list follows the settings
    // file without a reload.
    refreshModels: async () => toPiModels(readCatalog()),
    streamSimple,
  });
  watchConfigs();

  pi.registerCommand("zcode-probe", {
    description: "Probe zcode app-server: one full turn, dump raw protocol lines",
    handler: async (_args, ctx) => {
      const file = "/tmp/zcode-probe.jsonl";
      probeLog = (line) => void appendFile(file, line + "\n");
      const seen: string[] = [];
      const log = (msg: unknown) => {
        const line = JSON.stringify(msg);
        seen.push(line);
        void appendFile(file, line + "\n");
      };
      const l = (msg: unknown) => log(msg);
      listeners.add(l);
      try {
        const created = await request<{ session: { sessionId: string } }>("session/create", {
          workspace: { workspacePath: process.cwd(), workspaceKey: process.cwd() },
        });
        sessionId = created.session.sessionId;
        await request("session/send", { sessionId, content: "Reply with exactly: probe-ok" });
        const deadline = Date.now() + 120_000;
        while (Date.now() < deadline && !seen.some((s) => s.includes('"prompt_completed"'))) {
          await new Promise((r) => setTimeout(r, 500));
        }
      } finally {
        listeners.delete(l);
        probeLog = null;
      }
      ctx.ui.notify(`Probe done. Raw protocol in ${file} (${seen.length} lines).`, "info");
    },
  });

  pi.on("session_shutdown", async () => {
    if (sessionId) {
      try {
        await request("session/close", { sessionId });
      } catch {
        /* server may already be gone */
      }
      sessionId = null;
      lastModelId = null;
    }
    proc?.kill();
    proc = null;
  });
}
