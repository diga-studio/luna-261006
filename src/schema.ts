/** SQLite 建表语句，幂等。 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS tickets (
  ticket_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  current_stage_index INTEGER,
  current_round TEXT,
  round_started_at INTEGER,
  round_deadline INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS stages (
  ticket_id TEXT NOT NULL,
  stage_index INTEGER NOT NULL,
  approvers TEXT NOT NULL,
  escalated_approvers TEXT NOT NULL,
  PRIMARY KEY (ticket_id, stage_index)
);

CREATE TABLE IF NOT EXISTS decisions (
  ticket_id TEXT NOT NULL,
  decision_id TEXT NOT NULL,
  stage_index INTEGER NOT NULL,
  round TEXT NOT NULL,
  approver TEXT NOT NULL,
  approve INTEGER NOT NULL,
  conclusion TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  PRIMARY KEY (ticket_id, decision_id)
);

CREATE TABLE IF NOT EXISTS votes (
  ticket_id TEXT NOT NULL,
  stage_index INTEGER NOT NULL,
  round TEXT NOT NULL,
  approver TEXT NOT NULL,
  approve INTEGER NOT NULL,
  decision_id TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  PRIMARY KEY (ticket_id, stage_index, round, approver)
);
`;
