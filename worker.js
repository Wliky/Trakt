import { handleRequest } from './lib/core.js';
import { D1Store } from './lib/store-d1.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      return handleRequest(request, { store: new D1Store(env.DB), env });
    }
    return env.ASSETS.fetch(request);
  },
};
