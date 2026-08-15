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
// re-reads its settings file live). The app-server also validates the settings
// file against a strict schema that REQUIRES a top-level `model` (a
// "provider/model" ref) and refuses to run a turn with "Model config is
// missing" when it is absent or invalid, so the settings file is bootstrapped
// with a valid default too (existing ref kept, else v2's model selection,
// else the first enabled provider's first model). pi re-reads the catalog on
// every /model open via refreshModels, so new providers/models show up without
// a reload.
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
// Server command overridable via env ZCODE_SERVE_CMD; default resolves the
// ZCode install for the current platform (Linux /opt, macOS /Applications).
// Permission requests are auto-allowed unless ZCODE_AUTO_ALLOW=0 (the point is
// that the ZCode agent executes tasks). Verify raw traffic with /zcode-probe.
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
import { copyFileSync, existsSync, readFileSync, watch, writeFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { dirname } from "node:path";

const SETTINGS_PATH =
  process.env.ZCODE_SETTINGS ?? `${process.env.HOME ?? "~"}/.zcode/cli/config.json`;
const V2_CONFIG_PATH =
  process.env.ZCODE_V2_CONFIG ?? `${process.env.HOME ?? "~"}/.zcode/v2/config.json`;

// Per-turn budget: when a turn exceeds this, the bridge interrupts it and
// sends the session "go on" (see streamSimple), so long tasks checkpoint
// instead of failing. Override with ZCODE_TURN_TIMEOUT_MS.
const TURN_TIMEOUT_MS = (() => {
  const n = Number(process.env.ZCODE_TURN_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 30 * 60 * 1000;
})();

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

interface SettingsModel {
  reasoning?: { enabled?: boolean; variants?: string[]; defaultVariant?: string };
  limit?: { context?: number; output?: number };
}

// The app-server validates a resumed session's model against its per-workspace
// model catalog, which is populated only by workspace/updateProviderRegistry or
// by applying a runtimeModel. The bridge sends neither, so every cold resume
// (after the app-server's 10-min idle eviction) sets a session restoreWarning
// (ZCODE_RUNTIME_MODEL_UNAVAILABLE, "历史任务使用的模型已不可用...") and
// session/send refuses the turn — even for a model that is in the list. A bare
// session/setModel does not clear the warning; only applying a runtimeModel
// does. Build the descriptor from the settings file the app-server already
// trusts and send it with every session/send.
function runtimeModelOf(
  providerId: string,
  modelId: string,
): Record<string, unknown> {
  const cfg = JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) as {
    provider?: Record<
      string,
      {
        name?: string;
        kind?: string;
        apiFormat?: string;
        source?: string;
        options?: { apiKey?: string; baseURL?: string; apiKeyRequired?: boolean };
        models?: Record<string, SettingsModel>;
      }
    >;
  };
  const p = cfg.provider?.[providerId];
  if (!p) throw new Error(`provider ${providerId} not found in ${SETTINGS_PATH}`);
  const models = Object.entries(p.models ?? {}).map(([id, m]) => ({
    modelId: id,
    contextWindow: m.limit?.context,
    maxOutputTokens: m.limit?.output,
    ...(m.reasoning
      ? {
          reasoning: {
            enabled: m.reasoning.enabled ?? true,
            levels: (m.reasoning.variants ?? []).map((v) => ({ value: v, label: v })),
            defaultLevel: m.reasoning.defaultVariant,
          },
        }
      : {}),
  }));
  return {
    revision: String(Date.now()),
    generatedAt: Date.now(),
    model: { providerId, modelId },
    provider: {
      providerId,
      kind: p.kind ?? "openai-compatible",
      ...(p.apiFormat ? { apiFormat: p.apiFormat } : {}),
      label: p.name,
      source: p.source ?? "workspace",
      baseURL: p.options?.baseURL,
      ...(p.options?.apiKey ? { apiKey: { source: "inline", value: p.options.apiKey } } : {}),
      apiKeyRequired: p.options?.apiKeyRequired,
      models,
    },
  };
}

interface SettingsProvider {
  enabled?: boolean;
  models?: Record<string, unknown>;
}
interface SettingsConfig {
  model?: unknown;
  provider?: Record<string, SettingsProvider>;
}

// Matches the app-server's model-ref format check (aGr in zcode.cjs): a string
// containing a "/" with non-empty text on both sides, i.e. "provider/model".
function isModelRef(v: unknown): v is string {
  if (typeof v !== "string") return false;
  const t = v.indexOf("/");
  return t > 0 && t < v.length - 1;
}

// Extract the "provider/model" ref from either config form the app-server
// accepts: a bare string, or the { main: string } (lite allowed) object form.
function modelRefOf(v: unknown): string | null {
  if (isModelRef(v)) return v;
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const main = (v as { main?: unknown }).main;
    if (isModelRef(main)) return main;
  }
  return null;
}

// First enabled provider that has models -> "provider/model" of its first
// model, or null when there are no usable providers.
function firstModelRef(
  providers: Record<string, SettingsProvider> | undefined,
): string | null {
  for (const [pid, p] of Object.entries(providers ?? {})) {
    if (p.enabled === false) continue;
    const modelId = Object.keys(p.models ?? {})[0];
    if (modelId) return `${pid}/${modelId}`;
  }
  return null;
}

// The app-server resolves models only from its settings file, but the ZCode UI
// writes providers to the v2 config; upsert enabled v2 providers into the
// settings file so anything configured in ZCode reaches the server (v2 is
// authoritative for providers/models, including model additions/removals inside
// existing providers). Called at extension load, before spawn, and on
// config-file changes; the server re-reads the settings file live, so no
// restart is needed for newly merged providers.
//
// Also bootstraps the required top-level `model` ref: keep an existing valid
// ref (the app-server persists session/setModel choices back here), else fall
// back to v2's model selection, else the first enabled provider's first model.
function mergeV2Providers(): string[] {
  let cli: SettingsConfig = { provider: {} };
  try {
    cli = JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) as SettingsConfig;
  } catch (err) {
    // Missing settings file -> bootstrap below. Unreadable/broken file -> leave
    // it alone (overwriting would silently drop the user's mcp/plugins config).
    if (!(err instanceof Error) || (err as NodeJS.ErrnoException).code !== "ENOENT") {
      return [];
    }
  }
  try {
    const v2 = JSON.parse(readFileSync(V2_CONFIG_PATH, "utf8")) as {
      provider?: Record<string, unknown>;
      model?: unknown;
    };
    const changed: string[] = [];
    for (const [pid, p] of Object.entries(v2.provider ?? {})) {
      // Skip disabled entries: the app-server catalog rejects them at load
      // ("Model config is missing"), and the user did not enable them anyway.
      if ((p as { enabled?: boolean }).enabled === false) continue;
      if (JSON.stringify(cli.provider?.[pid]) !== JSON.stringify(p)) {
        cli.provider ??= {};
        cli.provider[pid] = p;
        changed.push(pid);
      }
    }
    // Ensure a valid top-level `model` for the app-server's schema.
    let ref = modelRefOf(cli.model);
    if (ref) {
      const pid = ref.slice(0, ref.indexOf("/"));
      if (!(pid in (cli.provider ?? {}))) ref = null; // provider gone -> re-derive
    }
    if (!ref) {
      ref = modelRefOf(v2.model);
      if (ref) {
        const pid = ref.slice(0, ref.indexOf("/"));
        if (!(pid in (cli.provider ?? {}))) ref = null;
      }
      if (!ref) ref = firstModelRef(cli.provider);
      if (ref && cli.model !== ref) {
        cli.model = ref;
        changed.push("model");
      }
    }
    if (changed.length) {
      if (existsSync(SETTINGS_PATH)) {
        copyFileSync(
          SETTINGS_PATH,
          `${SETTINGS_PATH}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`,
        );
      }
      writeFileSync(SETTINGS_PATH, JSON.stringify(cli, null, 2) + "\n");
    }
    return changed;
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

const ZCODE_CJS_PATHS = [
  "/opt/ZCode/resources/glm/zcode.cjs", // Linux
  "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs", // macOS
];

// Pick the install path that exists, preferring the current platform's.
function defaultServeCmd(): string {
  const ordered =
    process.platform === "darwin"
      ? [ZCODE_CJS_PATHS[1], ZCODE_CJS_PATHS[0]]
      : ZCODE_CJS_PATHS;
  const found = ordered.find((p) => {
    try {
      return existsSync(p);
    } catch {
      return false;
    }
  });
  return `node ${found ?? (process.platform === "darwin" ? ZCODE_CJS_PATHS[1] : ZCODE_CJS_PATHS[0])} app-server`;
}

const SERVE_CMD = process.env.ZCODE_SERVE_CMD ?? defaultServeCmd();

const RUNTIME_PREFS = {
  nativeSearchEnhancementsEnabled: false,
  memoryEnabled: false,
  askUserQuestionAutoResolutionEnabled: true,
  modelContextBudgetStrategy: "preflight-v1",
};

// Polling delay (Promise.withResolvers avoids the executor form).
function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

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
    let ref: { providerId: string; modelId: string };
    try {
      ref = resolveModelRef(model.id);
      if (!sessionId) {
        const created = await request<{ session: { sessionId: string } }>("session/create", {
          workspace: { workspacePath: process.cwd(), workspaceKey: process.cwd() },
        });
        sessionId = created.session.sessionId;
        lastModelId = null;
      } else {
        // The app-server evicts idle sessions from memory (resident pool:
        // idleTimeoutMs 600s by default, plus LRU over 16 sessions) and then
        // rejects session-bound calls with "Session is not active". resume is
        // a no-op while the session is resident and rehydrates it from the
        // persisted store when evicted, so multi-turn continuity survives idle
        // gaps without ever surfacing that error.
        await request("session/resume", { sessionId });
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
      // runtimeModel clears the app-server's restoreWarning on cold resumes (see
      // runtimeModelOf) and keeps the workspace model catalog populated.
      await request("session/send", {
        sessionId,
        content: prompt,
        runtimeModel: runtimeModelOf(ref.providerId, ref.modelId),
      });
    } catch (e) {
      finish("error", e instanceof Error ? e.message : String(e));
      return;
    }

    let settled = false;
    // Any turn ending (completed or failed) releases the app-server's turn
    // lock; the checkpoint path waits for that before sending the next turn.
    let turnSettled = false;
    const onEvent = (msg: unknown) => {
      if (typeof msg !== "object" || msg === null) return;
      if (!("method" in msg) || !("params" in msg)) return;
      if (msg.method !== "state.updated") return;
      const p = msg.params;
      if (typeof p !== "object" || p === null || !("reason" in p)) return;
      const reason = p.reason;
      if (reason === "prompt_completed") settled = true;
      if (reason === "prompt_completed" || reason === "prompt_failed") turnSettled = true;
    };
    listeners.add(onEvent);
    const abortHandler = () => {
      listeners.delete(onEvent);
      clearTimeout(timer);
      void request("session/stop", { sessionId }).catch(() => {});
      finish("aborted", "aborted by user");
    };
    options?.signal?.addEventListener("abort", abortHandler, { once: true });
    // The per-turn budget is a checkpoint, not a failure: interrupt the turn
    // (session/stop), then send "go on" so the ZCode session resumes the task
    // from its own history. The pi stream stays open until the task completes.
    const timer = setTimeout(() => {
      if (settled || output.stopReason !== "pending") return;
      void (async () => {
        try {
          turnSettled = false;
          await request("session/stop", { sessionId });
          // Wait until the app-server actually released the turn lock, then
          // start the continuation; sending "go on" too early is rejected with
          // "A prompt is already running for this session".
          const deadline = Date.now() + 10_000;
          while (!turnSettled && Date.now() < deadline) await delay(100);
          if (settled) return; // turn completed right at the boundary
          await request("session/send", {
            sessionId,
            content: "go on",
            runtimeModel: runtimeModelOf(ref.providerId, ref.modelId),
          });
          timer.refresh?.(); // restart the budget for the continuation
        } catch (e) {
          listeners.delete(onEvent);
          finish("error", e instanceof Error ? e.message : String(e));
        }
      })();
    }, TURN_TIMEOUT_MS);
    timer.unref?.();

    while (!settled) {
      if (output.stopReason !== "pending") return; // aborted/error already finished
      await delay(250);
    }
    clearTimeout(timer);
    listeners.delete(onEvent);

    try {
      // Small settle delay so the final message is queryable.
      await delay(500);
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
  mergeV2Providers();
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
