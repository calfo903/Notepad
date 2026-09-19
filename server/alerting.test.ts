// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  DEFAULT_ALERT_COOLDOWN_MS,
  alertCooldownState,
  configureAlerting,
  emitAlert,
  resetAlerting,
  setAlertSink,
  type AlertRecord,
} from './alerting';

describe('alerting', () => {
  let records: AlertRecord[] = [];
  let clock = 0;

  beforeEach(() => {
    resetAlerting();
    records = [];
    clock = 0;
    configureAlerting({ now: () => clock, sink: (record) => records.push(record) });
  });

  afterEach(() => resetAlerting());

  it('emits a structured record at error level', () => {
    emitAlert('upstream_circuit_open', { model: 'openai/gpt-4o-mini' });

    expect(records).toHaveLength(1);
    expect(records[0]).toEqual({
      level: 'error',
      event: 'alert',
      alert: 'upstream_circuit_open',
      timestamp: new Date(0).toISOString(),
      details: { model: 'openai/gpt-4o-mini' },
    });
  });

  it('has a stable shape a log-based alert can match on', () => {
    emitAlert('token_budget_exceeded');

    const line = JSON.stringify(records[0]);
    // The two fields an operator would build a matcher from.
    expect(line).toContain('"event":"alert"');
    expect(line).toContain('"level":"error"');
  });

  it('suppresses the same alert within the cooldown', () => {
    expect(emitAlert('rate_limit_store_unavailable')).toBe(true);
    expect(emitAlert('rate_limit_store_unavailable')).toBe(false);
    expect(emitAlert('rate_limit_store_unavailable')).toBe(false);

    expect(records).toHaveLength(1);
  });

  it('does not suppress a different alert name', () => {
    emitAlert('rate_limit_store_unavailable');
    emitAlert('upstream_circuit_open');

    expect(records.map((r) => r.alert)).toEqual([
      'rate_limit_store_unavailable',
      'upstream_circuit_open',
    ]);
  });

  it('fires again once the cooldown has elapsed', () => {
    emitAlert('model_not_allowed');
    expect(records).toHaveLength(1);

    clock += DEFAULT_ALERT_COOLDOWN_MS - 1;
    expect(emitAlert('model_not_allowed')).toBe(false);

    clock += 1;
    expect(emitAlert('model_not_allowed')).toBe(true);
    expect(records).toHaveLength(2);
  });

  it('honours a configured cooldown', () => {
    configureAlerting({ cooldownMs: 100 });

    emitAlert('oversized_request_rejected');
    clock += 99;
    expect(emitAlert('oversized_request_rejected')).toBe(false);

    clock += 1;
    expect(emitAlert('oversized_request_rejected')).toBe(true);
  });

  it('falls back to the default sink when the configured one throws', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    setAlertSink(() => {
      throw new Error('sink exploded');
    });

    // Must not throw: a broken sink cannot be allowed to break the request path.
    expect(() => emitAlert('upstream_circuit_open', { traceId: 't1' })).not.toThrow();

    const printed = log.mock.calls[0]?.[0] as string;
    expect(printed).toContain('"alert":"upstream_circuit_open"');
    expect(printed).toContain('"traceId":"t1"');

    log.mockRestore();
  });

  it('does not recurse when the default sink itself throws', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {
      throw new Error('stdout is gone');
    });
    setAlertSink(() => {
      throw new Error('sink exploded');
    });

    expect(() => emitAlert('model_not_allowed')).not.toThrow();

    log.mockRestore();
  });

  it('exposes cooldown state for inspection', () => {
    emitAlert('token_budget_exceeded');

    expect(alertCooldownState().get('token_budget_exceeded')).toBe(0);
    expect(alertCooldownState().has('upstream_circuit_open')).toBe(false);
  });

  it('reset clears suppression so tests do not leak into each other', () => {
    emitAlert('upstream_circuit_open');
    expect(emitAlert('upstream_circuit_open')).toBe(false);

    resetAlerting();
    configureAlerting({ now: () => clock, sink: (record) => records.push(record) });

    expect(emitAlert('upstream_circuit_open')).toBe(true);
    expect(records).toHaveLength(2);
  });
});
