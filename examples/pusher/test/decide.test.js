// Copyright 2026 Sats Labs Inc. (d/b/a Palladium Labs)
// SPDX-License-Identifier: Apache-2.0

const test = require('node:test');
const assert = require('node:assert/strict');
const { decidePush, applyPushResult, evaluateStaleness } = require('../src/decide');
const { newFeedState } = require('../src/state');

const HB = 750_000; // arbitrary test value
const T0 = 1_700_000_000_000;
const base = (o = {}) => ({ ...newFeedState(), lastPrice: 100, lastPushAt: T0, lastFetchOkAt: T0, ...o });
const d = (feedState, newPrice, now, deviationBps = 50) => decidePush({ feedState, newPrice, now, heartbeatMs: HB, deviationBps });

test('first price always pushes', () => {
  assert.deepEqual(d(newFeedState(), 100, T0), { push: true, heartbeat: false, reason: 'first price' });
});

test('undecodable report fails open', () => {
  assert.equal(d(base(), null, T0 + 1000).push, true);
});

test('move below the gate skips', () => {
  const r = d(base(), 100.4, T0 + 60_000); // 40 bps < 50 bps
  assert.equal(r.push, false);
  assert.equal(r.heartbeat, false);
});

test('move at or above the gate pushes', () => {
  assert.equal(d(base(), 100.5, T0 + 60_000).push, true); // exactly 50 bps
  assert.equal(d(base(), 99, T0 + 60_000).push, true); // 100 bps down
});

test('heartbeat forces a push in a flat market', () => {
  assert.equal(d(base(), 100, T0 + HB - 1).push, false);
  const r = d(base(), 100, T0 + HB);
  assert.equal(r.push, true);
  assert.equal(r.heartbeat, true);
});

test('heartbeat fires when this pusher never refreshed but has a baseline', () => {
  assert.equal(d(base({ lastPushAt: null }), 100, T0).heartbeat, true);
});

test('deviationBps 0 means push every cycle', () => {
  const r = d(base(), 100, T0 + 1, 0);
  assert.equal(r.push, true);
  assert.equal(r.reason, 'no deviation gate');
});

test('activated push is a refresh and moves the baseline', () => {
  const s = applyPushResult(base(), { kind: 'activated', price: 101 }, T0 + 5000);
  assert.equal(s.lastPushAt, T0 + 5000);
  assert.equal(s.lastSuccessAt, T0 + 5000);
  assert.equal(s.lastPrice, 101);
});

test('"not newer than stored price" is a skip that does NOT count as a refresh', () => {
  const before = base({ lastSuccessAt: T0 });
  const after = applyPushResult(before, { kind: 'not-newer' }, T0 + HB);
  assert.equal(after.lastPushAt, T0, 'lastPushAt must not advance');
  assert.equal(after.lastSuccessAt, T0);
  assert.equal(after.lastPrice, 100);
  // so the heartbeat stays due and keeps being retried next cycle
  assert.equal(d(after, 100, T0 + HB + 30_000).heartbeat, true);
  // and a frozen feed eventually trips the refresh alert
  const ev = evaluateStaleness({ ...after, lastFetchOkAt: T0 + HB + 75_000 }, T0 + HB + 75_000, { staleAlertMs: 900_000, pushStaleMs: HB + 60_000 });
  assert.equal(ev.pushStale, true);
  assert.equal(ev.transition, 'alert');
});

test('held (pending) push is not a refresh and keeps the baseline, so the next cycle corroborates', () => {
  const after = applyPushResult(base(), { kind: 'held', price: 150 }, T0 + 60_000);
  assert.equal(after.lastPushAt, T0);
  assert.equal(after.lastPrice, 100);
  assert.equal(after.lastSuccessAt, T0 + 60_000);
  assert.equal(d(after, 150, T0 + 180_000).push, true);
});

test('failed push changes nothing', () => {
  const s = base();
  assert.deepEqual(applyPushResult(s, { kind: 'failed' }, T0 + 1), s);
});

test('staleness: fetch liveness and refresh age are independent, with alert/resolve transitions', () => {
  const opts = { staleAlertMs: 900_000, pushStaleMs: HB + 60_000 };
  const healthy = base();
  assert.equal(evaluateStaleness(healthy, T0 + 1000, opts).transition, null);
  const fetchStale = evaluateStaleness(base({ lastFetchOkAt: T0 - 3_600_001, lastPushAt: T0 }), T0, opts);
  assert.equal(fetchStale.fetchStale, true);
  assert.equal(fetchStale.pushStale, false);
  assert.equal(fetchStale.transition, 'alert');
  assert.equal(evaluateStaleness(base({ staleAlerted: true }), T0 + 1000, opts).transition, 'resolve');
  // before the first refresh, refresh age is not judged
  assert.equal(evaluateStaleness(base({ lastPushAt: null }), T0 + 10 * HB, { ...opts, staleAlertMs: Infinity }).pushStale, false);
});
