import { sha256Hex } from "./crypto";

type MessageContent =
  | string
  | Array<{ type?: string; text?: string; image_url?: { url?: string } }>
  | null
  | undefined;

interface GenericMessage {
  role?: string;
  content?: MessageContent;
}

function extractText(content: MessageContent): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (item?.type !== "text") continue;
    const text = String(item.text ?? "");
    if (text.trim()) parts.push(text);
  }
  return parts.join("");
}

export async function computeHistoryHash(
  messages: GenericMessage[],
  excludeLastUser: boolean,
): Promise<string> {
  if (!Array.isArray(messages) || !messages.length) return "";

  const systemParts: string[] = [];
  const userParts: string[] = [];
  let hasAssistant = false;

  for (const msg of messages) {
    const role = String(msg?.role ?? "");
    if (role === "assistant") {
      hasAssistant = true;
      continue;
    }
    const text = extractText(msg?.content).trim();
    if (!text) continue;
    if (role === "system") systemParts.push(`system:${text}`);
    else if (role === "user") userParts.push(`user:${text}`);
  }

  const usedUsers =
    excludeLastUser && hasAssistant && userParts.length > 0
      ? userParts.slice(0, userParts.length - 1)
      : userParts;

  const parts = [...systemParts, ...usedUsers];
  if (!parts.length) return "";
  return sha256Hex(parts.join("\n"));
}

export async function buildConversationScope(args: {
  apiKey: string | null;
  clientIp: string;
}): Promise<string> {
  const key = String(args.apiKey ?? "").trim();
  if (key) return `k:${await sha256Hex(key)}`;
  return `ip:${await sha256Hex(String(args.clientIp || "0.0.0.0"))}`;
}

