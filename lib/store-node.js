/**
 * 存储实现（Node 版）：本地 JSON 文件，单进程安全，写入走原子 rename。
 * 接口与 lib/store-d1.js 的 D1Store 一致。
 */

import fs from 'node:fs/promises';
import path from 'node:path';

export class FileStore {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'db.json');
    this.cache = null;
    this.queue = Promise.resolve();
  }

  async #load() {
    if (this.cache) return this.cache;
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      this.cache = JSON.parse(raw);
    } catch {
      this.cache = {};
    }
    return this.cache;
  }

  async #flush() {
    // 串行化写入，避免并发 rename 互相覆盖
    this.queue = this.queue.then(async () => {
      await fs.mkdir(this.dir, { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(this.cache, null, 2), 'utf8');
      await fs.rename(tmp, this.file);
    });
    return this.queue;
  }

  async get(key) {
    const db = await this.#load();
    const rec = db[key];
    if (!rec) return null;
    if (rec.exp && rec.exp < Date.now()) {
      delete db[key];
      await this.#flush();
      return null;
    }
    return rec.v;
  }

  async set(key, value, ttlSec) {
    const db = await this.#load();
    db[key] = ttlSec ? { v: value, exp: Date.now() + ttlSec * 1000 } : { v: value };
    await this.#flush();
  }

  async delete(key) {
    const db = await this.#load();
    if (key in db) {
      delete db[key];
      await this.#flush();
    }
  }
}
