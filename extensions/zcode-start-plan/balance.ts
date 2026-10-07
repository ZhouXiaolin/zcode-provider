export interface StartPlanGrant {
  modelIds: string[];
  expiresAtMs: number;
}

interface Plan {
  plan_id?: string;
  user_plan_id?: string;
  status?: string;
  starts_at?: number;
  ends_at?: number;
}
interface Balance {
  plan_id?: string;
  user_plan_id?: string;
  show_name?: string;
  capabilities?: string[];
  available_units?: number;
  remaining_units?: number;
  expires_at?: number;
  period_start?: number;
  period_end?: number;
}

export function parseStartPlanGrant(envelope: unknown, nowMs: number): StartPlanGrant {
  const response = envelope as {
    code?: number; success?: boolean;
    data?: { server_time?: number; plans?: Plan[]; balances?: Balance[] };
  } | null;
  if (!response || response.code !== 0 || response.success === false ||
      !Array.isArray(response.data?.plans) || !Array.isArray(response.data?.balances)) {
    throw new Error("ZCode Start Plan balance is unavailable. Open Desktop and check your account.");
  }
  const serverSeconds = response.data.server_time;
  const nowSeconds = typeof serverSeconds === "number" && Number.isFinite(serverSeconds)
    ? serverSeconds : nowMs / 1000;
  const activePlans = response.data.plans.filter((plan) =>
    plan && typeof plan.status === "string" && plan.status.toLowerCase() === "active" &&
    !(timestamp(plan.starts_at) > nowSeconds) &&
    !(timestamp(plan.ends_at) > 0 && timestamp(plan.ends_at) <= nowSeconds));
  const models = new Set<string>();
  let validForSeconds = Infinity;
  for (const balance of response.data.balances) {
    if (!balance) continue;
    const plan = activePlans.find((candidate) =>
      balance.user_plan_id && candidate.user_plan_id
        ? balance.user_plan_id === candidate.user_plan_id
        : !!balance.plan_id && balance.plan_id === candidate.plan_id);
    const units = balance.available_units ?? balance.remaining_units;
    if (!plan || typeof units !== "number" || !Number.isFinite(units) || units <= 0 ||
        timestamp(balance.period_start) > nowSeconds) continue;
    const expiry = [plan.ends_at, balance.expires_at, balance.period_end]
      .map(timestamp).filter((value) => value > 0);
    if (expiry.some((value) => value <= nowSeconds)) continue;
    const capabilities = Array.isArray(balance.capabilities) ? balance.capabilities : [];
    const modelIds = capabilities.filter((value) => typeof value === "string" && /^model:/i.test(value))
      .map((value) => value.slice(6).trim());
    if (!modelIds.length && typeof balance.show_name === "string") modelIds.push(balance.show_name.trim());
    for (const modelId of modelIds) if (modelId) models.add(modelId.toLowerCase());
    validForSeconds = Math.min(validForSeconds, ...expiry.map((value) => value - nowSeconds));
  }
  if (!models.size) throw new Error("ZCode Start Plan has no active model quota (expired, pending or exhausted). No fallback to Coding Plan was made.");
  // Revalidate on every turn; cap runtime authorization if the server omits expiry.
  return { modelIds: [...models], expiresAtMs: nowMs + Math.min(validForSeconds, 300) * 1000 };
}

function timestamp(value: unknown): number {
  if (value === undefined || value === null || value === "") return 0;
  const seconds = typeof value === "string" || typeof value === "number" ? Number(value) : NaN;
  if (!Number.isFinite(seconds) || seconds < 0) throw new Error("Invalid ZCode Start Plan expiry response.");
  return seconds;
}
