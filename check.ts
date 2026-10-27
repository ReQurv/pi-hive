import assert from "node:assert/strict";
import register, { mapHiveModels } from "./index.ts";

const LIVE = {
  data: [
    { id: "requrv-embed", type: "EMBEDDING", input_cost: 0, output_cost: 0.01 },
    { id: "requrv-image", type: "IMAGE_GENERATION", input_cost: 0, output_cost: 0.03 },
    {
      id: "requrv-small-3.8",
      type: "TEXT_GENERATION",
      description: "LLM Multimodale, agent ready e reasoning",
      input_cost: 0.45,
      output_cost: 2.5,
      context_window: 262144,
      max_output_tokens: 32768,
      reasoning_efforts: ["low", "medium", "xhigh"],
    },
  ],
};

// Payload reale del gateway: una sola entry chat, con gli effort del contratto.
const [live] = mapHiveModels(LIVE);
assert.equal(mapHiveModels(LIVE).length, 1);
assert.equal(live.id, "requrv-small-3.8");
assert.equal(live.contextWindow, 262144);
assert.equal(live.maxTokens, 32768);
assert.equal(live.reasoning, true);
assert.deepEqual(live.cost, { input: 0.45, output: 2.5, cacheRead: 0, cacheWrite: 0 });
assert.deepEqual(live.input, ["text", "image"]);
assert.equal(live.thinkingLevelMap.high, null);
assert.equal(live.thinkingLevelMap.xhigh, "xhigh");
assert.equal(live.thinkingLevelMap.off, null);
assert.deepEqual(live.thinking, { mode: "effort", efforts: ["low", "medium", "xhigh"] });

// Payload degeneri: nessun modello, mai un crash.
assert.deepEqual(mapHiveModels({}), []);
assert.deepEqual(mapHiveModels(null), []);
assert.deepEqual(mapHiveModels({ data: [{ id: 1 }] }), []);
assert.deepEqual(mapHiveModels({ data: [{ id: "x", type: "EMBEDDING" }] }), []);

// Fallback: `type` assente ma context window presente = modello testuale.
const [fallback] = mapHiveModels({ data: [{ id: "m", context_window: 1000 }] });
assert.equal(fallback.contextWindow, 1000);
assert.equal(fallback.maxTokens, 16384);
assert.equal(fallback.reasoning, false);
assert.equal("thinking" in fallback, false);
assert.equal("thinkingLevelMap" in fallback, false);

// Effort sconosciuti droppati; modello senza effort validi = non reasoning.
const [unknownEffort] = mapHiveModels({ data: [{ id: "m", type: "TEXT_GENERATION", reasoning_efforts: ["ultra"] }] });
assert.equal(unknownEffort.reasoning, false);
assert.equal("thinking" in unknownEffort, false);

// Registrazione: pi espone entrambi i metodi; entrambi gli host hanno un prompt manuale.
const registered: Record<string, Record<string, unknown>> = {};
const host = (arktype: boolean) => {
  const api = {
    registerProvider: (id: string, config: Record<string, unknown>) => {
      registered[arktype ? "omp" : "pi"] = config;
    },
    registerTool: () => {},
    ...(arktype ? { arktype: {} } : {}),
  };
  return api as never;
};

register(host(false));
register(host(true));

assert.equal(registered.pi.apiKey, "$HIVE_API_KEY");
assert.equal("oauth" in registered.pi, true);
assert.equal((registered.pi.models as unknown[]).length, 1);

assert.equal("oauth" in registered.omp, true);
assert.equal("apiKey" in registered.omp, false);
assert.equal("models" in registered.omp, false);

const loginAdapters = ["pi", "omp"].map((host) => ({
  host,
  adapter: registered[host].oauth as {
  login(callbacks: { onPrompt(prompt: { message: string; type?: string }): Promise<string>; onDeviceCode(): never }): Promise<{ access: string; refresh: string; expires: number }>;
  refreshToken(credentials: { access: string }): Promise<{ access: string }>;
  getApiKey(credentials: { access: string }): string;
  },
}));
const originalFetch = globalThis.fetch;
try {
  for (const { host, adapter } of loginAdapters) {
    const enteredKey = `requrv_sk_manual_${host}`;
    let fetchCalls = 0;
    const installFetch = (expectedKey: string, status = 200) => {
      globalThis.fetch = async (input, init) => {
        fetchCalls++;
        assert.equal(String(input), "https://hive.requrv.ai/api/v1/models", `${host} must not call a device endpoint`);
        assert.equal(init?.method ?? "GET", "GET");
        assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${expectedKey}`);
        return status === 200
          ? new Response(JSON.stringify({ data: [] }), { status })
          : new Response("unauthorized", { status });
      };
    };

    installFetch(enteredKey);
    const saved = await adapter.login({
      onPrompt: async ({ message, type }) => {
        assert.match(message, /chiave API/i);
        assert.equal(type, host === "pi" ? "secret" : undefined, `${host} prompt input type`);
        return enteredKey;
      },
      onDeviceCode: () => { throw new Error(`${host} device flow must not run`); },
    });
    assert.equal(fetchCalls, 1, `${host} validates the entered key`);

    const beforeEmpty = fetchCalls;
    await assert.rejects(
      adapter.login({ onPrompt: async () => "  \n", onDeviceCode: () => { throw new Error("device flow must not run"); } }),
      /chiave API ReQurv Hive non può essere vuota/,
    );
    assert.equal(fetchCalls, beforeEmpty, `${host} empty key must not trigger a request`);

    const replacementKey = `requrv_sk_replacement_${host}`;
    installFetch(replacementKey);
    const replaced = await adapter.login({ onPrompt: async () => ` ${replacementKey} `, onDeviceCode: () => { throw new Error("device flow must not run"); } });
    assert.equal(replaced.access, replacementKey, `${host} replaces the key`);
    assert.equal(fetchCalls, 2);

    installFetch("bad-key", 401);
    await assert.rejects(
      adapter.login({ onPrompt: async () => "bad-key", onDeviceCode: () => { throw new Error("device flow must not run"); } }),
      /Chiave ReQurv Hive non valida/,
    );
    assert.equal(saved.access, enteredKey);
    assert.equal(adapter.getApiKey(saved), enteredKey);
    const beforeRefresh = fetchCalls;
    assert.equal((await adapter.refreshToken(saved)).access, enteredKey);
    assert.equal(fetchCalls, beforeRefresh, `${host} static-key refresh must not make a request`);
    await assert.rejects(
      adapter.login({
        onPrompt: async () => { throw new Error("cancelled"); },
        onDeviceCode: () => { throw new Error("device flow must not run"); },
      }),
      /cancelled/,
    );
  }
} finally {
  globalThis.fetch = originalFetch;
}

console.log("check: ok");
