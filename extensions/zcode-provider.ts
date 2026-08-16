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
// user-execution scopes) -> session/subscribe (turns on live session/event
// notifications) -> session/send {sessionId, content, runtimeModel} -> stream
// model.streaming / tool.updated / turn.* events -> done on state.updated
// reason "prompt_completed". Without the subscription the turn still
// completes and the final text is harvested from session/messages.
//
// Messages typed in pi while a turn is running follow ZCode's own
// followupMode semantics (see ZCODE_STEER_MODE): queue (default) processes
// them as a new turn after the current one; guide (opt-in) injects them into
// the running session at the next tool/message boundary via the v4 command
// channel (conversation subscription + setFollowupMode CAS + sendText).
//
// Server command overridable via env ZCODE_SERVE_CMD; default resolves the
// ZCode install for the current platform (Linux /opt, macOS /Applications).
// Permission requests are auto-allowed unless ZCODE_AUTO_ALLOW=0 (the point is
// that the ZCode agent executes tasks). Verify raw traffic with /zcode-probe.
import { createAssistantMessageEventStream, Type } from "@earendil-works/pi-ai";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
  ToolCall,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { InputEventResult } from "@earendil-works/pi-coding-agent";
import {
  Editor,
  type EditorTheme,
  Key,
  matchesKey,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, watch, writeFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { dirname } from "node:path";

const SETTINGS_PATH =
  process.env.ZCODE_SETTINGS ?? `${process.env.HOME ?? "~"}/.zcode/cli/config.json`;
const V2_CONFIG_PATH =
  process.env.ZCODE_V2_CONFIG ?? `${process.env.HOME ?? "~"}/.zcode/v2/config.json`;
const V2_SETTING_PATH =
  process.env.ZCODE_V2_SETTING ?? `${process.env.HOME ?? "~"}/.zcode/v2/setting.json`;

// How a message typed in pi while a ZCode turn is running is delivered.
//   queue: pi queues it; it runs as a new turn after the current one
//      completes (ZCode followupMode "queue").
//   guide: pi hands the text to the running ZCode session via the v4 command
//      channel; ZCode injects it at the next tool/message boundary inside the
//      SAME turn (ZCode followupMode "guide"), falling back to queue when the
//      turn is not steerable.
// Explicit ZCODE_STEER_MODE wins; otherwise honor ZCode's own UI setting
// (zcodeInteractionBehavior in the v2 setting.json — "guide" means the ZCode
// desktop app itself steers mid-turn), so a ZCode install configured for
// guide-mode interaction steers in pi too. Default: queue.
const STEER_MODE: "queue" | "guide" = (() => {
  const env = process.env.ZCODE_STEER_MODE;
  if (env === "queue" || env === "guide") return env;
  try {
    const setting = JSON.parse(readFileSync(V2_SETTING_PATH, "utf8")) as {
      zcodeInteractionBehavior?: string;
    };
    return setting.zcodeInteractionBehavior === "guide" ? "guide" : "queue";
  } catch {
    return "queue";
  }
})();

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

// Guide-steer state (ZCODE_STEER_MODE=guide): whether a ZCode turn is
// currently running (pi input events during it can be injected live) and the
// v4 publisher facts needed for the setFollowupMode CAS command.
let turnActive = false;
// Background tasks (run_in_background bash etc.) observed running per session,
// tracked from session/event "session.updated" notifications. ZCode's own stop
// (v4 stop / session/stop) leaves them running; the bridge cancels them when a
// pi turn is aborted so a cancel in pi stops everything the agent started.
const runningTasksBySession = new Map<string, Set<string>>();
// Display-only tool plumbing. ZCode executes its own tools inside its session,
// so pi must never actually run them. Every zcode tool name gets a registered
// no-op tool whose execute() returns the result ZCode already produced (stashed
// here from tool.updated events) with terminate:true — pi then renders the
// call + result as a NATIVE tool box (ToolExecutionComponent) and, because
// every result in the batch terminates, never re-prompts the model. The
// registration overrides pi builtins of the same name in the session (e.g.
// "Bash"), which is correct here: the zcode model runs its own tools and never
// uses pi's tool implementations.
const toolResultsByCall = new Map<string, string>();
const registeredDisplayTools = new Set<string>();
// The display-tool definitions we registered (name -> def), so a tool first
// seen mid-stream can also be pushed into the CURRENT turn's context.tools
// (pi's loop snapshots the tool list before streaming; pushing into the same
// array reference the snapshot holds makes the no-op tool resolvable for the
// turn that is already running — otherwise pi reports "Tool not found" and
// re-prompts the model).
const registeredToolDefs = new Map<string, { name: string; description: string; parameters: unknown; execute: (toolCallId: string) => Promise<{ content: { type: "text"; text: string }[]; details: Record<string, never>; terminate: true }> }>();
let extApi: ExtensionAPI | null = null;

// ZCode's tool set (observed from session messages); registered as display-only
// so pi renders native tool boxes without executing them. Unknown names are
// registered lazily on first sight (see streamSimple).
const ZCODE_TOOL_NAMES = [
  "Agent",
  "AskUserQuestion",
  "Bash",
  "CronCreate",
  "CronDelete",
  "CronList",
  "CronUpdate",
  "Edit",
  "EnterPlanMode",
  "ExitPlanMode",
  "Read",
  "Skill",
  "TaskOutput",
  "TaskStop",
  "TodoRead",
  "TodoWrite",
  "WebFetch",
  "Write",
  "SendMessage",
  "ReadSessionContext",
];

// ZCode tool names are namespaced: builtins are plain ("Bash", "Read"),
// MCP tools are "mcp__<server>__<tool>" (e.g. "mcp__codegraph__codegraph_explore"),
// skills/plugins may use their own prefixes. pi renders the toolCall block's
// name verbatim as the box title, so map zcode names to clean display names:
//   "mcp__codegraph__codegraph_explore" -> "codegraph__codegraph_explore"
// The double underscore keeps zcode-MCP tools visually distinct from pi's own
// MCP tools (pi names those "<server>_<tool>", single underscore), so the
// no-op display tools never shadow pi's own MCP tools. The toolCall block and
// the registered no-op tool both use the display name, so pi's loop still
// finds the tool (by name) and executes it as a display-only box.
function displayToolName(toolName: string): string {
  return toolName.startsWith("mcp__") ? toolName.slice("mcp__".length) : toolName;
}

function ensureDisplayTool(pi: ExtensionAPI | null, name: string): void {
  if (!pi || !name || registeredDisplayTools.has(name)) return;
  registeredDisplayTools.add(name);
  const def = {
    name,
    label: name,
    description: `Display-only tool executed by the ZCode agent (zcode-provider bridge).`,
    parameters: Type.Record(Type.String(), Type.Any()),
    async execute(toolCallId: string) {
      const res = toolResultsByCall.get(toolCallId);
      toolResultsByCall.delete(toolCallId);
      return {
        content: [{ type: "text", text: res ?? "" }],
        details: {},
        terminate: true,
      };
    },
  };
  registeredToolDefs.set(name, {
    name: def.name,
    description: def.description,
    parameters: def.parameters,
    execute: def.execute,
  });
  pi.registerTool(def);
}
// The pi UI context, captured at session_start. Used to show the question
// dialog when the ZCode app-server asks the user (interaction/requestUserInput,
// the model's askUserQuestion tool) and pass the answer back into the session.
let uiCtx: ExtensionContext | null = null;
const guideSessions = new Set<string>();
const v4StateBySession = new Map<
  string,
  { logEpoch?: string; revision: number; snapshotRevision?: number }
>();

// Track session revisions from session-scope state.updated notifications and
// the initial v4 conversation snapshot so the CAS setFollowupMode command can
// present a fresh baseRevision.
listeners.add((msg) => {
  const m = msg as {
    method?: string;
    params?: { scope?: string; sessionId?: string; revision?: number };
  };
  if (
    m.method === "state.updated" &&
    m.params?.scope === "session" &&
    m.params?.sessionId &&
    typeof m.params.revision === "number"
  ) {
    const st = v4StateBySession.get(m.params.sessionId) ?? { revision: 0 };
    st.revision = Math.max(st.revision, m.params.revision);
    v4StateBySession.set(m.params.sessionId, st);
  }
});

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
    } else if (msg.method === "interaction/requestUserInput") {
      // ZCode's askUserQuestion tool: the model asks the user. Show the
      // question dialog in pi and answer with the user's choice so the ZCode
      // agent continues in the same session.
      void handleUserInputInteraction(msg);
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

// A live session/event notification (method "session/event") pushed by the
// app-server after a session/subscribe. The interesting payloads:
//   model.streaming: {kind: text_start|text_delta|text_end|reasoning_start|
//       reasoning_delta|reasoning_end|tool_input_start|tool_input_delta|
//       tool_input_end|tool_call, delta?, input?, assistantMessageId?,
//       toolCallId?, toolName?}
//   tool.updated:   {toolCallId, toolName, kind: scheduled|started|result|
//       batch, result?: {success, content, truncated}}  (tool execution status
//       and output; the bridge renders these inline in the transcript)
//   turn.completed: {response}   turn.failed: {reason}
//   session.updated: {taskId, taskKind, status, toolName, command, pid, ...}
//       (background-task status pushes, e.g. run_in_background bash)
interface ZcodeStreamEvent {
  type: string;
  payload?: {
    kind?: string;
    delta?: string;
    input?: unknown;
    assistantMessageId?: string;
    toolCallId?: string;
    toolName?: string;
    reason?: string;
    response?: string;
    result?: ZcodeToolResult;
    taskId?: string;
    taskKind?: string;
    status?: string;
  };
}

interface ZcodeToolResult {
  success?: boolean;
  content?: unknown;
  truncated?: boolean;
}

function parsePartialJson(s: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(s);
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function normalizeToolInput(input: unknown): Record<string, unknown> {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  return typeof input === "string" ? parsePartialJson(input) : {};
}

// ---- Tool display. ZCode executes its own tools inside its session, so the
// bridge emits real pi toolCall content blocks and registers a matching
// display-only (no-op, terminate) tool per name — pi then renders each call +
// result as a native ToolExecutionComponent box and never executes the tool
// itself. The result text ZCode reports is stashed here (keyed by toolCallId)
// and handed back by the no-op execute() at turn end.

// Cap displayed tool output so a huge result does not flood the box.
const MAX_RESULT_CHARS = 6000;

function toolResultContent(result: ZcodeToolResult): string {
  const content = result.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) =>
        c && typeof c === "object" ? ((c as { text?: string }).text ?? "") : String(c),
      )
      .filter(Boolean)
      .join("\n");
  }
  return content === undefined || content === null
    ? ""
    : JSON.stringify(content, null, 2);
}

function toolResultBody(result: ZcodeToolResult): string {
  let text = toolResultContent(result);
  if (!text.trim()) text = result.success === false ? "Tool failed" : "";
  if (!text.trim()) return "";
  let body = text;
  if (body.length > MAX_RESULT_CHARS) {
    body = body.slice(0, MAX_RESULT_CHARS) + `\n… (${body.length - MAX_RESULT_CHARS} more chars)`;
  }
  if (result.truncated) body += "\n… (truncated by ZCode)";
  return body;
}

// ---- interaction/requestUserInput (ZCode askUserQuestion) ----
// The app-server asks the connected client to collect answers from the user
// (the model called its askUserQuestion tool, 1-4 questions each with
// header/question/options[2-4]/multiSelect). Show pi's question dialog, then
// answer the request so the ZCode agent resumes with the user's choices.
// Response content: {answer} for one question, {answers: {question: ans}}
// for several (the server maps them back; multiSelect label arrays join ", ").

interface ZcodeWireOption {
  value?: string;
  label: string;
  description?: string;
  preview?: string;
}
interface ZcodeWireQuestion {
  question: string;
  header?: string;
  options?: ZcodeWireOption[];
  multiSelect?: boolean;
}

async function handleUserInputInteraction(msg: {
  id: string;
  params?: { questions?: ZcodeWireQuestion[]; prompt?: string };
}): Promise<void> {
  const respond = (result: unknown) => {
    if (!proc?.stdin) return;
    proc.stdin.write(JSON.stringify({ id: msg.id, result }) + "\n");
  };
  try {
    const questions = Array.isArray(msg.params?.questions) ? msg.params.questions : [];
    if (questions.length === 0) throw new Error("no questions in interaction");
    const content = await askQuestionsInPi(questions);
    respond({ action: "accept", content });
  } catch {
    respond({ action: "cancel", reason: "cancelled by user in pi" });
  }
}

type QuestionAnswer = string | string[];

async function askQuestionsInPi(questions: ZcodeWireQuestion[]): Promise<Record<string, unknown>> {
  const ctx = uiCtx;
  if (!ctx || ctx.mode !== "tui") throw new Error("no interactive pi UI");
  if (questions.length === 1) {
    const ans = await askOneQuestionInPi(ctx, questions[0]);
    if (ans === null) throw new Error("cancelled");
    return { answer: ans };
  }
  const answers: Record<string, QuestionAnswer> = {};
  for (const q of questions) {
    const ans = await askOneQuestionInPi(ctx, q);
    if (ans === null) throw new Error("cancelled");
    answers[q.question] = ans;
  }
  return { answers };
}

// One question dialog: options with descriptions, a "Type something." free
// text entry (ZCode provides no Other option itself), and multiSelect via
// Space toggles + Enter confirm. Esc returns null (cancels the interaction).
async function askOneQuestionInPi(
  ctx: ExtensionContext,
  q: ZcodeWireQuestion,
): Promise<string | string[] | null> {
  const opts: { label: string; description?: string }[] = (q.options ?? []).map((o) => ({
    label: o.label,
    description: o.description,
  }));
  const multi = q.multiSelect === true;
  const title = q.header && q.header.trim() ? `[${q.header.trim()}] ${q.question}` : q.question;

  return ctx.ui.custom<string | string[] | null>(
    (tui, theme, _kb, done) => {
      let index = 0;
      let editMode = false;
      let toggled = new Set<number>();
      let cachedLines: string[] | undefined;

      const editorTheme: EditorTheme = {
        borderColor: (s) => theme.fg("accent", s),
        selectList: {
          selectedPrefix: (t) => theme.fg("accent", t),
          selectedText: (t) => theme.fg("accent", t),
          description: (t) => theme.fg("muted", t),
          scrollInfo: (t) => theme.fg("dim", t),
          noMatch: (t) => theme.fg("warning", t),
        },
      };
      const editor = new Editor(tui, editorTheme);
      editor.onSubmit = (value) => {
        const trimmed = value.trim();
        if (trimmed) {
          done(multi ? [trimmed] : trimmed);
        } else {
          editMode = false;
          editor.setText("");
          refresh();
        }
      };

      function refresh() {
        cachedLines = undefined;
        tui.requestRender();
      }

      function handleInput(data: string) {
        if (editMode) {
          if (matchesKey(data, Key.escape)) {
            editMode = false;
            editor.setText("");
            refresh();
            return;
          }
          editor.handleInput(data);
          refresh();
          return;
        }
        if (matchesKey(data, Key.up)) {
          index = Math.max(0, index - 1);
          refresh();
          return;
        }
        if (matchesKey(data, Key.down)) {
          index = Math.min(opts.length, index + 1); // +1 for "Type something."
          refresh();
          return;
        }
        if (multi && matchesKey(data, Key.space) && index < opts.length) {
          if (toggled.has(index)) toggled.delete(index);
          else toggled.add(index);
          refresh();
          return;
        }
        if (matchesKey(data, Key.enter)) {
          if (index === opts.length) {
            editMode = true; // free text
            refresh();
            return;
          }
          if (multi) {
            if (toggled.size === 0) {
              refresh(); // require at least one selection
              return;
            }
            done([...toggled].map((i) => opts[i].label));
            return;
          }
          done(opts[index].label);
          return;
        }
        if (matchesKey(data, Key.escape)) {
          done(null);
        }
      }

      function render(width: number): string[] {
        if (cachedLines) return cachedLines;
        const lines: string[] = [];
        const renderWidth = Math.max(1, width);

        function addWrapped(text: string) {
          lines.push(...wrapTextWithAnsi(text, renderWidth));
        }
        function addWrappedWithPrefix(prefix: string, text: string) {
          const prefixWidth = visibleWidth(prefix);
          if (prefixWidth >= renderWidth) {
            addWrapped(prefix + text);
            return;
          }
          const wrapped = wrapTextWithAnsi(text, renderWidth - prefixWidth);
          const continuationPrefix = " ".repeat(prefixWidth);
          for (let i = 0; i < wrapped.length; i++) {
            lines.push(`${i === 0 ? prefix : continuationPrefix}${wrapped[i]}`);
          }
        }

        lines.push(theme.fg("accent", "─".repeat(renderWidth)));
        addWrappedWithPrefix(" ", theme.fg("text", title));
        lines.push("");

        for (let i = 0; i <= opts.length; i++) {
          const isOther = i === opts.length;
          const selected = i === index;
          const isToggled = !isOther && multi && toggled.has(i);
          const prefix = selected ? theme.fg("accent", "> ") : "  ";
          const mark = isToggled ? theme.fg("success", "✓ ") : multi && !isOther ? "  " : "";
          const label = isOther ? "Type something." : opts[i].label;
          const color = selected || (isOther && editMode) ? "accent" : isToggled ? "success" : "text";
          addWrappedWithPrefix(prefix, mark + theme.fg(color, label));
          if (!isOther && opts[i].description) {
            addWrappedWithPrefix("     ", theme.fg("muted", opts[i].description ?? ""));
          }
        }

        if (editMode) {
          lines.push("");
          addWrappedWithPrefix(" ", theme.fg("muted", "Your answer:"));
          for (const line of editor.render(Math.max(1, renderWidth - 2))) {
            lines.push(` ${line}`);
          }
        }

        lines.push("");
        if (editMode) {
          addWrappedWithPrefix(" ", theme.fg("dim", "Enter to submit • Esc to go back"));
        } else if (multi) {
          addWrappedWithPrefix(
            " ",
            theme.fg("dim", "↑↓ navigate • Space toggle • Enter confirm • Esc cancel"),
          );
        } else {
          addWrappedWithPrefix(" ", theme.fg("dim", "↑↓ navigate • Enter select • Esc cancel"));
        }
        lines.push(theme.fg("accent", "─".repeat(renderWidth)));

        cachedLines = lines;
        return lines;
      }

      return {
        render,
        invalidate: () => {
          cachedLines = undefined;
        },
        handleInput,
      };
    },
  );
}

// The app-server does not emit the final text until prompt_completed, but
// session/messages right after completion is always queryable; used as the
// non-streaming fallback when live subscription failed.
async function harvestLastAssistantText(): Promise<string> {
  if (!sessionId) return "";
  try {
    // Small settle delay so the final message is queryable.
    await delay(500);
    const msgs = await request<{ messages: ZcodeMessage[] }>("session/messages", {
      sessionId,
    });
    const lastAssistant = [...(msgs.messages ?? [])]
      .reverse()
      .find((m) => m.info?.role === "assistant");
    return (lastAssistant?.parts ?? [])
      .filter((p) => p.type === "text")
      .map((p) => p.text ?? "")
      .join("");
  } catch {
    return "";
  }
}

// Enable ZCode-native "guide" handling on a session: v4 conversation
// subscription (creates the publisher whose inputRouting drives the delivery
// decision), then setFollowupMode guide (CAS). Best-effort: on any failure
// (unsupported build, CAS revision mismatch) the session stays in queue mode
// and sendText inputs are processed after the current turn.
async function setupGuideMode(sid: string): Promise<void> {
  if (STEER_MODE !== "guide" || guideSessions.has(sid)) return;
  guideSessions.add(sid);
  if (!proc) return;
  let snapshotSeen = false;
  const onFrame = (msg: unknown) => {
    const m = msg as {
      method?: string;
      params?: {
        topic?: string;
        frame?: {
          payload?: {
            kind?: string;
            snapshot?: { revision?: number; logEpoch?: string };
          };
        };
      };
    };
    if (m.method !== "v4/conversation/frame" || typeof m.params?.topic !== "string") return;
    // Frames carry the conversation topic, not the sessionId.
    const frameSid = m.params.topic.startsWith("conversation/")
      ? m.params.topic.slice("conversation/".length)
      : undefined;
    if (!frameSid) return;
    const snap = m.params.frame?.payload?.snapshot;
    if (typeof snap?.revision === "number") {
      const st = v4StateBySession.get(frameSid) ?? { revision: 0 };
      // The snapshot revision is what the CAS compares against; session-scope
      // state.updated revisions may already exceed it (they surface the reach
      // ahead of the publisher snapshot), so keep the raw snapshot value.
      st.snapshotRevision = snap.revision;
      st.revision = Math.max(st.revision, snap.revision);
      if (snap.logEpoch) st.logEpoch ??= snap.logEpoch;
      v4StateBySession.set(frameSid, st);
    }
    if (m.params.frame?.payload?.kind === "snapshot") snapshotSeen = true;
  };
  listeners.add(onFrame);
  try {
    const sub = await request<{ ack?: { logEpoch?: string } }>(
      "v4/conversation/subscribe",
      {
        topic: `conversation/${sid}`,
        connectionId: `pi-${randomUUID()}`,
        clientMode: "desktop-continuous",
      },
    );
    const st = v4StateBySession.get(sid) ?? { revision: 0 };
    st.logEpoch ??= sub.ack?.logEpoch;
    v4StateBySession.set(sid, st);
    // The subscription response is followed by an outbox flush of the initial
    // conversation frames (payload.kind "snapshot" carries the session's
    // authoritative revision); wait for one so the CAS baseRevision is fresh.
    const deadline = Date.now() + 3000;
    while (!snapshotSeen && Date.now() < deadline) await delay(100);
    // CAS setFollowupMode; on a stale baseRevision retry once the frames
    // report a newer one.
    for (let attempt = 0; attempt < 3; attempt++) {
      const cur = v4StateBySession.get(sid);
      if (process.env.ZCODE_DEBUG)
        console.error(
          "[zcode-debug] CAS attempt", attempt,
          "revision =", cur?.revision,
          "logEpoch =", cur?.logEpoch,
        );
      const fm = await request<{ status?: string; reasonCode?: string }>(
        "v4/command",
        {
          commandId: `pi-fm-${nextId++}`,
          clientId: "pi-bridge",
          sessionId: sid,
          type: "setFollowupMode",
          payload: { mode: "guide" },
          baseRevision: cur?.snapshotRevision ?? cur?.revision ?? 0,
          baseLogEpoch: cur?.logEpoch,
          issuedAt: Date.now(),
        },
      );
      if (process.env.ZCODE_DEBUG)
        console.error("[zcode-debug] setFollowupMode ack:", JSON.stringify(fm));
      if (fm?.status !== "stale") return;
      // Wait for a newer snapshot/delta revision before retrying.
      const before = v4StateBySession.get(sid)?.revision ?? 0;
      const retryDeadline = Date.now() + 1500;
      while (
        Date.now() < retryDeadline &&
        (v4StateBySession.get(sid)?.revision ?? 0) === before
      ) {
        await delay(100);
      }
    }
  } catch (e) {
    if (process.env.ZCODE_DEBUG)
      console.error("[zcode-debug] setupGuideMode failed:", e instanceof Error ? e.message : String(e));
  } finally {
    listeners.delete(onFrame);
  }
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
    const finish = (reason: "stop" | "error" | "aborted", errorMessage?: string) => {
      if (output.stopReason !== "pending") return;
      if (reason === "stop") {
        output.stopReason = "stop";
        out.push({ type: "done", reason: "stop", message: output });
      } else {
        output.stopReason = reason;
        output.errorMessage = errorMessage ?? output.errorMessage;
        out.push({ type: "error", reason, error: output });
      }
    };

    // ---- Live-stream bookkeeping. The app-server can batch away the
    // *_start markers of a stream, so every event must be able to lazily
    // create its content block; deltas append and *_end finalize. Blocks are
    // keyed by assistantMessageId (text/reasoning). ZCode runs its own tools,
    // so tool calls are emitted as real pi toolCall blocks (keyed by
    // toolCallId) rendered as native tool boxes; the registered display-only
    // tool returns the stashed result at turn end.
    const msgBlocks = new Map<string, { text?: number; thinking?: number }>();
    const toolNames = new Map<string, string>();
    const toolCallIndex = new Map<string, number>();
    const finalizedTools = new Set<string>();
    const started = new Set<number>();
    const ended = new Set<number>();
    const partialJson = new Map<string, string>();
    let streamedText = false;
    let finalResponse: string | undefined;
    let settled = false;
    let turnSettled = false;
    let failed = false;

    const blockAt = (idx: number) => output.content[idx];
    const blockFor = (msgKey: string, kind: "text" | "thinking"): number => {
      const entry = msgBlocks.get(msgKey) ?? {};
      let idx = kind === "text" ? entry.text : entry.thinking;
      if (idx === undefined) {
        idx = output.content.length;
        output.content.push(
          kind === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" },
        );
        if (kind === "text") entry.text = idx;
        else entry.thinking = idx;
        msgBlocks.set(msgKey, entry);
      }
      return idx;
    };
    const emitStart = (idx: number, kind: "text" | "thinking") => {
      if (started.has(idx)) return;
      started.add(idx);
      out.push({
        type: kind === "text" ? "text_start" : "thinking_start",
        contentIndex: idx,
        partial: output,
      });
    };
    const emitDelta = (idx: number, delta: string, kind: "text" | "thinking") => {
      const block = blockAt(idx);
      if (kind === "text") (block as { text: string }).text += delta;
      else (block as { thinking: string }).thinking += delta;
      emitStart(idx, kind);
      out.push({
        type: kind === "text" ? "text_delta" : "thinking_delta",
        contentIndex: idx,
        delta,
        partial: output,
      });
    };
    const emitEnd = (idx: number, kind: "text" | "thinking") => {
      if (ended.has(idx)) return;
      ended.add(idx);
      const block = blockAt(idx);
      out.push({
        type: kind === "text" ? "text_end" : "thinking_end",
        contentIndex: idx,
        content: kind === "text" ? (block as { text: string }).text : (block as { thinking: string }).thinking,
        partial: output,
      });
    };

    // Live process: model.streaming carries the assistant text, reasoning and
    // tool-call streams in real time; turn.completed delivers the final
    // response as a fallback. state.updated (prompt_completed/prompt_failed)
    // remains the terminal signal.
    const onEvent = (msg: unknown) => {
      if (typeof msg !== "object" || msg === null) return;
      const m = msg as { method?: string; params?: unknown };
      if (!m.method || !m.params) return;
      if (m.method === "state.updated") {
        const reason = (m.params as { reason?: string }).reason;
        if (reason === "prompt_completed") settled = true;
        if (reason === "prompt_failed") failed = true;
        if (reason === "prompt_completed" || reason === "prompt_failed") turnSettled = true;
        return;
      }
      if (m.method !== "session/event") return;
      const ev = m.params as ZcodeStreamEvent;
      if (!ev.type) return;
      const pl = ev.payload ?? {};
      if (ev.type === "turn.completed") {
        if (typeof pl.response === "string" && pl.response) finalResponse = pl.response;
        settled = true;
        turnSettled = true;
        return;
      }
      if (ev.type === "turn.failed") {
        failed = true;
        turnSettled = true;
        return;
      }
      if (ev.type === "tool.updated") {
        // Tool execution result notifications: stash the result text so the
        // display-only tool's execute() returns it at turn end (pi then shows
        // it inside the native tool box). Results that never arrive leave the
        // box showing only the call.
        const callId = pl.toolCallId ?? "";
        if (callId && pl.kind === "result" && pl.result !== undefined) {
          toolResultsByCall.set(callId, toolResultBody(pl.result));
        }
        return;
      }
      if (ev.type === "session.updated") {
        // Background-task status pushes (run_in_background bash etc.): track
        // running tasks so a pi abort can stop them too (ZCode's own stop
        // does not). Any non-"running" status retires the task id.
        const tid = pl.taskId;
        const status = pl.status;
        if (typeof tid === "string" && tid && typeof status === "string" && status) {
          const evSid = (m.params as { sessionId?: string }).sessionId ?? sessionId;
          if (evSid) {
            const set = runningTasksBySession.get(evSid) ?? new Set<string>();
            if (status === "running") set.add(tid);
            else set.delete(tid);
            runningTasksBySession.set(evSid, set);
          }
        }
        return;
      }
      if (ev.type !== "model.streaming") return;
      const kind = pl.kind;
      const key = pl.assistantMessageId ?? "";
      if (kind === "text_start" || kind === "text_delta") {
        const idx = blockFor(key, "text");
        if (typeof pl.delta === "string" && pl.delta) {
          streamedText = true;
          emitDelta(idx, pl.delta, "text");
        } else emitStart(idx, "text");
      } else if (kind === "text_end") {
        emitEnd(blockFor(key, "text"), "text");
      } else if (kind === "reasoning_start" || kind === "reasoning_delta") {
        const idx = blockFor(key, "thinking");
        if (typeof pl.delta === "string" && pl.delta) emitDelta(idx, pl.delta, "thinking");
        else emitStart(idx, "thinking");
      } else if (kind === "reasoning_end") {
        emitEnd(blockFor(key, "thinking"), "thinking");
      } else if (kind === "tool_input_start") {
        // Open a native pi toolCall block; the box appears live as the args
        // stream in (tool_input_delta), finalized on tool_input_end/tool_call.
        const callId = pl.toolCallId ?? "";
        if (callId && !toolCallIndex.has(callId)) {
          const toolName = displayToolName(pl.toolName ?? "tool");
          toolNames.set(callId, toolName);
          ensureDisplayTool(extApi, toolName);
          // Make the no-op tool resolvable for the CURRENT turn too: the loop
          // snapshotted its tool list before streaming, so push the def into
          // that same array (context.tools) — otherwise execution reports
          // "Tool not found" and the model gets re-prompted. Replace any
          // same-named entry (e.g. a pi tool the zcode name collides with):
          // in a zcode turn the tool already ran inside ZCode, so pi must
          // display the result, never execute its own copy.
          const tools = (context as { tools?: { name: string; description: string; parameters: unknown; execute: unknown }[] }).tools;
          const def = registeredToolDefs.get(toolName);
          if (def && Array.isArray(tools)) {
            const i = tools.findIndex((t) => t.name === toolName);
            const entry = { name: def.name, description: def.description, parameters: def.parameters, execute: def.execute };
            if (i >= 0) tools[i] = entry;
            else tools.push(entry);
          }
          const idx = output.content.length;
          output.content.push({ type: "toolCall", id: callId, name: toolName, arguments: {} });
          toolCallIndex.set(callId, idx);
          out.push({ type: "toolcall_start", contentIndex: idx, partial: output });
        }
      } else if (kind === "tool_input_delta") {
        const callId = pl.toolCallId ?? "";
        if (callId) {
          const json = (partialJson.get(callId) ?? "") + (pl.delta ?? "");
          partialJson.set(callId, json);
          const idx = toolCallIndex.get(callId);
          if (idx !== undefined) {
            (output.content[idx] as ToolCall).arguments = parsePartialJson(json);
            out.push({ type: "toolcall_delta", contentIndex: idx, delta: pl.delta ?? "", partial: output });
          }
        }
      } else if (kind === "tool_input_end" || kind === "tool_call") {
        // The app-server emits both tool_input_end and tool_call per call;
        // finalize the block once, preferring the authoritative input.
        const callId = pl.toolCallId ?? "";
        const idx = callId ? toolCallIndex.get(callId) : undefined;
        if (callId && idx !== undefined && !finalizedTools.has(callId)) {
          finalizedTools.add(callId);
          const args =
            kind === "tool_call" && pl.input !== undefined
              ? normalizeToolInput(pl.input)
              : parsePartialJson(partialJson.get(callId) ?? "");
          const toolName = toolNames.get(callId) ?? displayToolName(pl.toolName ?? "tool");
          (output.content[idx] as ToolCall).arguments = args;
          out.push({
            type: "toolcall_end",
            contentIndex: idx,
            toolCall: { type: "toolCall", id: callId, name: toolName, arguments: args },
            partial: output,
          });
        }
      }
    };

    let ref: { providerId: string; modelId: string };
    let prompt = "";
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
      prompt =
        typeof last?.content === "string"
          ? last.content
          : (last?.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join("");
      if (!prompt) throw new Error("no user message in context");
    } catch (e) {
      finish("error", e instanceof Error ? e.message : String(e));
      return;
    }

    // Listen BEFORE session/send: the app-server streams the first deltas
    // almost immediately after the turn starts, while send is still awaiting.
    listeners.add(onEvent);
    const abortHandler = () => {
      listeners.delete(onEvent);
      turnActive = false;
      clearTimeout(timer);
      void (async () => {
        const sid = sessionId;
        if (!sid) return;
        try {
          await request("session/stop", { sessionId: sid });
          // ZCode's own stop (v4 stop / session/stop) leaves run_in_background
          // tasks running; cancel them explicitly so a cancel in pi stops
          // everything the agent started in this session.
          const tasks = runningTasksBySession.get(sid);
          if (tasks && tasks.size > 0) {
            for (const taskId of [...tasks]) {
              await request("session/cancelBackgroundTask", {
                sessionId: sid,
                taskId,
              }).catch(() => {});
            }
            runningTasksBySession.delete(sid);
          }
        } catch {
          /* server may already be gone */
        }
      })();
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

    try {
      // session/subscribe switches on live session/event notifications
      // (desktop-continuous = push, not replay). Best-effort: without it the
      // turn still completes and the harvest below yields the final text.
      await request("session/subscribe", {
        sessionId,
        deliveryKind: "desktop-continuous",
      }).catch(() => {});
      // ZCode-native steer mode (guide): make the session inject inputs sent
      // while the turn is running at the next tool/message boundary.
      await setupGuideMode(sessionId);
      // runtimeModel clears the app-server's restoreWarning on cold resumes (see
      // runtimeModelOf) and keeps the workspace model catalog populated.
      await request("session/send", {
        sessionId,
        content: prompt,
        runtimeModel: runtimeModelOf(ref.providerId, ref.modelId),
      });
      turnActive = true;
    } catch (e) {
      listeners.delete(onEvent);
      clearTimeout(timer);
      turnActive = false;
      finish("error", e instanceof Error ? e.message : String(e));
      return;
    }

    while (!settled && !failed) {
      if (output.stopReason !== "pending") return; // aborted/error already finished
      await delay(250);
    }
    clearTimeout(timer);
    listeners.delete(onEvent);
    turnActive = false;

    if (failed) {
      finish("error", "zcode turn ended with failure");
      return;
    }
    if (!streamedText) {
      // No live deltas arrived (unsubscribed/quiet model): fall back to the
      // definitive final response, then to the messages store.
      const full = (finalResponse ?? "").trim() || (await harvestLastAssistantText());
      if (full) {
        const idx = blockFor("", "text");
        streamedText = true;
        emitDelta(idx, full, "text");
        emitEnd(idx, "text");
      }
    }
    finish("stop");
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
  extApi = pi;
  // Register the display-only no-op tools up front so every zcode tool call
  // renders as a native pi tool box from the first turn (and pi never tries
  // to execute ZCode's tools itself). Unknown tool names are registered lazily
  // in streamSimple on first sight.
  for (const name of ZCODE_TOOL_NAMES) ensureDisplayTool(pi, name);
  mergeV2Providers();
  // Capture the pi UI context so interaction/requestUserInput (askUserQuestion)
  // can show its dialog from the app-server's request handler.
  pi.on("session_start", (_event, ctx) => {
    uiCtx = ctx;
  });
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

  // ZCode-native steer: with ZCODE_STEER_MODE=guide, a message typed in pi
  // while the ZCode turn is running is sent straight to the running session
  // via the v4 command channel (sendText). The app-server admits it as a
  // guide input (injected at the next tool/message boundary) or falls back to
  // a queue. Returning "handled" keeps pi from duplicating it into its own
  // next turn; on any failure we fall back to pi's normal queueing.
  pi.on("input", async (event): Promise<InputEventResult> => {
    if (STEER_MODE !== "guide") return { action: "continue" };
    if (event.streamingBehavior !== "steer") return { action: "continue" };
    if (!turnActive || !sessionId) return { action: "continue" };
    try {
      await request("v4/command", {
        commandId: `pi-steer-${nextId++}`,
        clientId: "pi-bridge",
        sessionId,
        type: "sendText",
        payload: { text: event.text, attachments: [] },
        issuedAt: Date.now(),
      });
      return { action: "handled" };
    } catch (e) {
      if (process.env.ZCODE_DEBUG) console.error("[zcode-debug] steer sendText failed:", e instanceof Error ? e.message : String(e));
      return { action: "continue" };
    }
  });

  pi.on("session_shutdown", async () => {
    turnActive = false;
    guideSessions.clear();
    v4StateBySession.clear();
    runningTasksBySession.clear();
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
