import base from './index-v1.2.js';
import { reportSystemError, reportSystemSuccess } from './error-bus.js';

const SOURCE = 'Curator Integrity';

export default {
  async fetch(request, env, ctx) {
    try {
      return await base.fetch(request, env, ctx);
    } catch (error) {
      ctx?.waitUntil?.(reportSystemError(env, {
        source: SOURCE,
        component: 'request-handler',
        error,
        severity: 'p1',
        type: 'unhandled-request-error',
        context: { method: request.method, path: new URL(request.url).pathname }
      }));
      throw error;
    }
  },

  async scheduled(controller, env, ctx) {
    const pending = [];
    const captureCtx = { waitUntil(promise) { pending.push(Promise.resolve(promise)); } };
    ctx.waitUntil((async () => {
      try {
        await base.scheduled(controller, env, captureCtx);
        await Promise.all(pending);
        await reportSystemSuccess(env, {
          source: SOURCE,
          component: 'scheduled-monitor',
          message: 'Scheduled Integrity monitor completed successfully.',
          maxAgeMinutes: 180,
        });
      } catch (error) {
        await reportSystemError(env, {
          source: SOURCE,
          component: 'scheduled-monitor',
          error,
          severity: 'p1',
          type: 'scheduled-monitor-error',
        });
        console.error('Curator Integrity scheduled monitor failed', error);
      }
    })());
  }
};
