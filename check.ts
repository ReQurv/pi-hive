import assert from "node:assert/strict";
import { mapHiveModels } from "./index.ts";

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

console.log("check: ok");
