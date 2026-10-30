-- Trakt Manager · D1 表结构
-- 数据库：Trakt   绑定：DB
-- 执行：wrangler d1 execute Trakt --file=./schema.sql --remote

CREATE TABLE IF NOT EXISTS kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  exp   INTEGER
);

CREATE INDEX IF NOT EXISTS idx_kv_exp ON kv (exp);
