import { handleRequest, runDueBackups } from './lib/core.js';
import { D1Store } from './lib/store-d1.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      return handleRequest(request, { store: new D1Store(env.DB), env });
    }
    return env.ASSETS.fetch(request);
  },

  // WebDAV 自动备份：cron 每小时触发，是否真的运行由 runDueBackups 按用户配置判断
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runDueBackups({ store: new D1Store(env.DB), env }));
  },
};
