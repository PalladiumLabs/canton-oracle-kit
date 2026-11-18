// Copyright 2026 Sats Labs Inc. (d/b/a Palladium Labs)
// SPDX-License-Identifier: Apache-2.0

const test = require('node:test');
const assert = require('node:assert/strict');
const { runSetup } = require('../src/setup');
const { loadConfig } = require('../src/config');
const { silentLogger } = require('../src/log');
const { FEED } = require('./helpers');

const env = {
  OPERATOR_PARTY: 'op::1', PUSHER_PARTY: 'push::1', FEEDS: `ETH-USD=0x${FEED}`,
  CHAINLINK_VERIFIER_CID: 'v-1', CHAINLINK_VERIFIER_CONFIG_CID: 'vc-1', CHAINLINK_CONFIG_OWNER_PARTY: 'cl::1',
  STORE_MAX_STALENESS_SECONDS: '900', STORE_LENIENT_MAX_STALENESS_SECONDS: '1800', STORE_MAX_DEVIATION_BPS: '500',
};

/** In-memory ledger with just enough semantics for setup: create, RegisterFeed, ValidateVerifier. */
function memLedger() {
  let n = 0;
  const acs = new Map(); // cid -> { templateId, createArgument }
  const log = [];
  const qn = (t) => t.split(':').slice(-2).join(':');
  const created = (templateId, createArgument) => {
    const contractId = `c-${++n}`;
    acs.set(contractId, { templateId, createArgument });
    return { CreatedEvent: { contractId, templateId: `pkg${qn(templateId).length}:${qn(templateId)}`, createArgument } };
  };
  return {
    log,
    acs,
    queryContracts: async (tid) => [...acs].filter(([, c]) => qn(c.templateId) === qn(tid)).map(([contractId, c]) => ({ contractId, ...c })),
    fetchDisclosedContract: async (cid, party) => { log.push(`disclose ${cid} as ${party}`); return { contractId: cid, templateId: 'x:A:B', createdEventBlob: 'b', synchronizerId: 's' }; },
    submitCommand: async ([cmd], actAs, disclosed = []) => {
      if (cmd.CreateCommand) {
        log.push(`create ${qn(cmd.CreateCommand.templateId)} as ${actAs}`);
        return { transaction: { events: [created(cmd.CreateCommand.templateId, cmd.CreateCommand.createArguments)] } };
      }
      const ex = cmd.ExerciseCommand;
      log.push(`${ex.choice} as ${actAs} disclosed=${disclosed.length}`);
      if (ex.choice === 'ValidateVerifier') return { transaction: { events: [] } };
      if (ex.choice === 'RegisterFeed') {
        const old = acs.get(ex.contractId);
        acs.delete(ex.contractId);
        const arg = { ...old.createArgument, feedAliases: { ...old.createArgument.feedAliases, [ex.choiceArgument.label]: ex.choiceArgument.rawFeedId } };
        return { transaction: { events: [created(old.templateId, arg)] } };
      }
      throw new Error(`unexpected ${ex.choice}`);
    },
  };
}

test('setup creates store + feeder, validates, registers; second run is a no-op apart from ValidateVerifier', async () => {
  const cfg = loadConfig(env);
  const op = memLedger();
  const pusher = { fetchDisclosedContract: op.fetchDisclosedContract };
  const r1 = await runSetup({ cfg, operatorLedger: op, pusherLedger: pusher, logger: silentLogger });
  assert.deepEqual(r1.created, ['PriceStore', 'ChainlinkPriceFeeder']);
  assert.deepEqual(r1.registered, ['ETH-USD']);
  assert.ok(r1.storeCid && r1.feederCid);
  assert.ok(op.log.includes('ValidateVerifier as op::1 disclosed=2'));
  assert.ok(op.log.includes('disclose vc-1 as push::1'), 'VerifierConfig is fetched as the pusher');
  const store = op.acs.get(r1.storeCid).createArgument;
  assert.equal(store.maxStalenessSeconds, '900');
  assert.deepEqual(store.prices, {});
  assert.equal(store.feedAliases['ETH-USD'], FEED);

  op.log.length = 0;
  const r2 = await runSetup({ cfg, operatorLedger: op, pusherLedger: pusher, logger: silentLogger });
  assert.deepEqual(r2.created, []);
  assert.deepEqual(r2.registered, []);
  assert.deepEqual(r2.skipped, ['ETH-USD']);
  assert.equal(r2.storeCid, r1.storeCid);
  assert.deepEqual(op.log.filter((l) => !l.startsWith('disclose')), ['ValidateVerifier as op::1 disclosed=2']);
});

test('setup refuses to re-point a label', async () => {
  const op = memLedger();
  const pusher = { fetchDisclosedContract: op.fetchDisclosedContract };
  await runSetup({ cfg: loadConfig(env), operatorLedger: op, pusherLedger: pusher, logger: silentLogger });
  const other = `0003${'cd'.repeat(30)}`;
  await assert.rejects(
    runSetup({ cfg: loadConfig({ ...env, FEEDS: `ETH-USD=${other}` }), operatorLedger: op, pusherLedger: pusher, logger: silentLogger }),
    /already registered/,
  );
});

test('setup validates store params before creating', async () => {
  const op = memLedger();
  await assert.rejects(
    runSetup({ cfg: loadConfig({ ...env, STORE_LENIENT_MAX_STALENESS_SECONDS: '10' }), operatorLedger: op, pusherLedger: op, logger: silentLogger }),
    /LENIENT/,
  );
});
