# zcode-provider

Turn the **ZCode** agent (`zcodex app-server`, an OpenCode-derived CLI agent) into a
pi model provider. pi is the chat frontend; the ZCode agent keeps its own
session, runs its own tools (bash, edits, plugins, ...), and its reply is
streamed back into pi in real time — the reasoning, the tool calls and the
final text all arrive as they happen, not as one chunk at the end. Reasoning,
text, tool calls and their results are rendered **inline, interleaved in the
exact order ZCode produced them** (ZCode executes the tools itself; pi only
displays the call/results as formatted transcript blocks).

Each ZCode provider/model configured in ZCode becomes a selectable pi model, and
the list auto-syncs from ZCode's config — no hardcoded model list, no pi reload
when you add or change providers.

## Install

```sh
# from npm (recommended)
pi install npm:zcode-provider

# or from the GitHub repo:
pi install git:github.com/ZhouXiaolin/zcode-provider
# pinned to a release:
pi install git:github.com/ZhouXiaolin/zcode-provider@v0.1.0
```

Requirements:

- **ZCode CLI** (`zcodex` / `zcode app-server`) installed and functional — this
  is a bridge to the local ZCode agent, not a cloud API.
- pi (obviously).

After installing, run `/reload` inside pi, then `/model` and pick a ZCode model,
e.g. `火山/glm-latest` or `Z.ai - Coding Plan/GLM-5.3`. Switching models
mid-conversation works via ZCode's `session/setModel`.

## How model selection works

ZCode's app-server resolves models only from its settings file
(`~/.zcode/cli/config.json`), while the ZCode UI writes providers to
`~/.zcode/v2/config.json`. This extension:

1. **Merges enabled providers** from the v2 config into the settings file at
   server spawn and whenever either `config.json` changes (the app-server
   re-reads its settings file live, so newly merged providers work immediately).
2. **Bootstraps the settings file's `model` field.** The app-server validates
   the settings file against a strict schema that *requires* a top-level
   `model` — a `"provider/model"` ref — and refuses to run a turn with
   "Model config is missing" when it is absent or invalid. The extension keeps
   an existing valid ref (the app-server persists `session/setModel` choices
   back to this field), else falls back to the v2 config's own model
   selection, else the first enabled provider's first model. The settings file
   is also created from scratch when it does not exist yet.
3. **Publishes the catalog to pi** via `refreshModels`, so opening `/model`
   always shows the current providers/models without a reload.
4. **Switches the ZCode session model** with `session/setModel` when you pick a
   different pi model. The choice also persists back to ZCode's config
   (`model.main`), so the model you last used in pi is ZCode's default.

Provider edits are additive and every write to the settings file is backed up
first (`config.json.bak-<timestamp>`).

## Configuration

Environment variables (set before starting pi):

| Variable | Default | Meaning |
| --- | --- | --- |
| `ZCODE_SERVE_CMD` | `node <zcode.cjs> app-server` (auto-detected: `/opt/ZCode/resources/glm/zcode.cjs` on Linux, `/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs` on macOS) | Command that starts the ZCode stdio app server |
| `ZCODE_SETTINGS` | `~/.zcode/cli/config.json` | Settings file the app-server reads models from |
| `ZCODE_V2_CONFIG` | `~/.zcode/v2/config.json` | ZCode UI config whose enabled providers are merged in |
| `ZCODE_AUTO_ALLOW` | `1` (enabled) | Auto-answer ZCode permission prompts. Set to `0` to deny tool permission requests |
| `ZCODE_TURN_TIMEOUT_MS` | `1800000` (30 min) | Per-turn budget. On timeout the bridge interrupts the turn (`session/stop`) and sends the session `go on`, so long tasks keep progressing instead of failing. Raise it for turns that need to run longer uninterrupted |
| `ZCODE_STEER_MODE` | auto | How a message typed in pi while a ZCode turn is running is handled, using ZCode's own two delivery modes: `queue` (processed as a new turn after the current one completes — pi's standard behavior) or `guide` (sent to the running session via ZCode's v4 command channel and injected at the next tool/message boundary inside the same turn, falling back to a queue when the turn is not steerable). Default follows ZCode's own UI setting (`zcodeInteractionBehavior` in `~/.zcode/v2/setting.json`): `guide` when ZCode is configured for guide-mode interaction, else `queue`. Set explicitly to override |

## Security

> **This bridge gives pi the full power of your ZCode agent.** ZCode runs its own
> tools (bash, file edits, plugins) with your configured model. By default the
> bridge auto-answers ZCode's permission prompts with "allow" — that is the
> point of the bridge, but review what you let it do. Set `ZCODE_AUTO_ALLOW=0`
> to have it deny permission requests instead. Review the source before use.

No API keys are stored in this package; the bridge reads ZCode's own local
config. The dummy provider key `zcode-bridge` is only a pi placeholder.

## Debugging

Run `/zcode-probe` in pi: it runs one full turn against the app-server and dumps
the raw protocol lines to `/tmp/zcode-probe.jsonl`.

## How it works (wire protocol)

`zcodex app-server` speaks a private NDJSON protocol over stdio (not standard
JSON-RPC). The bridge implements the subset:

`session/create` → answer `session/requestRuntimePreferences` → `session/resume`
(no-op while resident, rehydrates after idle eviction) → `session/subscribe` →
`session/send` → stream `session/event` notifications: `model.streaming`
(text/reasoning/tool-input deltas), `tool.updated`, `turn.completed` — done on
`state.updated` (reason `prompt_completed`). Model switching uses
`session/setModel`.

The ZCode app-server evicts idle sessions from memory (resident pool: 10 min
idle timeout, LRU beyond 16 sessions) and would otherwise reject stale session
ids with "Session is not active"; the bridge resumes the persisted session
before every turn, so multi-turn continuity survives idle gaps.

**Session continuity across pi restarts.** The bridge remembers the ZCode
session id per pi session (a small sidecar file
`~/.zcode/cli/zcode-provider-sessions.json`, keyed by pi session UUID). When
you exit pi and restore the same conversation with `pi --session <id>` (or
`/resume`), the bridge calls `session/resume` on the remembered ZCode session
instead of `session/create`, so the ZCode agent keeps its full session history
(session memory, accumulated context, tool state). A fresh pi session in the
same project, or a restore from a different working directory, still gets a
new ZCode session as before.

## Updates while a turn is running

Messages typed in pi while the ZCode agent is mid-task are delivered using
**ZCode's own two delivery modes** (its `followupMode` setting):

- `queue`: pi queues the message and runs it as a new ZCode turn once the
  current one completes — nothing is injected mid-run. This is ZCode's `queue`
  followupMode and pi's standard model-provider flow.
- `guide`: the bridge enables ZCode's `guide` followupMode on the session
  (v4 conversation subscription + CAS `setFollowupMode`) and hooks pi's
  `input` event. A message typed while the turn is running is sent to the
  running session via the v4 `sendText` command; ZCode injects it at the next
  tool/message boundary **inside the same turn** (`turn.steerQueued` →
  `turn.steerDrained`), falling back to a queue when the turn is not steerable
  or already has queued input. pi marks the message as handled, so it is not
  duplicated into the next turn. The steered run's reply streams into pi as
  usual.

Which mode applies is decided by `ZCODE_STEER_MODE`: an explicit
`ZCODE_STEER_MODE=guide` / `=queue` wins, otherwise the bridge follows ZCode's
own UI setting (`zcodeInteractionBehavior` in `~/.zcode/v2/setting.json`). If
your ZCode desktop app is set to guide-mode interaction (its default is
`queue`), pi steers too — no extra env var needed.

## Asking you questions (ZCode's `askUserQuestion`)

When the ZCode agent calls its `askUserQuestion` tool, the app-server asks the
bridge for user input (`interaction/requestUserInput`). The bridge shows the
question as a pi dialog — options with descriptions, `Space` toggles for
multi-select, plus a free-text "Type something." entry — and answers the
request with your choice. The ZCode agent then continues **in the same
session** with your answer (the tool returns "User has answered your
questions: ...").

- The dialog appears mid-turn; the stream stays open until you answer or press
  `Esc` to cancel (cancelling answers the request with `cancel`).
- Up to 4 questions per interaction are asked one after another.
- The server auto-resolves unanswered interactions after 5 minutes
  (`askUserQuestionAutoResolutionEnabled`), so a dialog left open will not hang
  the turn forever.
- The tool call is still rendered in the transcript
  (`🔧 askUserQuestion` with the question text) followed by the answer.

## Known limitations

- A turn that exceeds `ZCODE_TURN_TIMEOUT_MS` (default 30 min) is
  checkpointed: the bridge interrupts it (`session/stop`) and sends the session
  `go on`, so the ZCode agent continues the task with its full session history.
  The pi stream stays open until the task completes. Stopping the turn in pi
  aborts the server-side turn too, and cancels any background tasks
  (`run_in_background` bash etc.) the agent started in the session — ZCode's
  own stop leaves those running, so the bridge stops them explicitly
  (`session/cancelBackgroundTask` per running task).
- **Upstream model/API failures are surfaced with the real reason.** When the
  ZCode turn fails (model API timeout, auth error, ...), the app-server's
  `turn.failed` event carries the structured error; the bridge forwards its
  message (plus the HTTP status code when the app-server reports one, e.g.
  `zcode turn failed: Origin Time-out (HTTP 524)`) to pi instead of a generic
  "turn ended with failure". Cancelling a turn (`session/stop`) is reported as
  a cancellation, never as a failure.
- The app-server streams reasoning, tool calls and text live (`model.streaming`
  and `tool.updated` events after `session/subscribe`); deltas arrive chunked,
  and the final text is also reconciled from the messages store when no live
  deltas were seen (e.g. subscription failed).
- Tool calls are **display-only, rendered inline in stream order**. ZCode runs
  them inside its own session; the bridge never emits pi `toolCall` blocks
  (pi's harness would try to execute them itself, and pi's TUI renders every
  `toolCall` block as a box appended *below* the assistant message — splitting
  the transcript into a text part on top and a tool part below). Instead each
  tool call (`model.streaming` `tool_input_*`) and its result (`tool.updated`
  `kind=result`) are rendered as formatted markdown text blocks appended in
  the exact order the app-server reports them, so reasoning, tools, results
  and the final answer interleave in the transcript like ZCode's own output:
  thinking block → text block → tool call → tool result → next thinking
  block → … Each tool call renders as `**🔧 Name** — summary` (one-line
  command/path summary for the common tools, fenced JSON for complex args,
  the question text for `askUserQuestion`); each result renders as a fenced
  text block capped at 6k chars with truncation and failure markers.
- **Results mirror pi's own tool display, not the full tool output** — the
  full result stays inside the ZCode session (the agent's model already
  consumed it), so the transcript only shows a readable preview:
  - `read`-like tools (`read`/`read_file`/`view_file`): the call line shows
    the requested range like pi's collapsed read box — `🔧 read —
    /path:80-220` — and the result collapses to nothing (failures still show
    the error text).
  - `bash`: command + output are merged into one fenced block in pi's style —
    `$ cmd`, then `... (N earlier lines)` with the **last 10 lines** of the
    output (tail preview, like pi's bash display), closed with a `Took 0.0s`
    duration line measured by the bridge between the call and its result.
  - everything else: fenced text capped at 6k chars of the head, with
    truncation and failure markers.
  A turn that ends with a bash call whose result never arrived
  (aborted/timeout) closes the fence so every block stays well-formed.
- **MCP / skill / plugin tools are handled too**. ZCode namespaces MCP tools as
  `mcp__<server>__<tool>` (e.g. `mcp__codegraph__codegraph_explore`); the
  bridge maps that to a clean display name `<server>__<tool>` for the inline
  heading, and any tool name is rendered through the same generic formatter.
  ZCode's own environment — its MCP servers, skills and tools — always runs
  the real call; pi only mirrors the name, arguments and result text.
- pi's RPC/print mode has a model-resolver crash in some pi 0.84.2 builds that
  also affects built-in providers; interactive `/model` is unaffected.
- The resident-pool eviction cannot be configured from outside the app-server;
  idle recovery relies on `session/resume` (one extra round-trip only after the
  session was evicted).

## License

MIT
