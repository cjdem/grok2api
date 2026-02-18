interface ToolUsageCard {
  rolloutId: string;
  type: string;
  content: string;
}

export interface ToolUsageCardConsumeOptions {
  emitLines: boolean;
  fallbackRolloutId?: string;
}

export interface ToolUsageCardConsumeResult {
  text: string;
  lines: string[];
}

const TOOL_USAGE_OPEN = "<xai:tool_usage_card";
const TOOL_USAGE_CLOSE = "</xai:tool_usage_card>";
const TOOL_NAME_OPEN = "<xai:tool_name>";
const TOOL_NAME_CLOSE = "</xai:tool_name>";
const TOOL_ARGS_CLOSE = "</xai:tool_args>";
const PARTIAL_MARKER = "<xai:";

const ROLLOUT_KEYS = ["rollout_id", "rolloutid", "rollout-id", "rollout"] as const;
const METADATA_KEYS = new Set(["id", "tool", "tool_name", "name", "type", ...ROLLOUT_KEYS]);

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function normalizeText(value: string): string {
  return value.replace(/\r\n/g, "\n").trim();
}

function asScalarText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function normalizeToolType(toolName: string): string {
  const raw = toolName.trim();
  const normalized = raw.toLowerCase();
  if (normalized === "web_search" || normalized === "web-search" || normalized === "websearch") return "WebSearch";
  if (
    normalized === "search_image" ||
    normalized === "search_images" ||
    normalized === "search-image" ||
    normalized === "searchimage" ||
    normalized === "image_search"
  ) {
    return "SearchImage";
  }
  if (
    normalized === "agent_think" ||
    normalized === "agent-think" ||
    normalized === "agentthink" ||
    normalized === "chatroom_send" ||
    normalized === "chatroom-send"
  ) {
    return "AgentThink";
  }
  return raw || "Unknown";
}

function parseToolArgs(raw: string): unknown {
  const text = raw.trim();
  if (!text) return "";
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function findByPreferredKeys(value: unknown, keys: readonly string[], depth = 0): string {
  if (depth > 6) return "";

  const scalar = asScalarText(value);
  if (scalar && depth > 0) return "";

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findByPreferredKeys(item, keys, depth + 1);
      if (found) return found;
    }
    return "";
  }

  const obj = asObject(value);
  if (!obj) return "";

  for (const key of keys) {
    for (const entryKey of Object.keys(obj)) {
      if (entryKey.toLowerCase() !== key.toLowerCase()) continue;
      const v = obj[entryKey];
      const direct = asScalarText(v);
      if (direct) return direct;
      if (Array.isArray(v)) {
        const joined = v.map((item) => asScalarText(item)).filter(Boolean).join(", ").trim();
        if (joined) return joined;
      }
    }
  }

  for (const v of Object.values(obj)) {
    const found = findByPreferredKeys(v, keys, depth + 1);
    if (found) return found;
  }

  return "";
}

function findFirstScalar(value: unknown, depth = 0): string {
  if (depth > 6) return "";

  const direct = asScalarText(value);
  if (direct) return direct;

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFirstScalar(item, depth + 1);
      if (found) return found;
    }
    return "";
  }

  const obj = asObject(value);
  if (!obj) return "";

  for (const [key, v] of Object.entries(obj)) {
    if (METADATA_KEYS.has(key.toLowerCase())) continue;
    const found = findFirstScalar(v, depth + 1);
    if (found) return found;
  }

  return "";
}

function resolveRolloutId(parsedArgs: unknown, fallbackRolloutId: string): string {
  const fromArgs = findByPreferredKeys(parsedArgs, ROLLOUT_KEYS);
  if (fromArgs) return fromArgs;
  const fallback = fallbackRolloutId.trim();
  return fallback || "-";
}

function resolveContent(type: string, parsedArgs: unknown, rawArgs: string): string {
  const keysByType: Record<string, readonly string[]> = {
    WebSearch: ["query", "queries", "keyword", "keywords", "prompt", "text"],
    SearchImage: ["query", "prompt", "description", "keyword", "keywords", "text"],
    AgentThink: ["thought", "reason", "reasoning", "content", "text", "summary", "plan"],
  };

  const preferredKeys = keysByType[type] ?? ["content", "text", "query", "prompt", "message"];
  const preferred = findByPreferredKeys(parsedArgs, preferredKeys);
  if (preferred) return normalizeText(preferred);

  const fallback = findFirstScalar(parsedArgs);
  if (fallback) return normalizeText(fallback);

  return normalizeText(rawArgs);
}

function formatCardLine(card: ToolUsageCard): string {
  const prefix = `[${card.rolloutId || "-"}][${card.type}]`;
  const text = normalizeText(card.content);
  if (!text) return prefix;
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return prefix;
  return lines.map((line) => `${prefix} ${line}`).join("\n");
}

function parseCard(fragment: string, fallbackRolloutId: string): ToolUsageCard | null {
  const toolMatch = fragment.match(/<xai:tool_name>\s*([^<]+?)\s*<\/xai:tool_name>/i);
  const argsMatch = fragment.match(/<xai:tool_args>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/xai:tool_args>/i);

  if (!toolMatch?.[1] || !argsMatch?.[1]) return null;

  const toolName = toolMatch[1].replace(/^<!\[CDATA\[|\]\]>$/g, "").trim();
  if (!toolName) return null;

  const rawArgs = argsMatch[1].trim();
  const parsedArgs = parseToolArgs(rawArgs);
  const type = normalizeToolType(toolName);

  return {
    rolloutId: resolveRolloutId(parsedArgs, fallbackRolloutId),
    type,
    content: resolveContent(type, parsedArgs, rawArgs),
  };
}

function findCardStart(buffer: string): number {
  const lower = buffer.toLowerCase();
  const usageIdx = lower.indexOf(TOOL_USAGE_OPEN);
  const nameIdx = lower.indexOf(TOOL_NAME_OPEN);
  if (usageIdx < 0) return nameIdx;
  if (nameIdx < 0) return usageIdx;
  return Math.min(usageIdx, nameIdx);
}

function findPartialStart(buffer: string): number {
  const lower = buffer.toLowerCase();
  const idx = lower.lastIndexOf(PARTIAL_MARKER);
  if (idx < 0) return -1;
  if (lower.length - idx > 64) return -1;
  return idx;
}

function extractCardFragment(buffer: string): { fragment: string; end: number } | null {
  const lower = buffer.toLowerCase();

  if (lower.startsWith(TOOL_USAGE_OPEN)) {
    const closeIdx = lower.indexOf(TOOL_USAGE_CLOSE);
    if (closeIdx < 0) return null;
    const end = closeIdx + TOOL_USAGE_CLOSE.length;
    return { fragment: buffer.slice(0, end), end };
  }

  if (lower.startsWith(TOOL_NAME_OPEN)) {
    const nameCloseIdx = lower.indexOf(TOOL_NAME_CLOSE);
    if (nameCloseIdx < 0) return null;

    const argsCloseIdx = lower.indexOf(TOOL_ARGS_CLOSE, nameCloseIdx + TOOL_NAME_CLOSE.length);
    if (argsCloseIdx < 0) return null;

    let end = argsCloseIdx + TOOL_ARGS_CLOSE.length;
    const trailing = buffer.slice(end);
    const trimmedLeading = trailing.length - trailing.trimStart().length;
    const maybeUsageClose = trailing.slice(trimmedLeading, trimmedLeading + TOOL_USAGE_CLOSE.length).toLowerCase();
    if (maybeUsageClose === TOOL_USAGE_CLOSE) {
      end += trimmedLeading + TOOL_USAGE_CLOSE.length;
    }

    return { fragment: buffer.slice(0, end), end };
  }

  return null;
}

export class ToolUsageCardStreamParser {
  private buffer = "";

  consume(input: string, opts: ToolUsageCardConsumeOptions): ToolUsageCardConsumeResult {
    if (input) this.buffer += input;

    const outText: string[] = [];
    const outLines: string[] = [];
    const fallbackRolloutId = (opts.fallbackRolloutId ?? "").trim();

    while (this.buffer) {
      const start = findCardStart(this.buffer);
      if (start < 0) {
        const partialStart = findPartialStart(this.buffer);
        if (partialStart < 0) {
          outText.push(this.buffer);
          this.buffer = "";
        } else if (partialStart > 0) {
          outText.push(this.buffer.slice(0, partialStart));
          this.buffer = this.buffer.slice(partialStart);
        }
        break;
      }

      if (start > 0) {
        outText.push(this.buffer.slice(0, start));
        this.buffer = this.buffer.slice(start);
        continue;
      }

      const segment = extractCardFragment(this.buffer);
      if (!segment) break;

      const card = parseCard(segment.fragment, fallbackRolloutId);
      if (!card) {
        outText.push(segment.fragment);
      } else if (opts.emitLines) {
        outLines.push(formatCardLine(card));
      }

      this.buffer = this.buffer.slice(segment.end);
    }

    return {
      text: outText.join(""),
      lines: outLines,
    };
  }

  flush(opts: ToolUsageCardConsumeOptions & { emitIncompleteAsText?: boolean }): ToolUsageCardConsumeResult {
    const result = this.consume("", opts);
    if (opts.emitIncompleteAsText && this.buffer) {
      result.text += this.buffer;
      this.buffer = "";
    }
    return result;
  }
}

export function replaceToolUsageCardsInText(input: string, opts: ToolUsageCardConsumeOptions): ToolUsageCardConsumeResult {
  const parser = new ToolUsageCardStreamParser();
  const first = parser.consume(input, opts);
  const tail = parser.flush({ ...opts, emitIncompleteAsText: true });
  return {
    text: `${first.text}${tail.text}`,
    lines: [...first.lines, ...tail.lines],
  };
}
