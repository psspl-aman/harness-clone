/** USD per 1M tokens. */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/**
 * Built-in list prices (USD per 1M tokens) used to *estimate* cost when a CLI
 * doesn't report one and the user has no matching entry under Settings →
 * Pricing. Rough public list prices; the first matching pattern wins, so more
 * specific families come first.
 */
export const BUILTIN_MODEL_PRICES: { match: RegExp; label: string; price: ModelPrice }[] = [
  // Anthropic Claude
  {
    match: /claude-3-opus|opus-4-(0|1)\b|opus-4-2025/,
    label: 'Claude Opus (4.1 and older)',
    price: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  },
  {
    match: /opus/,
    label: 'Claude Opus',
    price: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  },
  {
    match: /sonnet/,
    label: 'Claude Sonnet',
    price: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  },
  {
    match: /claude-3(-5)?-haiku/,
    label: 'Claude Haiku 3.x',
    price: { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
  },
  {
    match: /haiku/,
    label: 'Claude Haiku',
    price: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  },
  // OpenAI
  {
    match: /gpt-5[\w.-]*-nano/,
    label: 'GPT-5 nano',
    price: { input: 0.05, output: 0.4, cacheRead: 0.005 },
  },
  {
    match: /gpt-5[\w.-]*-mini/,
    label: 'GPT-5 mini',
    price: { input: 0.25, output: 2, cacheRead: 0.025 },
  },
  {
    match: /o4-mini|o3-mini/,
    label: 'o4-mini',
    price: { input: 1.1, output: 4.4, cacheRead: 0.275 },
  },
  { match: /^o3\b/, label: 'o3', price: { input: 2, output: 8, cacheRead: 0.5 } },
  { match: /gpt-4\.1/, label: 'GPT-4.1', price: { input: 2, output: 8, cacheRead: 0.5 } },
  { match: /gpt-4o/, label: 'GPT-4o', price: { input: 2.5, output: 10, cacheRead: 1.25 } },
  // gpt-5, gpt-5-codex, gpt-5.x and newer gpt-N models priced like GPT-5.
  {
    match: /gpt-\d|codex/,
    label: 'GPT-5 / Codex',
    price: { input: 1.25, output: 10, cacheRead: 0.125 },
  },
  // Google Gemini
  {
    match: /gemini-[\d.]+-flash-lite/,
    label: 'Gemini Flash-Lite',
    price: { input: 0.1, output: 0.4, cacheRead: 0.025 },
  },
  {
    match: /gemini-[\d.]+-flash/,
    label: 'Gemini Flash',
    price: { input: 0.3, output: 2.5, cacheRead: 0.075 },
  },
  { match: /gemini/, label: 'Gemini Pro', price: { input: 1.25, output: 10, cacheRead: 0.31 } },
];

/** What an engine's default model most likely costs, when the run names no model. */
const ENGINE_DEFAULT_MODEL: Record<string, string> = {
  'claude-code': 'sonnet',
  codex: 'gpt-5-codex',
  'gemini-cli': 'gemini-2.5-pro',
};

/** Built-in price for a model id (matched by family), else for the engine's default model. */
export function builtinPrice(
  model: string | null | undefined,
  engineId?: string,
): ModelPrice | null {
  const find = (id: string) =>
    BUILTIN_MODEL_PRICES.find((p) => p.match.test(id.toLowerCase()))?.price ?? null;
  return (
    (model ? find(model) : null) ??
    (engineId && ENGINE_DEFAULT_MODEL[engineId] ? find(ENGINE_DEFAULT_MODEL[engineId]!) : null)
  );
}
