import type { Env } from "../env";
import { dbAll, dbFirst, dbRun } from "../db";
import { nowMs } from "../utils/time";

export interface ConversationRow {
  scope: string;
  openai_conversation_id: string;
  grok_conversation_id: string;
  last_response_id: string;
  share_link_id: string;
  token: string;
  history_hash: string;
  created_at: number;
  updated_at: number;
  expires_at: number;
}

export interface UpsertConversationInput {
  scope: string;
  openai_conversation_id: string;
  grok_conversation_id: string;
  last_response_id: string;
  share_link_id?: string;
  token: string;
  history_hash?: string;
  created_at?: number;
  updated_at?: number;
  expires_at: number;
}

export interface ConversationStats {
  active_total: number;
  expired_total: number;
  top_tokens: Array<{ token_suffix: string; count: number }>;
}

function tokenSuffix(token: string): string {
  if (!token) return "";
  return token.length >= 6 ? token.slice(-6) : token;
}

export async function upsertConversation(
  db: Env["DB"],
  row: UpsertConversationInput,
): Promise<void> {
  const createdAt = Number.isFinite(row.created_at) ? Number(row.created_at) : nowMs();
  const updatedAt = Number.isFinite(row.updated_at) ? Number(row.updated_at) : nowMs();
  const historyHash = String(row.history_hash ?? "").trim();
  const shareLink = String(row.share_link_id ?? "").trim();

  await dbRun(
    db,
    `INSERT INTO conversations(
      scope, openai_conversation_id, grok_conversation_id, last_response_id, share_link_id,
      token, history_hash, created_at, updated_at, expires_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(scope, openai_conversation_id) DO UPDATE SET
      grok_conversation_id=excluded.grok_conversation_id,
      last_response_id=excluded.last_response_id,
      share_link_id=excluded.share_link_id,
      token=excluded.token,
      history_hash=excluded.history_hash,
      updated_at=excluded.updated_at,
      expires_at=excluded.expires_at`,
    [
      row.scope,
      row.openai_conversation_id,
      row.grok_conversation_id,
      row.last_response_id,
      shareLink,
      row.token,
      historyHash,
      createdAt,
      updatedAt,
      row.expires_at,
    ],
  );
}

export async function getConversationById(
  db: Env["DB"],
  scope: string,
  openaiConversationId: string,
  atMs = nowMs(),
): Promise<ConversationRow | null> {
  await dbRun(
    db,
    "DELETE FROM conversations WHERE scope = ? AND openai_conversation_id = ? AND expires_at <= ?",
    [scope, openaiConversationId, atMs],
  );
  return dbFirst<ConversationRow>(
    db,
    `SELECT scope, openai_conversation_id, grok_conversation_id, last_response_id, share_link_id,
            token, history_hash, created_at, updated_at, expires_at
     FROM conversations
     WHERE scope = ? AND openai_conversation_id = ? AND expires_at > ?
     LIMIT 1`,
    [scope, openaiConversationId, atMs],
  );
}

export async function findConversationByHistoryHash(
  db: Env["DB"],
  scope: string,
  historyHash: string,
  atMs = nowMs(),
): Promise<ConversationRow | null> {
  const hash = String(historyHash || "").trim();
  if (!hash) return null;

  await dbRun(
    db,
    "DELETE FROM conversations WHERE scope = ? AND expires_at <= ?",
    [scope, atMs],
  );
  return dbFirst<ConversationRow>(
    db,
    `SELECT scope, openai_conversation_id, grok_conversation_id, last_response_id, share_link_id,
            token, history_hash, created_at, updated_at, expires_at
     FROM conversations
     WHERE scope = ? AND history_hash = ? AND expires_at > ?
     ORDER BY updated_at DESC
     LIMIT 1`,
    [scope, hash, atMs],
  );
}

export async function deleteConversationById(
  db: Env["DB"],
  scope: string,
  openaiConversationId: string,
): Promise<void> {
  await dbRun(
    db,
    "DELETE FROM conversations WHERE scope = ? AND openai_conversation_id = ?",
    [scope, openaiConversationId],
  );
}

export async function cleanupExpiredConversations(
  db: Env["DB"],
  limit: number,
  atMs = nowMs(),
): Promise<number> {
  const batch = Math.max(1, Math.min(500, Math.floor(limit || 100)));
  const rows = await dbAll<{ scope: string; openai_conversation_id: string }>(
    db,
    `SELECT scope, openai_conversation_id
     FROM conversations
     WHERE expires_at <= ?
     ORDER BY expires_at ASC
     LIMIT ?`,
    [atMs, batch],
  );
  if (!rows.length) return 0;

  const deletes = rows.map((row) =>
    db
      .prepare("DELETE FROM conversations WHERE scope = ? AND openai_conversation_id = ?")
      .bind(row.scope, row.openai_conversation_id),
  );
  await db.batch(deletes);
  return rows.length;
}

export async function trimConversationsForToken(
  db: Env["DB"],
  scope: string,
  token: string,
  keep: number,
): Promise<number> {
  const keepCount = Math.max(1, Math.floor(keep || 1));
  const rows = await dbAll<{ openai_conversation_id: string }>(
    db,
    `SELECT openai_conversation_id
     FROM conversations
     WHERE scope = ? AND token = ?
     ORDER BY updated_at DESC`,
    [scope, token],
  );
  if (rows.length <= keepCount) return 0;

  const stale = rows.slice(keepCount);
  const deletes = stale.map((row) =>
    db
      .prepare("DELETE FROM conversations WHERE scope = ? AND openai_conversation_id = ?")
      .bind(scope, row.openai_conversation_id),
  );
  await db.batch(deletes);
  return stale.length;
}

export async function getConversationStats(
  db: Env["DB"],
  topN = 20,
  atMs = nowMs(),
): Promise<ConversationStats> {
  const active = await dbFirst<{ c: number }>(
    db,
    "SELECT COUNT(1) as c FROM conversations WHERE expires_at > ?",
    [atMs],
  );
  const expired = await dbFirst<{ c: number }>(
    db,
    "SELECT COUNT(1) as c FROM conversations WHERE expires_at <= ?",
    [atMs],
  );
  const topRows = await dbAll<{ token: string; c: number }>(
    db,
    `SELECT token as token, COUNT(1) as c
     FROM conversations
     WHERE expires_at > ?
     GROUP BY token
     ORDER BY c DESC
     LIMIT ?`,
    [atMs, Math.max(1, Math.min(100, Math.floor(topN || 20)))],
  );
  return {
    active_total: active?.c ?? 0,
    expired_total: expired?.c ?? 0,
    top_tokens: topRows.map((row) => ({ token_suffix: tokenSuffix(row.token), count: row.c })),
  };
}
