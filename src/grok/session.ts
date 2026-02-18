import type { GrokSettings } from "../settings";
import { getDynamicHeaders } from "./headers";

export interface CloneConversationResult {
  conversationId: string;
  lastResponseId: string;
}

function cloneUrl(shareLinkId: string): string {
  return `https://grok.com/rest/app-chat/share_links/${encodeURIComponent(shareLinkId)}/clone`;
}

function continueUrl(conversationId: string): string {
  return `https://grok.com/rest/app-chat/conversations/${encodeURIComponent(conversationId)}/responses`;
}

function shareUrl(conversationId: string): string {
  return `https://grok.com/rest/app-chat/conversations/${encodeURIComponent(conversationId)}/share`;
}

function asObj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function asStr(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function findLastResponseIdFromClone(data: Record<string, unknown>): string {
  const responses = Array.isArray(data.responses) ? data.responses : [];
  let fallback = "";
  for (let i = responses.length - 1; i >= 0; i--) {
    const item = asObj(responses[i]);
    if (!item) continue;
    const rid = asStr(item.responseId);
    if (!rid) continue;
    if (!fallback) fallback = rid;
    if (asStr(item.sender) === "assistant") return rid;
  }
  return fallback;
}

export async function continueConversation(args: {
  conversationId: string;
  payload: Record<string, unknown>;
  cookie: string;
  settings: GrokSettings;
  referer?: string;
}): Promise<Response> {
  const path = `/rest/app-chat/conversations/${encodeURIComponent(args.conversationId)}/responses`;
  const headers = getDynamicHeaders(args.settings, path);
  headers.Cookie = args.cookie;
  if (args.referer) headers.Referer = args.referer;
  return fetch(continueUrl(args.conversationId), {
    method: "POST",
    headers,
    body: JSON.stringify(args.payload),
  });
}

export async function shareConversation(args: {
  conversationId: string;
  responseId: string;
  cookie: string;
  settings: GrokSettings;
}): Promise<string> {
  const path = `/rest/app-chat/conversations/${encodeURIComponent(args.conversationId)}/share`;
  const headers = getDynamicHeaders(args.settings, path);
  headers.Cookie = args.cookie;
  headers.Referer = "https://grok.com/";

  const resp = await fetch(shareUrl(args.conversationId), {
    method: "POST",
    headers,
    body: JSON.stringify({ responseId: args.responseId, allowIndexing: true }),
  });
  if (!resp.ok) return "";
  const data = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
  return asStr(data.shareLinkId);
}

export async function cloneConversationByShare(args: {
  shareLinkId: string;
  cookie: string;
  settings: GrokSettings;
}): Promise<CloneConversationResult | null> {
  const shareLinkId = asStr(args.shareLinkId);
  if (!shareLinkId) return null;

  const path = `/rest/app-chat/share_links/${encodeURIComponent(shareLinkId)}/clone`;
  const headers = getDynamicHeaders(args.settings, path);
  headers.Cookie = args.cookie;
  headers.Referer = "https://grok.com/";

  const resp = await fetch(cloneUrl(shareLinkId), {
    method: "POST",
    headers,
    body: JSON.stringify({}),
  });
  if (!resp.ok) return null;

  const data = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
  const conversation = asObj(data.conversation);
  const conversationId = asStr(conversation?.conversationId);
  if (!conversationId) return null;
  const lastResponseId = findLastResponseIdFromClone(data);
  if (!lastResponseId) return null;
  return { conversationId, lastResponseId };
}

