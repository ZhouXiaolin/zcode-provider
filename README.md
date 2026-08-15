# zcode-provider

Turn the **ZCode** agent (`zcodex app-server`, an OpenCode-derived CLI agent) into a
pi model provider. pi is the chat frontend; the ZCode agent keeps its own
session, runs its own tools (bash, edits, plugins, ...), and its text reply is
streamed back into pi.

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
(no-op while resident, rehydrates after idle eviction) → `session/send` → wait for
`state.updated` (reason `prompt_completed`) → `session/messages` → assistant text
parts. Model switching uses `session/setModel`.

The ZCode app-server evicts idle sessions from memory (resident pool: 10 min
idle timeout, LRU beyond 16 sessions) and would otherwise reject stale session
ids with "Session is not active"; the bridge resumes the persisted session
before every turn, so multi-turn continuity survives idle gaps.

## Known limitations

- A turn that exceeds `ZCODE_TURN_TIMEOUT_MS` (default 30 min) is
  checkpointed: the bridge interrupts it (`session/stop`) and sends the session
  `go on`, so the ZCode agent continues the task with its full session history.
  The pi stream stays open until the task completes. Stopping the turn in pi
  aborts the server-side turn too.
- Replies arrive as one chunk after the ZCode turn completes (tools included);
  no token-level streaming on the wire.
- pi's RPC/print mode has a model-resolver crash in some pi 0.84.2 builds that
  also affects built-in providers; interactive `/model` is unaffected.
- The resident-pool eviction cannot be configured from outside the app-server;
  idle recovery relies on `session/resume` (one extra round-trip only after the
  session was evicted).

## License

MIT
