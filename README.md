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
pi install git:github.com/ZhouXiaolin/zcode-provider
# or pin a release:
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
2. **Publishes the catalog to pi** via `refreshModels`, so opening `/model`
   always shows the current providers/models without a reload.
3. **Switches the ZCode session model** with `session/setModel` when you pick a
   different pi model. The choice also persists back to ZCode's config
   (`model.main`), so the model you last used in pi is ZCode's default.

Provider edits are additive and every write to the settings file is backed up
first (`config.json.bak-<timestamp>`).

## Configuration

Environment variables (set before starting pi):

| Variable | Default | Meaning |
| --- | --- | --- |
| `ZCODE_SERVE_CMD` | `node /opt/ZCode/resources/glm/zcode.cjs app-server` | Command that starts the ZCode stdio app server |
| `ZCODE_SETTINGS` | `~/.zcode/cli/config.json` | Settings file the app-server reads models from |
| `ZCODE_V2_CONFIG` | `~/.zcode/v2/config.json` | ZCode UI config whose enabled providers are merged in |
| `ZCODE_AUTO_ALLOW` | `1` (enabled) | Auto-answer ZCode permission prompts. Set to `0` to deny tool permission requests |

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

`session/create` → answer `session/requestRuntimePreferences` → `session/send` →
wait for `state.updated` (reason `prompt_completed`) → `session/messages` →
assistant text parts. Model switching uses `session/setModel`.

## Known limitations

- Replies arrive as one chunk after the ZCode turn completes (tools included);
  no token-level streaming on the wire.
- pi's RPC/print mode has a model-resolver crash in some pi 0.84.2 builds that
  also affects built-in providers; interactive `/model` is unaffected.

## License

MIT
