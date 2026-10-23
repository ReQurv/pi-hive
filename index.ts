import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const PROVIDER_ID = "requrv-hive";
const PROVIDER_NAME = "ReQurv Hive";
// `openai-completions` è il wire che pi/omp parlano con Hive: chat completions,
// tool call in streaming, `reasoning_effort`. Cambia solo la base URL.
const API = "openai-completions";
const BASE_URL = process.env.HIVE_OPENAI_BASE_URL ?? "https://hive.requrv.ai/api/v1";
const MODELS_TIMEOUT_MS = 15_000;
const IMAGE_TIMEOUT_MS = 180_000;
const DEFAULT_IMAGE_SIZE = "1024x1024";
// Id confermato dal gateway (`POST /images/generations`, risposta `data[0].b64_json`).
const IMAGE_MODEL = "requrv-image";
const TEN_YEARS_MS = 10 * 365 * 24 * 3600 * 1000;
// `/models` non dichiara le modalità: solo questo modello è noto multimodale.
const MULTIMODAL_MODEL_ID = "requrv-small-3.8";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

interface HiveChatModel {
  type: "chat";
  id: string;
  name: string;
  api: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  /** pi: livello utente → valore wire (`null` = non supportato). */
  thinkingLevelMap?: Record<string, string | null>;
  /** omp: lista ordinata degli effort effettivamente accettati. */
  thinking?: { mode: "effort"; efforts: string[] };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Mappa il payload di `GET /models` nella lista chat model di pi/omp. */
export function mapHiveModels(payload: unknown): HiveChatModel[] {
  if (!isRecord(payload) || !Array.isArray(payload.data)) return [];

  const models: HiveChatModel[] = [];
  for (const raw of payload.data) {
    if (!isRecord(raw) || typeof raw.id !== "string" || raw.id.length === 0) continue;
    const id = raw.id;

    // `type` assente ma con context window = gateway che omette il tipo: lo
    // trattiamo come modello testuale, come fa la UI del Bridge.
    const isText = raw.type === "TEXT_GENERATION" || (raw.type === undefined && typeof raw.context_window === "number");
    // Embedding e image generation non hanno superficie chat.
    if (!isText) continue;

    const efforts = Array.isArray(raw.reasoning_efforts)
      ? raw.reasoning_efforts.filter(
        (effort): effort is string =>
          typeof effort === "string" && (THINKING_LEVELS as readonly string[]).includes(effort),
      )
      : [];
    const reasoning = efforts.length > 0;

    const model: HiveChatModel = {
      type: "chat",
      id,
      name: id,
      api: API,
      reasoning,
      input: id === MULTIMODAL_MODEL_ID ? ["text", "image"] : ["text"],
      cost: {
        input: numberOr(raw.input_cost, 0),
        output: numberOr(raw.output_cost, 0),
        cacheRead: 0,
        cacheWrite: 0,
      },
      contextWindow: numberOr(raw.context_window, 128_000),
      maxTokens: numberOr(raw.max_output_tokens, 16_384),
    };

    if (reasoning) {
      const levels: Record<string, string | null> = {};
      for (const level of THINKING_LEVELS) levels[level] = efforts.includes(level) ? level : null;
      model.thinkingLevelMap = levels;
      model.thinking = { mode: "effort", efforts };
    }

    models.push(model);
  }
  return models;
}

/** Lista live dal gateway; errore leggibile se la chiave o l'endpoint non rispondono. */
async function fetchHiveModels(key: string, signal?: AbortSignal): Promise<HiveChatModel[]> {
  const timeout = AbortSignal.timeout(MODELS_TIMEOUT_MS);
  const res = await fetch(`${BASE_URL}/models`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (res.status === 401 || res.status === 403) throw new Error("Chiave ReQurv Hive non valida (401/403)");
  if (!res.ok) throw new Error(`AI Hive ha risposto con stato ${res.status}`);
  return mapHiveModels(await res.json());
}

/** Chiave da una credenziale OAuth (`access`) o api-key (`key`). */
function credentialKey(credential: unknown): string | undefined {
  if (!isRecord(credential)) return undefined;
  if (credential.type === "api_key") return typeof credential.key === "string" ? credential.key : undefined;
  return typeof credential.access === "string" ? credential.access : undefined;
}

// Bootstrap offline di pi (print mode / rete off): i valori verificati sul
// gateway. Non è una cache — appena la rete è disponibile vince `/models`.
const SEED: HiveChatModel[] = [
  {
    type: "chat",
    id: MULTIMODAL_MODEL_ID,
    name: MULTIMODAL_MODEL_ID,
    api: API,
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0.45, output: 2.5, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 262_144,
    maxTokens: 32_768,
    thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: null, xhigh: "xhigh", max: null },
    thinking: { mode: "effort", efforts: ["low", "medium", "xhigh"] },
  },
];

export default function (pi: ExtensionAPI): void {
  // omp espone `arktype` sull'API, pi no: è l'unico branch di piattaforma.
  const isOmp = typeof (pi as unknown as { arktype?: unknown }).arktype === "object";

  const providerConfig = {
    name: PROVIDER_NAME,
    baseUrl: BASE_URL,
    api: API,
    // pi: chiamato allo startup (senza rete) e dalla TUI (con rete); il
    // risultato sostituisce la lista, quindi non restituiamo mai `[]`.
    refreshModels: async (context: unknown): Promise<HiveChatModel[]> => {
      if (!isRecord(context)) return SEED;
      const key = credentialKey(context.credential);
      if (!key || context.allowNetwork !== true) return SEED;
      try {
        return await fetchHiveModels(key, context.signal instanceof AbortSignal ? context.signal : undefined);
      } catch {
        return SEED;
      }
    },
    // omp: discovery con cache SQLite. Il ramo statico lo ignora, per questo
    // `models` non viene registrato su omp.
    fetchDynamicModels: async (apiKey: string | undefined): Promise<HiveChatModel[]> =>
      apiKey ? fetchHiveModels(apiKey) : [],
    // Unico blocco di auth per entrambi: su omp `registerProvider({oauth})`
    // registra anche il provider di /login.
    oauth: {
      name: PROVIDER_NAME,
      async login(callbacks: unknown) {
        if (!isRecord(callbacks) || typeof callbacks.onPrompt !== "function") {
          throw new Error("Login ReQurv Hive non supportato da questo host");
        }
        const answer: unknown = await (callbacks.onPrompt as (prompt: unknown) => Promise<unknown>)({
          message: "Chiave API ReQurv Hive",
          placeholder: "requrv_sk_...",
        });
        const key = typeof answer === "string" ? answer.trim() : "";
        if (!key) throw new Error("Chiave API ReQurv Hive mancante");
        await fetchHiveModels(key); // valida subito la chiave
        return { refresh: key, access: key, expires: Date.now() + TEN_YEARS_MS };
      },
      async refreshToken(credentials: unknown) {
        return credentials; // chiave statica: nessun refresh
      },
      getApiKey(credentials: unknown) {
        return isRecord(credentials) && typeof credentials.access === "string" ? credentials.access : "";
      },
    },
    ...(isOmp ? {} : { models: SEED }),
  };

  // Un solo oggetto deve soddisfare sia il `ProviderConfig` di pi sia quello di
  // omp (campi disgiunti: `thinking`/`thinkingLevelMap`, `refreshModels`/`fetchDynamicModels`).
  pi.registerProvider(PROVIDER_ID, providerConfig as never);

  pi.registerTool({
    name: "hive_generate_image",
    label: "ReQurv Hive Image",
    description: "Genera un'immagine con AI Hive e la salva nella directory di lavoro corrente.",
    parameters: Type.Object({
      prompt: Type.String({ description: "Descrizione dell'immagine" }),
      size: Type.Optional(Type.String({ description: `WIDTHxHEIGHT, default ${DEFAULT_IMAGE_SIZE}` })),
    }),
    async execute(_toolCallId: string, params: { prompt: string; size?: string }, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: unknown) {
      const key = isRecord(ctx) && isRecord(ctx.modelRegistry) && typeof ctx.modelRegistry.getApiKeyForProvider === "function"
        ? await (ctx.modelRegistry.getApiKeyForProvider as (id: string) => Promise<string | undefined>)(PROVIDER_ID)
        : undefined;
      if (!key) throw new Error("Nessuna credenziale ReQurv Hive: esegui /login e scegli ReQurv Hive.");
      const cwd = isRecord(ctx) && typeof ctx.cwd === "string" ? ctx.cwd : process.cwd();

      const timeout = AbortSignal.timeout(IMAGE_TIMEOUT_MS);
      const res = await fetch(`${BASE_URL}/images/generations`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: IMAGE_MODEL,
          prompt: params.prompt,
          size: params.size ?? DEFAULT_IMAGE_SIZE,
          n: 1,
        }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (!res.ok) throw new Error(`AI Hive images: stato ${res.status}`);

      const body: unknown = await res.json();
      const first = isRecord(body) && Array.isArray(body.data) ? body.data[0] : undefined;
      const b64 = isRecord(first) && typeof first.b64_json === "string" ? first.b64_json : undefined;
      if (!b64) throw new Error("Risposta AI Hive senza immagine");

      // Il b64 non entra nel contesto (può superare 16 MB): solo il percorso.
      const path = join(cwd, `hive-image-${Date.now()}.png`);
      await writeFile(path, Buffer.from(b64, "base64"));
      return {
        content: [{ type: "text" as const, text: `Immagine salvata in ${path}` }],
        details: { path, model: IMAGE_MODEL },
      };
    },
    // Stessa ragione del cast su `registerProvider`: shape condivisa pi/omp.
  } as never);
}
