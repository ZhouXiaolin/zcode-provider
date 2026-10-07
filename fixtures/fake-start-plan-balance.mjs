// Test-only preloader: no test is allowed to contact a real model or billing API.
const fakeFetch = async (url, options) => {
  if (new URL(url).origin !== "https://zcode.z.ai" || options?.headers?.Authorization !== "Bearer fixture-jwt") {
    throw new Error("Unexpected test network request");
  }
  options.signal?.throwIfAborted();
  return Response.json({ code: 0, data: {
    plans: [{ plan_id: "fixture-trust", status: "active" }],
    balances: [{ plan_id: "fixture-trust", capabilities: ["model:glm-5.3-flash"], available_units: 100 }],
  } });
};
// Pi installs its own fetch wrapper at startup; keep this fixture offline.
Object.defineProperty(globalThis, "fetch", { get: () => fakeFetch, set: () => {}, configurable: true });
