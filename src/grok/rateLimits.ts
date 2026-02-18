import type { GrokSettings } from "../settings";
import { getDynamicHeaders } from "./headers";
import { toRateLimitModel } from "./models";

const RATE_LIMIT_API = "https://grok.com/rest/rate-limits";
const MAX_PARSE_DEPTH = 8;

const BASE_REMAINING_KEYS = [
  "remainingtokens",
  "remainingqueries",
  "remaining",
  "tokensremaining",
  "queriesremaining",
  "availabletokens",
  "availablequeries",
  "available",
  "balance",
  "left",
  "quota",
] as const;

const BASE_RESET_KEYS = [
  "resetat",
  "resetsat",
  "resettime",
  "resettimestamp",
  "nextresetat",
  "windowresetat",
  "windowendsat",
  "cooldownuntil",
  "retryafter",
  "retryafterseconds",
  "timeuntilreset",
  "secondsuntilreset",
] as const;

const MODEL_HINT_KEYS = new Set([
  "model",
  "modelname",
  "ratelimitmodel",
  "bucket",
  "bucketname",
  "kind",
  "name",
  "id",
]);

interface NumberCandidate {
  value: number;
  score: number;
}

interface ParseContext {
  strategy: RateLimitExtractStrategy;
  remainingPriority: Map<string, number>;
  resetPriority: Map<string, number>;
  remaining: NumberCandidate[];
  resetAt: NumberCandidate[];
  seen: Set<object>;
}

interface NormalizedModelHints {
  aliases: string[];
  tokens: string[];
}

export interface RateLimitExtractStrategy {
  modelName: string;
  aliases: string[];
  tokens: string[];
  remainingFieldPriority: string[];
  resetFieldPriority: string[];
}

export interface NormalizeRateLimitOptions {
  includeRaw?: boolean;
}

export interface NormalizedRateLimitResult {
  known: boolean;
  remaining: number | null;
  resetAt: number | null;
  raw?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeKey(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function buildModelHints(modelName: string): NormalizedModelHints {
  const aliasesRaw = [modelName, toRateLimitModel(modelName)]
    .map((v) => v.trim())
    .filter(Boolean);

  const aliasesSet = new Set<string>();
  for (const alias of aliasesRaw) aliasesSet.add(normalizeKey(alias));

  const tokenSet = new Set<string>();
  for (const alias of aliasesRaw) {
    const tokens = alias
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .map((v) => v.trim())
      .filter((v) => v.length >= 2 && /[a-z]/.test(v));
    for (const token of tokens) tokenSet.add(token);
  }

  return {
    aliases: [...aliasesSet].filter(Boolean),
    tokens: [...tokenSet],
  };
}

function uniqueOrder(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const key = normalizeKey(raw);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function buildPriorityMap(fields: string[]): Map<string, number> {
  const total = fields.length;
  const map = new Map<string, number>();
  fields.forEach((f, index) => {
    map.set(f, total - index);
  });
  return map;
}

function scoreByModelHints(key: string, strategy: RateLimitExtractStrategy): number {
  let score = 0;
  for (const alias of strategy.aliases) {
    if (key === alias) score += 120;
    else if (key.includes(alias) || alias.includes(key)) score += 70;
  }
  for (const token of strategy.tokens) {
    if (key === token) score += 45;
    else if (key.includes(token)) score += 25;
  }
  return score;
}

function scoreObjectModelHint(node: Record<string, unknown>, strategy: RateLimitExtractStrategy): number {
  let score = 0;
  for (const [rawKey, rawValue] of Object.entries(node)) {
    const key = normalizeKey(rawKey);
    if (!MODEL_HINT_KEYS.has(key) || typeof rawValue !== "string") continue;

    const value = normalizeKey(rawValue);
    if (!value) continue;
    score += scoreByModelHints(value, strategy) * 2;
  }
  return score;
}

function normalizeTimestamp(raw: unknown, keyHint: string): number | null {
  if (typeof raw === "string") {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }

  const n = toFiniteNumber(raw);
  if (n === null || n < 0) return null;

  const hint = normalizeKey(keyHint);
  const now = Date.now();

  if (hint.includes("retryafter") || hint.includes("untilreset") || hint.includes("seconds")) {
    return n > 1e9 ? Math.trunc(n) : Math.trunc(now + n * 1000);
  }
  if (hint.includes("millis") || hint.endsWith("ms")) {
    return n > 1e9 ? Math.trunc(n) : Math.trunc(now + n);
  }

  if (n >= 1e12) return Math.trunc(n);
  if (n >= 1e9) return Math.trunc(n * 1000);
  if (n > 0) return Math.trunc(now + n * 1000);
  return null;
}

function pushRemainingCandidate(ctx: ParseContext, value: unknown, score: number): void {
  const n = toFiniteNumber(value);
  if (n === null) return;
  ctx.remaining.push({ value: n, score });
}

function pushResetCandidate(ctx: ParseContext, value: unknown, score: number, keyHint: string): void {
  const ts = normalizeTimestamp(value, keyHint);
  if (ts === null) return;
  ctx.resetAt.push({ value: ts, score });
}

function walkMatchedValue(
  value: unknown,
  keyHint: string,
  ctx: ParseContext,
  field: "remaining" | "resetAt",
  depth: number,
  score: number,
): void {
  if (depth > MAX_PARSE_DEPTH) return;

  if (field === "remaining") pushRemainingCandidate(ctx, value, score);
  else pushResetCandidate(ctx, value, score, keyHint);

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      walkMatchedValue(value[i], keyHint, ctx, field, depth + 1, score - 1);
    }
    return;
  }

  if (!isRecord(value)) return;

  for (const [nestedRawKey, nestedValue] of Object.entries(value)) {
    const nestedKey = normalizeKey(nestedRawKey);
    let nextScore = score + scoreByModelHints(nestedKey, ctx.strategy);
    if (field === "remaining") {
      const p = ctx.remainingPriority.get(nestedKey);
      if (typeof p === "number") nextScore += p * 4;
    } else {
      const p = ctx.resetPriority.get(nestedKey);
      if (typeof p === "number") nextScore += p * 4;
    }
    walkMatchedValue(nestedValue, nestedRawKey, ctx, field, depth + 1, nextScore);
  }
}

function walkNode(value: unknown, ctx: ParseContext, pathScore: number, depth: number): void {
  if (depth > MAX_PARSE_DEPTH) return;
  if (!value || typeof value !== "object") return;
  if (ctx.seen.has(value)) return;
  ctx.seen.add(value);

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      walkNode(value[i], ctx, pathScore - 1, depth + 1);
    }
    return;
  }

  const node = value as Record<string, unknown>;
  const nodeScore = pathScore + scoreObjectModelHint(node, ctx.strategy);

  for (const [rawKey, rawValue] of Object.entries(node)) {
    const key = normalizeKey(rawKey);
    const keyScore = nodeScore + scoreByModelHints(key, ctx.strategy);

    const remainingPriority = ctx.remainingPriority.get(key);
    if (typeof remainingPriority === "number") {
      walkMatchedValue(rawValue, rawKey, ctx, "remaining", depth + 1, keyScore + remainingPriority * 5);
    }

    const resetPriority = ctx.resetPriority.get(key);
    if (typeof resetPriority === "number") {
      walkMatchedValue(rawValue, rawKey, ctx, "resetAt", depth + 1, keyScore + resetPriority * 5);
    }

    if (ctx.strategy.aliases.includes(key) || ctx.strategy.tokens.includes(key)) {
      pushRemainingCandidate(ctx, rawValue, keyScore + 30);
    }

    walkNode(rawValue, ctx, keyScore - 1, depth + 1);
  }
}

function pickBest(candidates: NumberCandidate[]): number | null {
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.value ?? null;
}

export function buildRateLimitExtractStrategy(modelName: string): RateLimitExtractStrategy {
  const hints = buildModelHints(modelName);

  const dynamicRemainingFields: string[] = [];
  const dynamicResetFields: string[] = [];

  for (const token of hints.tokens) {
    dynamicRemainingFields.push(
      `${token}remainingtokens`,
      `${token}remainingqueries`,
      `${token}remaining`,
      `remaining${token}tokens`,
      `remaining${token}queries`,
      `remaining${token}`,
    );
    dynamicResetFields.push(
      `${token}resetat`,
      `${token}resetsat`,
      `${token}nextresetat`,
      `${token}retryafter`,
      `${token}timeuntilreset`,
      `${token}cooldownuntil`,
    );
  }

  return {
    modelName,
    aliases: hints.aliases,
    tokens: hints.tokens,
    remainingFieldPriority: uniqueOrder([...dynamicRemainingFields, ...BASE_REMAINING_KEYS]),
    resetFieldPriority: uniqueOrder([...dynamicResetFields, ...BASE_RESET_KEYS]),
  };
}

export function normalizeRateLimitResponse(
  payload: unknown,
  modelName: string,
  options?: NormalizeRateLimitOptions,
): NormalizedRateLimitResult {
  const strategy = buildRateLimitExtractStrategy(modelName);
  const ctx: ParseContext = {
    strategy,
    remainingPriority: buildPriorityMap(strategy.remainingFieldPriority),
    resetPriority: buildPriorityMap(strategy.resetFieldPriority),
    remaining: [],
    resetAt: [],
    seen: new Set<object>(),
  };

  walkNode(payload, ctx, 0, 0);

  const remaining = pickBest(ctx.remaining);
  const resetAt = pickBest(ctx.resetAt);

  const out: NormalizedRateLimitResult = {
    known: remaining !== null || resetAt !== null,
    remaining,
    resetAt,
  };

  if (options?.includeRaw) out.raw = payload;
  return out;
}

export async function checkRateLimits(
  cookie: string,
  settings: GrokSettings,
  model: string,
): Promise<Record<string, unknown> | null> {
  const rateModel = toRateLimitModel(model);
  const headers = getDynamicHeaders(settings, "/rest/rate-limits");
  headers.Cookie = cookie;
  const body = JSON.stringify({ requestKind: "DEFAULT", modelName: rateModel });

  const resp = await fetch(RATE_LIMIT_API, { method: "POST", headers, body });
  if (!resp.ok) return null;
  return (await resp.json()) as Record<string, unknown>;
}
