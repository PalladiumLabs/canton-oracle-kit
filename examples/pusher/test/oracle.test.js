// Copyright 2026 Sats Labs Inc. (d/b/a Palladium Labs)
// SPDX-License-Identifier: Apache-2.0

const test = require('node:test');
const assert = require('node:assert/strict');
const { pushFeed, classifyPushOutcome, currentStoreCid, isNotNewerError } = require('../src/oracle');
const { loadConfig } = require('../src/config');
const { FEED } = require('./helpers');

const cfg = loadConfig({ OPERATOR_PARTY: 'op::1', PUSHER_PARTY: 'push::1', FEEDS: `ETH-USD=0x${FEED}` });

function fakeLedger() {
  const calls = { submits: [], disclosed: [] };
  let storeCid = 'store-1';
  const ledger = {
    calls,
    queryContracts: async (tid, party) => {
      calls.lastQueryParty = party;
      if (tid === cfg.templateIds.feeder) {
        return [{ contractId: 'feeder-1', templateId: 'pkg:Palladium.Oracle.Chainlink:ChainlinkPriceFeeder', createArgument: { operator: 'op::1', oraclePusher: 'push::1', verifierCid: 'v-1', verifierConfigCid: 'vc-1' } }];
      }
      return [
        { contractId: 'other-store', createArgument: { operator: 'someone-else', oraclePusher: 'push::1' } },
        { contractId: storeCid, createArgument: { operator: 'op::1', oraclePusher: 'push::1', prices: {}, pendingPrices: {} } },
      ];
    },
    fetchDisclosedContract: async (cid, party) => { calls.disclosed.push({ cid, party }); return { contractId: cid, templateId: 'x:A:B', createdEventBlob: 'blob', synchronizerId: 's' }; },
    submitCommand: async (commands, actAs, disclosed) => {
      calls.submits.push({ commands, actAs, disclosed });
      storeCid = 'store-2';
      return {
        transaction: {
          updateId: 'u-1',
          events: [
            { ArchivedEvent: { contractId: 'store-1' } },
            { CreatedEvent: { contractId: 'store-2', templateId: 'abc123:Palladium.Oracle.PriceStore:PriceStore', createArgument: { prices: { [FEED]: { price: '100.0', observationsTimestamp: '1700000000.0' } }, pendingPrices: {} } } },
          ],
        },
      };
    },
  };
  return ledger;
}

test('config uses the PriceStore and ChainlinkPriceFeeder template names', () => {
  assert.equal(cfg.templateIds.store, '#oracle-price-store:Palladium.Oracle.PriceStore:PriceStore');
  assert.equal(cfg.templateIds.feeder, '#oracle-chainlink:Palladium.Oracle.Chainlink:ChainlinkPriceFeeder');
});

test('pushFeed exercises PushVerifiedPrice as the pusher, with both blobs fetched as the pusher', async () => {
  const ledger = fakeLedger();
  const out = await pushFeed(ledger, cfg, FEED, { fullReport: '0xabc', decoded: { price: 100, observationsTimestamp: 1700000000 } });
  const [sub] = ledger.calls.submits;
  assert.deepEqual(sub.actAs, ['push::1']);
  const ex = sub.commands[0].ExerciseCommand;
  assert.equal(ex.choice, 'PushVerifiedPrice');
  assert.equal(ex.contractId, 'feeder-1');
  assert.deepEqual(ex.choiceArgument, { sinkCid: 'store-1', signedReportBytes: '0xabc' });
  assert.deepEqual(ledger.calls.disclosed.map((d) => d.party), ['push::1', 'push::1']);
  assert.deepEqual(ledger.calls.disclosed.map((d) => d.cid).sort(), ['v-1', 'vc-1']);
  assert.equal(sub.disclosed.length, 2);
  assert.equal(out.newStoreCid, 'store-2');
  assert.equal(out.outcome, 'activated');
  assert.equal(out.updateId, 'u-1');
});

test('currentStoreCid filters by operator and returns the live cid', async () => {
  const ledger = fakeLedger();
  assert.equal(await currentStoreCid(ledger, cfg, { party: 'op::1' }), 'store-1');
  assert.equal(ledger.calls.lastQueryParty, 'op::1');
});

test('classifyPushOutcome distinguishes activated / held / unknown', () => {
  const pd = { price: '1.0', observationsTimestamp: '1700000000.0000000000' };
  assert.equal(classifyPushOutcome({ prices: { [FEED]: pd }, pendingPrices: {} }, FEED, 1700000000), 'activated');
  assert.equal(classifyPushOutcome({ prices: { [FEED]: { ...pd, observationsTimestamp: '1699990000.0' } }, pendingPrices: { [FEED]: pd } }, `0x${FEED}`, 1700000000), 'held');
  assert.equal(classifyPushOutcome(null, FEED, 1700000000), 'unknown');
  assert.equal(classifyPushOutcome({ prices: {}, pendingPrices: {} }, FEED, null), 'unknown');
});

test('isNotNewerError matches the store abort text', () => {
  assert.equal(isNotNewerError(new Error('Report is not newer than the stored price (observation timestamp must increase)')), true);
  assert.equal(isNotNewerError(new Error('Price report is stale')), false);
});
