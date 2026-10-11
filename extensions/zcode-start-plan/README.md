# Start Plan account access

## Business requirements

Expose Start Plan as an explicit model choice, separate from Coding Plan and
API-key providers. Never retry a failed Start Plan request against another plan.
Only the currently signed-in Desktop account is eligible. The model catalog is
local and does not claim that every bundled model belongs to the current package;
per-turn balance validation checks the selected model before sending a prompt.

## Technical notes

Verified against ZCode Desktop **3.14.4**, bundled CLI **0.16.9**, on macOS.
The implementation uses the installed built-in provider catalog, not a hardcoded
model list. Existing legacy providers retain their original configuration path.

The account adapter owns three boundaries:

- Shared login: read the Desktop credential store (plain or `enc:v1:` AES-256-GCM)
  with the same local secret as ZCode. Never write credentials or decrypt unrelated
  keys. The store, telemetry device identity and personal model preferences are
  located beside `ZCODE_V2_CONFIG`.
- Entitlements: authenticated `billing/balance`, with Desktop version and device
  headers, a 15-second deadline and redirects forbidden. Only active, effective,
  non-expired, non-exhausted buckets associated with an active plan supply model
  access. The account overlay contains model IDs, not tokens.
- Runtime: `provider/updateAccountConfig` before session creation/resume/model
  selection; then answer `interaction/requestProviderRuntimeHeaders` with the
  current shared JWT. Preserve the native `account:<family>-start-plan` identity
  so ZCode uses its account-specific request path, not API-key request signing.

The built-in revision identity follows this ZCode protocol version's
`zcode-builtin:<revision>:<sha256(absolute catalog path)>` contract. Revalidate it
when upgrading ZCode; it is a private protocol, not a supported public API.

Runtime authorization is restricted to the selected account, granted model and
active bridge session. Login changes invalidate prepared access. It is checked
again on every turn, and during long turns after the earliest grant expiry or
five minutes. Cancellation/finish clears authorization. No JWT is added to CLI
settings, the personal provider repository, protocol debug requests or Pi auth.
The local app-server still receives credentials in memory, as it does in Desktop.

Desktop owns sign-in, token renewal and CAPTCHA. CAPTCHA retries fail with an
instruction to complete verification in Desktop; this extension does not solve
or bypass it. Network/account/entitlement failures do not fall back to a cached
positive grant or to Coding Plan. Linux electron-updater installs (deb at
`/opt/ZCode`) are auto-detected like macOS: the catalog is read from
`resources/config/provider/zcode-builtin.json` and the Desktop version from
`app.asar`'s package.json (override with `ZCODE_APP_VERSION`). Live-tested with
Desktop 3.14.5 on Linux. BigModel discovery and account separation have
deterministic tests; the live smoke was performed with Z.ai.

See the root [testing instructions](../../README.md#testing) for the offline
regressions and the opt-in live smoke test.
