import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { arch, platform, version } from "node:os";
import { join, resolve } from "node:path";
import { readStartPlanLogin } from "./credentials";
import { parseStartPlanGrant } from "./balance";

const BALANCE_URL = "https://zcode.z.ai/api/v1/zcode-plan/billing/balance";

export interface StartPlanModel {
  id: string;
  providerId: string;
  modelId: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoningVariants?: string[];
}
interface Bundle {
  revision: number;
  config: {
    providerConfigRules: { providerRules: Array<{
      providerId: string;
      config: { builtinModelIds?: string[]; access?: { type?: string; mode?: string; accountType?: string } };
    }> };
    modelConfigRules?: { modelRules?: Array<{ modelMatch: string; config: {
      properties?: { contextWindow?: number };
      optionSpecs?: { maxOutputTokens?: { max?: number }; reasoningLevel?: { values?: string[] } };
    } }> };
  };
}
interface PreparedPlan {
  providerId: string;
  modelIds: string[];
  tokenHash: string;
  expiresAtMs: number;
}
export interface StartPlanOptions {
  directory: string;
  bundledPath: string;
  appVersion?: string;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  now?: () => number;
}

export class StartPlanClient {
  private prepared?: PreparedPlan;
  private generation = 0;
  private options: StartPlanOptions;

  constructor(options: StartPlanOptions) { this.options = options; }

  catalog(): StartPlanModel[] {
    const login = readStartPlanLogin(this.options.directory, this.options.env);
    if (!login) return [];
    const bundle = this.bundle();
    const providerId = `account:${login.family}-start-plan`;
    const provider = bundle.config.providerConfigRules.providerRules.find((rule) => rule.providerId === providerId);
    if (provider?.config.access?.type !== "zhipu-account" || provider.config.access.mode !== "start-plan" ||
        provider.config.access.accountType !== login.family) return [];
    const personal = this.personalRules();
    if (personal.providerRules.some((rule) => rule.providerId === providerId && rule.config?.enabled === false)) return [];
    return (provider.config.builtinModelIds ?? []).filter((modelId) =>
      !personal.modelRules.some((rule) => rule.providerId === providerId && rule.modelId === modelId && rule.config?.enabled === false)
    ).map((modelId) => {
      let contextWindow: number | undefined;
      let maxTokens: number | undefined;
      let reasoningVariants: string[] | undefined;
      for (const rule of bundle.config.modelConfigRules?.modelRules ?? []) {
        if (!new RegExp(rule.modelMatch, "i").test(modelId)) continue;
        contextWindow = rule.config.properties?.contextWindow ?? contextWindow;
        maxTokens = rule.config.optionSpecs?.maxOutputTokens?.max ?? maxTokens;
        reasoningVariants = rule.config.optionSpecs?.reasoningLevel?.values ?? reasoningVariants;
      }
      return {
        id: `${login.family === "zai" ? "Z.ai" : "BigModel"} - Start Plan/${modelId}`,
        providerId, modelId, contextWindow, maxTokens, reasoningVariants,
      };
    });
  }

  async prepare(providerId: string, modelId: string, signal?: AbortSignal) {
    const generation = ++this.generation;
    this.prepared = undefined;
    signal?.throwIfAborted();
    if (!this.catalog().some((model) => model.providerId === providerId && model.modelId === modelId)) {
      throw new Error("Start Plan model is disabled or its ZCode account is signed out. Reopen /model after signing in to Desktop.");
    }
    const login = readStartPlanLogin(this.options.directory, this.options.env);
    if (!login || `account:${login.family}-start-plan` !== providerId) {
      throw new Error("ZCode login changed before checking Start Plan. Retry the request.");
    }
    const appVersion = this.appVersion();
    const url = new URL(BALANCE_URL);
    url.searchParams.set("app_version", appVersion);
    const deadline = AbortSignal.timeout(15_000);
    const headers = { ...this.sourceHeaders(appVersion), Authorization: `Bearer ${login.token}` };
    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(url, {
        headers,
        signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
        redirect: "error",
      });
    } catch {
      signal?.throwIfAborted();
      throw new Error("Cannot check ZCode Start Plan balance (network error or timeout). No fallback was made.");
    }
    if (!response.ok) throw new Error(`ZCode Start Plan balance HTTP ${response.status}. Check your login and package in Desktop.`);
    let payload: unknown;
    try { payload = await response.json(); } catch { throw new Error("Invalid ZCode Start Plan balance response."); }
    signal?.throwIfAborted();
    const nowMs = (this.options.now ?? Date.now)();
    const grant = parseStartPlanGrant(payload, nowMs);
    const modelIds = this.catalog().filter((model) => model.providerId === providerId && grant.modelIds.includes(model.modelId.toLowerCase()))
      .map((model) => model.modelId);
    if (!modelIds.includes(modelId)) throw new Error(`Your Start Plan package does not include ${modelId}. Choose an included Start Plan model; Coding Plan was not used.`);
    const latestLogin = readStartPlanLogin(this.options.directory, this.options.env);
    if (latestLogin?.family !== login.family || latestLogin.token !== login.token) {
      throw new Error("ZCode login changed while checking Start Plan. Retry the request.");
    }
    if (generation !== this.generation) throw new Error("Start Plan authorization was cancelled or superseded.");
    const bundle = this.bundle();
    this.prepared = { providerId, modelIds, tokenHash: hash(login.token), expiresAtMs: grant.expiresAtMs };
    const providers = { [providerId]: { access: { type: "zhipu-account", entitled: true }, builtinModelIds: modelIds } };
    const states = { [providerId]: { availability: "available", entitled: true, current: true } };
    return {
      revision: `pi-start-plan:${hash(JSON.stringify([providers, states, grant.expiresAtMs]))}`,
      basedOnZCodeBuiltinRevision: `zcode-builtin:${bundle.revision}:${hash(resolve(this.options.bundledPath))}`,
      providers, states,
    };
  }

  async runtimeAuth(params: {
    providerId?: string; reason?: string;
    modelSelection?: { providerId?: string; modelId?: string };
    accountAccess?: { type?: string; mode?: string; accountType?: string };
  }, signal?: AbortSignal) {
    const prepared = this.prepared;
    const modelId = params.modelSelection?.modelId;
    if (!prepared || params.providerId !== prepared.providerId || params.modelSelection?.providerId !== prepared.providerId ||
        !modelId || !prepared.modelIds.includes(modelId) || params.accountAccess?.type !== "zhipu-account" ||
        params.accountAccess.mode !== "start-plan" || `account:${params.accountAccess.accountType}-start-plan` !== prepared.providerId) {
      throw new Error("Unexpected ZCode account authorization request. No credentials were supplied.");
    }
    if (params.reason === "captcha-retry") throw new Error("Start Plan requires CAPTCHA verification. Complete it in ZCode Desktop, then retry in Pi.");
    signal?.throwIfAborted();
    this.requirePreparedLogin(prepared);
    if ((this.options.now ?? Date.now)() >= prepared.expiresAtMs) {
      await this.prepare(prepared.providerId, modelId, signal);
    }
    signal?.throwIfAborted();
    const login = this.requirePreparedLogin(prepared);
    return { headersApplied: true, requestAuth: { apiKey: login.token, headers: this.sourceHeaders(this.appVersion()) } };
  }

  clear() {
    this.generation += 1;
    this.prepared = undefined;
  }

  private requirePreparedLogin(prepared: PreparedPlan) {
    const login = readStartPlanLogin(this.options.directory, this.options.env);
    if (!this.prepared || !login || `account:${login.family}-start-plan` !== prepared.providerId ||
        hash(login.token) !== prepared.tokenHash || this.prepared.tokenHash !== prepared.tokenHash) {
      throw new Error("ZCode login changed or expired. Sign in to Desktop and retry; no fallback was made.");
    }
    return login;
  }

  private bundle(): Bundle {
    try {
      const bundle = JSON.parse(readFileSync(this.options.bundledPath, "utf8"));
      if (!Number.isInteger(bundle.revision) || !Array.isArray(bundle.config?.providerConfigRules?.providerRules)) throw new Error();
      return bundle;
    } catch { throw new Error("Cannot read ZCode's modern provider catalog. Start Plan requires a supported ZCode Desktop installation."); }
  }

  private personalRules() {
    type Rule = { providerId?: string; modelId?: string; config?: { enabled?: boolean } };
    try {
      const personal = JSON.parse(readFileSync(join(this.options.directory, "provider_config.json"), "utf8"));
      return {
        providerRules: (personal.config?.providerConfigRules?.providerRules ?? []) as Rule[],
        modelRules: (personal.config?.modelConfigRules?.providerModelRules ?? []) as Rule[],
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { providerRules: [], modelRules: [] };
      throw new Error("Cannot read ZCode Desktop model preferences. Fix provider_config.json before using Start Plan.");
    }
  }

  private appVersion(): string {
    const configured = this.options.appVersion ?? this.options.env?.ZCODE_APP_VERSION;
    if (configured) return configured;
    try {
      const plist = readFileSync(resolve(this.options.bundledPath, "../../../../Info.plist"), "utf8");
      const version = plist.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
      if (version) return version;
    } catch { /* Non-macOS installations can supply ZCODE_APP_VERSION. */ }
    throw new Error("Set ZCODE_APP_VERSION to your installed Desktop version to use Start Plan.");
  }

  private sourceHeaders(appVersion: string): Record<string, string> {
    let deviceMid: unknown;
    try { deviceMid = JSON.parse(readFileSync(join(this.options.directory, "telemetry-state.json"), "utf8")).deviceMid; }
    catch { throw new Error("ZCode device identity is missing. Start Desktop once before using Start Plan."); }
    if (typeof deviceMid !== "string" || !/^[a-f0-9-]{36}$/i.test(deviceMid)) {
      throw new Error("ZCode device identity is invalid. Open Desktop before using Start Plan.");
    }
    const locale = Intl.DateTimeFormat().resolvedOptions();
    return {
      "HTTP-Referer": "https://zcode.z.ai", "User-Agent": `ZCode/${appVersion}`,
      "X-Title": "Z Code@pi", "X-ZCode-App-Version": appVersion,
      "X-Platform": `${platform()}-${arch()}`, "X-Device-Mid": deviceMid,
      "X-Client-Language": locale.locale, "X-Client-Timezone": locale.timeZone,
      "X-Os-Category": platform() === "darwin" ? "macos" : platform() === "win32" ? "windows" : "linux",
      "X-Os-Version": version(),
    };
  }
}

function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
