import { describe, expect, it, vi } from 'vitest';
import { streamEvents } from './client';

describe('streamEvents', () => {
  it('reports network failures instead of silently retrying', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    const controller = new AbortController();
    const errors: Error[] = [];
    const running = streamEvents('/cases/c1/events', () => {}, controller.signal, '', (error) => {
      errors.push(error);
      controller.abort();
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await running;
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('fetch failed');
    vi.unstubAllGlobals();
  });
});
