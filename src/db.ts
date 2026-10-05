import { DatabaseSync } from "node:sqlite";

export interface MessageRow {
  id: number;
  conversation_id: string;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
  recalled: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  nonce BLOB NOT NULL,
  ciphertext BLOB NOT NULL,
  recalled INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS tokens (
  message_id INTEGER NOT NULL REFERENCES messages(id),
  token BLOB NOT NULL,
  PRIMARY KEY (message_id, token)
);
CREATE INDEX IF NOT EXISTS idx_tokens_token ON tokens(token, message_id);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, id);
`;

/** 打开（或创建）数据库并建好 schema；密钥校验由上层负责。 */
export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return db;
}
