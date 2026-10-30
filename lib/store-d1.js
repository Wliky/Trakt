/**
 * 存储实现（Cloudflare D1）
 *
 * 表结构见 schema.sql：
 *   kv(key TEXT PRIMARY KEY, value TEXT NOT NULL, exp INTEGER)
 *
 * 接口与 lib/store-node.js 的 FileStore 一致：
 *   get(key) / set(key, value, ttlSec) / delete(key)
 */

export class D1Store {
  constructor(db) {
    this.db = db;
  }

  async get(key) {
    if (!this.db) return null;
    const row = await this.db.prepare('SELECT value, exp FROM kv WHERE key = ?').bind(key).first();
    if (!row) return null;
    if (row.exp && Number(row.exp) < Date.now()) {
      await this.delete(key);
      return null;
    }
    try {
      return JSON.parse(row.value);
    } catch {
      return null;
    }
  }

  async set(key, value, ttlSec) {
    const exp = ttlSec ? Date.now() + ttlSec * 1000 : null;
    await this.db
      .prepare(
        'INSERT INTO kv (key, value, exp) VALUES (?, ?, ?) ' +
          'ON CONFLICT(key) DO UPDATE SET value = excluded.value, exp = excluded.exp'
      )
      .bind(key, JSON.stringify(value), exp)
      .run();
  }

  async delete(key) {
    await this.db.prepare('DELETE FROM kv WHERE key = ?').bind(key).run();
  }
}
