// Copyright 2026 Sats Labs Inc. (d/b/a Palladium Labs)
// SPDX-License-Identifier: Apache-2.0

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig, parseFeeds, timingWarnings, assertConfig } = require('../src/config');
const { predictStoreAction } = require('../src/probe');
const { FEED } = require('./helpers');

const FEED2 = `0003${'ab'.repeat(30)}`;

test('feeds parse with labels, strip 0x, and get per-feed thresholds', () => {
  const cfg = loadConfig({ FEEDS: `ETH-USD=0x${FEED.toUpperCase()}, ${FEED2}`, DEVIATION_BPS: `ETH-USD=50,${FEED2}=10`, DEFAULT_DEVIATION_BPS: '25' });
  assert.deepEqual(cfg.feeds, [
    { label: 'ETH-USD', feedId: FEED, deviationBps: 50 },
    { label: null, feedId: FEED2, deviationBps: 10 },
  ]);
});

test('non-V3 and malformed feed ids are rejected', () => {
  assert.throws(() => parseFeeds(`X=0x0002${'00'.repeat(30)}`), /not a V3/);
  assert.throws(() => parseFeeds('X=0x1234'), /32-byte/);
  assert.throws(() => parseFeeds(`A=${FEED},B=${FEED}`), /twice/);
});

test('timing has no defaults; push-stale alert derives from heartbeat and poll; testnet endpoint', () => {
  const empty = loadConfig({});
  assert.equal(empty.pollIntervalMs, null);
  assert.equal(empty.heartbeatMs, null);
  assert.equal(empty.pushStaleMs, null);
  assert.throws(() => assertConfig(empty, ['pollIntervalMs', 'heartbeatMs', 'staleAlertMs']), /POLL_INTERVAL_MS, HEARTBEAT_MS, STALE_ALERT_MS/);
  const cfg = loadConfig({ POLL_INTERVAL_MS: '30000', HEARTBEAT_MS: '600000' });
  assert.equal(cfg.pushStaleMs, 600000 + 60000);
  assert.equal(cfg.chainlink.endpoint, 'https://api.testnet-dataengine.chain.link');
  assert.equal(loadConfig({ CHAINLINK_NETWORK: 'mainnet' }).chainlink.endpoint, 'https://api.dataengine.chain.link');
});

test('heartbeat must sit below maxStalenessSeconds', () => {
  const t = { POLL_INTERVAL_MS: '30000', HEARTBEAT_MS: '600000' };
  assert.deepEqual(timingWarnings(loadConfig(t), 900), []);
  assert.equal(timingWarnings(loadConfig({ ...t, HEARTBEAT_MS: '900000' }), 900).length >= 1, true);
});

test('assertConfig names missing env vars', () => {
  assert.throws(() => assertConfig(loadConfig({ AUTH_TOKEN_URL: 'https://x' }), ['ledger.url', 'pusher']), /LEDGER_URL, PUSHER_PARTY, AUTH_CLIENT_ID, AUTH_CLIENT_SECRET/);
});

test('probe prediction mirrors the store guards', () => {
  const now = 1_700_000_100;
  const report = { price: 100, observationsTimestamp: 1_700_000_050, validFromTimestamp: 1_700_000_000, expiresAt: 1_700_086_400 };
  const base = { maxStalenessSeconds: 900, maxDeviationBps: 1000, nowSeconds: now };
  assert.equal(predictStoreAction({ ...base, report }).action, 'ACTIVATE');
  assert.equal(predictStoreAction({ ...base, report, active: { price: '100', observationsTimestamp: '1700000050.0' } }).action, 'SKIP_NOT_NEWER');
  assert.equal(predictStoreAction({ ...base, report, active: { price: '50', observationsTimestamp: '1700000000.0' } }).action, 'HOLD_PENDING');
  assert.equal(predictStoreAction({ ...base, report, active: { price: '50', observationsTimestamp: '1700000000.0' }, pending: { price: '99', observationsTimestamp: '1700000010.0' } }).action, 'ACTIVATE');
  assert.equal(predictStoreAction({ ...base, report: { ...report, expiresAt: now - 1 } }).action, 'REJECT');
});
