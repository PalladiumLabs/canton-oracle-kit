// Copyright 2026 Sats Labs Inc. (d/b/a Palladium Labs)
// SPDX-License-Identifier: Apache-2.0

const test = require('node:test');
const assert = require('node:assert/strict');
const { createBot } = require('../src/bot');
const { silentLogger } = require('../src/log');
const { FEED } = require('./helpers');

const HB = 750_000; // arbitrary test value
const T0 = 1_700_000_000_000;

function harness({ persisted = {}, price = 100, pushImpl, deviationBps = 50 } = {}) {
  const alerts = [];
  const saves = [];
  let now = T0;
  const cfg = {
    feeds: [{ label: 'ETH-USD', feedId: FEED, deviationBps }],
    heartbeatMs: HB,
    pollIntervalMs: 30_000,
    staleAlertMs: 900_000,
    pushStaleMs: HB + 60_000,
  };
  const pushes = [];
  const bot = createBot({
    cfg,
    ledger: {},
    chainlink: { fetchSignedReport: async () => ({ fullReport: '0x00', decoded: { price: typeof price === 'function' ? price() : price, observationsTimestamp: now / 1000 } }) },
    notify: async (severity, title, fields) => { alerts.push({ severity, title, fields }); },
    logger: silentLogger,
    loadState: () => persisted,
    saveState: (feeds) => saves.push(JSON.parse(JSON.stringify(feeds))),
    pushFeed: async (feedId, report) => { pushes.push({ feedId, report }); return pushImpl(feedId, report); },
    now: () => now,
  });
  return { bot, alerts, saves, pushes, setNow: (t) => { now = t; } };
}

const notNewer = async () => { throw new Error('Ledger error 400: ... Report is not newer than the stored price (observation timestamp must increase)'); };
const activated = async (_f, r) => ({ outcome: 'activated', decodedPrice: r.decoded.price, newStoreCid: '00new' });

test('first cycle pushes and records a refresh', async () => {
  const h = harness({ pushImpl: activated });
  await h.bot.runOnce();
  assert.equal(h.pushes.length, 1);
  const s = h.bot.state[FEED];
  assert.equal(s.lastPushAt, T0);
  assert.equal(s.lastPrice, 100);
  assert.equal(s.lastFetchOkAt, T0);
  assert.ok(h.saves.length >= 1);
  assert.equal(h.alerts.length, 0);
});

test('not-newer abort on heartbeat is a benign skip: no refresh, no heartbeat-failure alert', async () => {
  const persisted = { [FEED]: { lastPrice: 100, lastPushAt: T0 - HB, lastSuccessAt: T0 - HB, lastFetchOkAt: T0 - 30_000, staleAlerted: false } };
  const h = harness({ persisted, pushImpl: notNewer });
  await h.bot.runOnce();
  assert.equal(h.pushes.length, 1, 'heartbeat push attempted');
  assert.equal(h.bot.state[FEED].lastPushAt, T0 - HB, 'lastPushAt unchanged');
  assert.equal(h.bot.state[FEED].lastFetchOkAt, T0);
  assert.equal(h.alerts.length, 0);

  // Feed stays frozen: next cycles keep retrying and eventually the refresh alert fires.
  h.setNow(T0 + 75_000);
  await h.bot.runOnce();
  assert.equal(h.pushes.length, 2);
  assert.equal(h.alerts.length, 1);
  assert.equal(h.alerts[0].severity, 'critical');
  assert.match(h.alerts[0].fields.reason, /not refreshed/);
});

test('a heartbeat push that fails for real pages immediately', async () => {
  const persisted = { [FEED]: { lastPrice: 100, lastPushAt: T0 - HB, lastFetchOkAt: T0 - 30_000 } };
  const h = harness({ persisted, pushImpl: async () => { throw new Error('Ledger error 400: DAML_AUTHORIZATION_ERROR'); } });
  await h.bot.runOnce();
  assert.equal(h.alerts.length, 1);
  assert.match(h.alerts[0].title, /heartbeat push FAILED/);
  assert.equal(h.bot.state[FEED].lastPushAt, T0 - HB);
});

test('small move inside the heartbeat is gated (no push)', async () => {
  const persisted = { [FEED]: { lastPrice: 100, lastPushAt: T0 - 60_000, lastFetchOkAt: T0 - 30_000 } };
  const h = harness({ persisted, price: 100.1, pushImpl: activated });
  await h.bot.runOnce();
  assert.equal(h.pushes.length, 0);
  assert.equal(h.bot.state[FEED].lastFetchOkAt, T0);
});

test('held push keeps the baseline so the next cycle pushes again', async () => {
  const persisted = { [FEED]: { lastPrice: 100, lastPushAt: T0 - 60_000, lastFetchOkAt: T0 - 30_000 } };
  let n = 0;
  const h = harness({ persisted, price: 150, pushImpl: async (_f, r) => ({ outcome: n++ === 0 ? 'held' : 'activated', decodedPrice: r.decoded.price }) });
  await h.bot.runOnce();
  assert.equal(h.bot.state[FEED].lastPrice, 100);
  h.setNow(T0 + 30_000);
  await h.bot.runOnce();
  assert.equal(h.pushes.length, 2);
  assert.equal(h.bot.state[FEED].lastPrice, 150);
  assert.equal(h.bot.state[FEED].lastPushAt, T0 + 30_000);
});

test('stale alert resolves after recovery', async () => {
  const persisted = { [FEED]: { lastPrice: 100, lastPushAt: T0 - HB - 75_000, lastFetchOkAt: T0 - 30_000, staleAlerted: true } };
  const h = harness({ persisted, pushImpl: activated });
  await h.bot.runOnce();
  assert.equal(h.alerts.length, 1);
  assert.equal(h.alerts[0].severity, 'resolved');
  assert.equal(h.bot.state[FEED].staleAlerted, false);
});
