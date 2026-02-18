-- Conversation context for native multi-turn continuation on Workers.
-- Scope isolates different API keys / clients to prevent cross-tenant reuse.

CREATE TABLE IF NOT EXISTS conversations (
  scope TEXT NOT NULL,
  openai_conversation_id TEXT NOT NULL,
  grok_conversation_id TEXT NOT NULL,
  last_response_id TEXT NOT NULL,
  share_link_id TEXT NOT NULL DEFAULT '',
  token TEXT NOT NULL,
  history_hash TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (scope, openai_conversation_id)
);

CREATE INDEX IF NOT EXISTS idx_conversations_scope_hash
  ON conversations(scope, history_hash);

CREATE INDEX IF NOT EXISTS idx_conversations_scope_expires
  ON conversations(scope, expires_at);

CREATE INDEX IF NOT EXISTS idx_conversations_scope_token_updated
  ON conversations(scope, token, updated_at);
