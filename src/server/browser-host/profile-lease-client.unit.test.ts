import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { managementApi } from '../utils/management-api-client';
import {
  acquireBrowserProfileLease,
  releaseBrowserProfileLease,
} from './profile-lease-client';

vi.mock('../utils/management-api-client', () => ({
  managementApi: vi.fn(),
}));

describe('Browser Profile lease client', () => {
  beforeEach(() => {
    process.env.MYAGENTS_SIDECAR_ID = '__global__';
    vi.mocked(managementApi).mockReset();
  });

  afterEach(() => vi.useRealTimers());

  it('recovers an admitted lease by retrying the same request after a lost response', async () => {
    vi.useFakeTimers();
    vi.mocked(managementApi)
      .mockResolvedValueOnce({ ok: false, code: 'transport_outcome_unknown' })
      .mockResolvedValueOnce({ ok: true, admitted: true, leaseEpoch: 7 });

    const leasePromise = acquireBrowserProfileLease('capability-token');
    await vi.advanceTimersByTimeAsync(100);
    const lease = await leasePromise;

    expect(lease.leaseEpoch).toBe(7);
    expect(vi.mocked(managementApi).mock.calls[0]?.[2]).toEqual(
      vi.mocked(managementApi).mock.calls[1]?.[2],
    );
  });

  it('cancels an unreturned lease exactly when a retry is explicitly rejected', async () => {
    vi.useFakeTimers();
    vi.mocked(managementApi)
      .mockResolvedValueOnce({ ok: false, code: 'transport_outcome_unknown' })
      .mockResolvedValueOnce({ ok: false, code: 'browser_capability_invalid' })
      .mockResolvedValueOnce({ ok: true, cancelled: true });

    const leasePromise = acquireBrowserProfileLease('capability-token');
    const rejection = leasePromise.catch(error => error);
    await vi.advanceTimersByTimeAsync(100);
    await expect(rejection).resolves.toMatchObject({ message: 'BROWSER_PROFILE_LEASE_UNAVAILABLE' });

    const calls = vi.mocked(managementApi).mock.calls;
    expect(calls.map(([path]) => path)).toEqual([
      '/api/browser/profile/acquire',
      '/api/browser/profile/acquire',
      '/api/browser/profile/cancel',
    ]);
    expect(calls[0]?.[2]).toEqual(calls[1]?.[2]);
    expect((calls[2]?.[2] as { requestId: string }).requestId).toBe(
      (calls[0]?.[2] as { requestId: string }).requestId,
    );
  });

  it('projects queue position and clears the wait when the exact request is admitted', async () => {
    vi.useFakeTimers();
    vi.mocked(managementApi)
      .mockResolvedValueOnce({ ok: true, admitted: false, queuePosition: 2, retryAfterMs: 100 })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true, admitted: true, leaseEpoch: 9 })
      .mockResolvedValueOnce({ ok: true });

    const leasePromise = acquireBrowserProfileLease('capability-token');
    await vi.advanceTimersByTimeAsync(100);
    await expect(leasePromise).resolves.toMatchObject({ leaseEpoch: 9 });

    const statusCalls = vi.mocked(managementApi).mock.calls.filter(
      ([path]) => path === '/api/browser/profile/status',
    );
    expect(statusCalls.map(([, , body]) => body)).toEqual([
      expect.objectContaining({ state: 'queued', queuePosition: 2 }),
      expect.objectContaining({ state: 'granted' }),
    ]);
    expect((statusCalls[0]?.[2] as { requestId: string }).requestId).toBe(
      (statusCalls[1]?.[2] as { requestId: string }).requestId,
    );
  });

  it('reconciles a lost cancel response with the same request id', async () => {
    vi.useFakeTimers();
    vi.mocked(managementApi)
      .mockResolvedValueOnce({ ok: true, admitted: false, queuePosition: 1, retryAfterMs: 1_000 })
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(new Error('cancel response lost'))
      .mockResolvedValueOnce({ ok: true, cancelled: false })
      .mockResolvedValueOnce({ ok: true });
    const controller = new AbortController();

    const leasePromise = acquireBrowserProfileLease('capability-token', controller.signal);
    const rejection = leasePromise.catch(error => error);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await vi.advanceTimersByTimeAsync(100);
    await expect(rejection).resolves.toMatchObject({ message: 'BROWSER_WAIT_CANCELLED' });

    const cancelCalls = vi.mocked(managementApi).mock.calls.filter(
      ([path]) => path === '/api/browser/profile/cancel',
    );
    expect(cancelCalls).toHaveLength(2);
    expect(cancelCalls[0]?.[2]).toEqual(cancelCalls[1]?.[2]);
  });

  it('treats a stale release response as settled after retrying transport loss', async () => {
    vi.useFakeTimers();
    vi.mocked(managementApi)
      .mockRejectedValueOnce(new Error('response lost'))
      .mockResolvedValueOnce({ ok: true, released: false });

    const released = releaseBrowserProfileLease({
      requestId: 'profile-a',
      leaseEpoch: 7,
      token: 'capability-token',
    });
    await vi.advanceTimersByTimeAsync(100);
    await expect(released).resolves.toBe(true);
  });

  it('keeps reconciling the exact release after the foreground retry budget is exhausted', async () => {
    vi.useFakeTimers();
    vi.mocked(managementApi)
      .mockRejectedValueOnce(new Error('control plane unavailable'))
      .mockRejectedValueOnce(new Error('control plane unavailable'))
      .mockRejectedValueOnce(new Error('control plane unavailable'))
      .mockResolvedValueOnce({ ok: true, released: true });

    const release = releaseBrowserProfileLease({
      requestId: 'profile-a',
      leaseEpoch: 7,
      token: 'capability-token',
    });
    await vi.advanceTimersByTimeAsync(200);
    await expect(release).resolves.toBe(false);
    await vi.advanceTimersByTimeAsync(0);

    expect(vi.mocked(managementApi)).toHaveBeenCalledTimes(4);
    expect(vi.mocked(managementApi).mock.calls.map(([, , body]) => body)).toEqual([
      expect.objectContaining({ requestId: 'profile-a', leaseEpoch: 7 }),
      expect.objectContaining({ requestId: 'profile-a', leaseEpoch: 7 }),
      expect.objectContaining({ requestId: 'profile-a', leaseEpoch: 7 }),
      expect.objectContaining({ requestId: 'profile-a', leaseEpoch: 7 }),
    ]);
  });
});
