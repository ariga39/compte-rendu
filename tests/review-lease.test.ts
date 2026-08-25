import { describe, expect, it } from 'vitest';
import {
  ReviewLeaseDurableObject,
  type LeaseDurableObjectState,
} from '../apps/core/src/cloudflare-review-adapter';
import type { OperationalLogEvent } from '../packages/contracts/src';

const registration = {
  runId: 'run-lease-alarm-1',
  attempt: 2,
  generation: 2,
  sandboxId: 'run-lease-alarm-1-attempt-2',
  expiresAt: '2020-01-01T00:00:00.000Z',
};

describe('Review lease alarm', () => {
  it('destroys an expired Sandbox, clears storage, and records destroyed', async () => {
    let stored: typeof registration | undefined = registration;
    let destroyed = false;
    const events: OperationalLogEvent[] = [];
    const state: LeaseDurableObjectState = {
      storage: {
        get: async <A>(_key: string) => stored as A | undefined,
        put: async (_key, value) => {
          stored = value as typeof registration;
        },
        delete: async () => {
          stored = undefined;
          return true;
        },
        setAlarm: async () => {},
        deleteAlarm: async () => {},
      },
    };
    const lease = new ReviewLeaseDurableObject(
      state,
      { Sandbox: {} },
      {
        log: {
          record: async (event) => {
            events.push(event);
          },
        },
        getSandbox: async () => ({
          destroy: async () => {
            destroyed = true;
          },
        }),
      },
    );

    await lease.alarm();

    expect(destroyed).toBe(true);
    expect(stored).toBeUndefined();
    expect(events).toEqual([
      {
        phase: 'lease',
        outcome: 'destroyed',
        runId: registration.runId,
        attempt: registration.attempt,
        sandboxId: registration.sandboxId,
      },
    ]);
  });

  it('defers invalid lease cleanup and records deferred without starting a Sandbox', async () => {
    const invalidRegistration = { ...registration, expiresAt: 'not-a-date' };
    let alarmScheduled = false;
    let sandboxRequested = false;
    const events: OperationalLogEvent[] = [];
    const state: LeaseDurableObjectState = {
      storage: {
        get: async <A>(_key: string) => invalidRegistration as A,
        put: async () => {},
        delete: async () => true,
        setAlarm: async () => {
          alarmScheduled = true;
        },
        deleteAlarm: async () => {},
      },
    };
    const lease = new ReviewLeaseDurableObject(
      state,
      { Sandbox: {} },
      {
        log: {
          record: async (event) => {
            events.push(event);
          },
        },
        getSandbox: async () => {
          sandboxRequested = true;
          return { destroy: async () => {} };
        },
      },
    );

    await lease.alarm();

    expect(alarmScheduled).toBe(true);
    expect(sandboxRequested).toBe(false);
    expect(events).toEqual([
      {
        phase: 'lease',
        outcome: 'deferred',
        runId: invalidRegistration.runId,
        attempt: invalidRegistration.attempt,
        sandboxId: invalidRegistration.sandboxId,
        reason: 'invalid',
      },
    ]);
  });

  it('defers not-yet-due cleanup and preserves the lease', async () => {
    const futureRegistration = { ...registration, expiresAt: '2099-01-01T00:00:00.000Z' };
    let alarmAt: number | Date | undefined;
    let sandboxRequested = false;
    const events: OperationalLogEvent[] = [];
    const state: LeaseDurableObjectState = {
      storage: {
        get: async <A>(_key: string) => futureRegistration as A,
        put: async () => {},
        delete: async () => true,
        setAlarm: async (time) => {
          alarmAt = time;
        },
        deleteAlarm: async () => {},
      },
    };
    const lease = new ReviewLeaseDurableObject(
      state,
      { Sandbox: {} },
      {
        log: {
          record: async (event) => {
            events.push(event);
          },
        },
        getSandbox: async () => {
          sandboxRequested = true;
          return { destroy: async () => {} };
        },
      },
    );

    await lease.alarm();

    expect(alarmAt).toBeDefined();
    expect(sandboxRequested).toBe(false);
    expect(events).toEqual([
      {
        phase: 'lease',
        outcome: 'deferred',
        runId: futureRegistration.runId,
        attempt: futureRegistration.attempt,
        sandboxId: futureRegistration.sandboxId,
        reason: 'not_due',
      },
    ]);
  });

  it('rearms and rethrows cleanup failure while recording failed', async () => {
    let retryAlarmScheduled = false;
    const events: OperationalLogEvent[] = [];
    const state: LeaseDurableObjectState = {
      storage: {
        get: async <A>(_key: string) => registration as A,
        put: async () => {},
        delete: async () => true,
        setAlarm: async () => {
          retryAlarmScheduled = true;
        },
        deleteAlarm: async () => {},
      },
    };
    const lease = new ReviewLeaseDurableObject(
      state,
      { Sandbox: {} },
      {
        log: {
          record: async (event) => {
            events.push(event);
            throw new Error('log sink unavailable');
          },
        },
        getSandbox: async () => ({
          destroy: async () => {
            throw new Error('Sandbox destroy unavailable');
          },
        }),
      },
    );

    await expect(lease.alarm()).rejects.toThrow('Sandbox destroy unavailable');
    expect(retryAlarmScheduled).toBe(true);
    expect(events).toEqual([
      {
        phase: 'lease',
        outcome: 'failed',
        runId: registration.runId,
        attempt: registration.attempt,
        sandboxId: registration.sandboxId,
        reason: 'cleanup_failed',
      },
    ]);
  });

  it('rearms and records failed when Sandbox acquisition throws', async () => {
    let retryAlarmScheduled = false;
    const events: OperationalLogEvent[] = [];
    const state: LeaseDurableObjectState = {
      storage: {
        get: async <A>(_key: string) => registration as A,
        put: async () => {},
        delete: async () => true,
        setAlarm: async () => {
          retryAlarmScheduled = true;
        },
        deleteAlarm: async () => {},
      },
    };
    const lease = new ReviewLeaseDurableObject(
      state,
      { Sandbox: {} },
      {
        log: {
          record: async (event) => {
            events.push(event);
          },
        },
        getSandbox: async () => {
          throw new Error('Sandbox acquisition unavailable');
        },
      },
    );

    await expect(lease.alarm()).rejects.toThrow('Sandbox acquisition unavailable');
    expect(retryAlarmScheduled).toBe(true);
    expect(events).toEqual([
      {
        phase: 'lease',
        outcome: 'failed',
        runId: registration.runId,
        attempt: registration.attempt,
        sandboxId: registration.sandboxId,
        reason: 'cleanup_failed',
      },
    ]);
  });
});
