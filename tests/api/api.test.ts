import { describe, expect, it } from 'vitest';
import { route } from '../../src/api/server.js';
describe('read-only dashboard routing', () => {
  it('returns known resources and rejects mutation methods and unknown endpoints', () => {
    const resources = {
      status: () => ({ mode: 'signal' }),
      health: () => ({ status: 'HEALTHY' }),
      signals: () => [],
      trades: () => [],
      positions: () => [],
      stats: () => ({}),
    };
    expect(route('GET', '/api/status', resources)).toEqual({ code: 200, body: { mode: 'signal' } });
    expect(route('POST', '/api/status', resources).code).toBe(405);
    expect(route('GET', '/api/config', resources).code).toBe(404);
  });
});
