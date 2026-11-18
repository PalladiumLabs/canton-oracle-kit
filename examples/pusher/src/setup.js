// Copyright 2026 Sats Labs Inc. (d/b/a Palladium Labs)
// SPDX-License-Identifier: Apache-2.0

/**
 * Idempotent initial deployment, run as the OPERATOR:
 *   1. create the PriceStore for (operator, pusher) if none is active;
 *   2. create the ChainlinkPriceFeeder for (operator, pusher) if none is active;
 *   3. exercise ValidateVerifier (always: it is nonconsuming and must pass before pushing);
 *   4. RegisterFeed for every configured label -> feed id not yet registered.
 *
 * Run it while the pusher is stopped. Re-running it is safe: existing contracts are reused, and a
 * label already bound to the same feed is skipped. A label bound to a DIFFERENT feed is an error
 * (RegisterFeed is add-only on-ledger).
 *
 * The operator cannot see Chainlink's VerifierConfig, so the disclosure blobs for ValidateVerifier
 * are fetched as the PUSHER (`pusherLedger`).
 */
const { createdEventsOf, qualifiedName, submitWithContentionRetry, textMapEntries } = require('./ledger');
const { resolveFeeder, resolveStore, fetchVerifierDisclosure } = require('./oracle');
const { timingWarnings } = require('./config');

function validateStoreParams({ maxStalenessSeconds, lenientMaxStalenessSeconds, maxDeviationBps }) {
  const errs = [];
  if (!(maxStalenessSeconds > 0)) errs.push('STORE_MAX_STALENESS_SECONDS must be > 0');
  if (!(lenientMaxStalenessSeconds >= maxStalenessSeconds)) errs.push('STORE_LENIENT_MAX_STALENESS_SECONDS must be >= STORE_MAX_STALENESS_SECONDS');
  if (!(maxDeviationBps > 0)) errs.push('STORE_MAX_DEVIATION_BPS must be > 0');
  if (errs.length) throw new Error(`Invalid store parameters (they are immutable once created): ${errs.join('; ')}`);
}

async function runSetup({ cfg, operatorLedger, pusherLedger, logger }) {
  const { operator, pusher, templateIds } = cfg;
  const storeQ = qualifiedName(templateIds.store);
  const feederQ = qualifiedName(templateIds.feeder);
  const result = { storeCid: null, feederCid: null, created: [], registered: [], skipped: [] };

  // 1. Store.
  let store = await resolveStore(operatorLedger, cfg, { party: operator, logger });
  if (store) {
    logger.info({ storeCid: store.contractId }, 'PriceStore exists; reusing');
    const a = store.createArgument || {};
    for (const [k, want] of Object.entries(cfg.store)) {
      if (Number(a[k]) !== want) logger.warn({ field: k, onLedger: a[k], configured: want }, 'Existing store parameter differs from config (store parameters are immutable; the on-ledger value applies)');
    }
  } else {
    validateStoreParams(cfg.store);
    const res = await operatorLedger.submitCommand([{
      CreateCommand: {
        templateId: templateIds.store,
        createArguments: {
          operator,
          oraclePusher: pusher,
          prices: {},
          pendingPrices: {},
          feedAliases: {},
          maxStalenessSeconds: String(cfg.store.maxStalenessSeconds),
          lenientMaxStalenessSeconds: String(cfg.store.lenientMaxStalenessSeconds),
          maxDeviationBps: String(cfg.store.maxDeviationBps),
        },
      },
    }], [operator]);
    const ce = createdEventsOf(res, storeQ)[0];
    if (!ce) throw new Error('Store create succeeded but no PriceStore created event was returned');
    store = ce;
    result.created.push('PriceStore');
    logger.info({ storeCid: ce.contractId }, 'PriceStore created');
  }
  const maxStaleness = Number(store.createArgument?.maxStalenessSeconds ?? cfg.store.maxStalenessSeconds);
  for (const w of timingWarnings(cfg, maxStaleness)) logger.warn({}, w);

  // 2. Feeder.
  let feeder = await resolveFeeder(operatorLedger, cfg, { party: operator, logger });
  const v = cfg.verifier;
  if (feeder) {
    logger.info({ feederCid: feeder.contractId }, 'ChainlinkPriceFeeder exists; reusing');
    const a = feeder.createArgument || {};
    if ((v.verifierCid && a.verifierCid !== v.verifierCid) || (v.verifierConfigCid && a.verifierConfigCid !== v.verifierConfigCid)) {
      logger.warn({ onLedger: { verifierCid: a.verifierCid, verifierConfigCid: a.verifierConfigCid }, configured: { verifierCid: v.verifierCid, verifierConfigCid: v.verifierConfigCid } },
        'Feeder pins a different verifier pair than configured; setup does NOT rotate it. Exercise RotateVerifier as the operator if the configured pair is the current one.');
    }
    if (v.expectedConfigOwner && a.expectedConfigOwner !== v.expectedConfigOwner) {
      logger.warn({ onLedger: a.expectedConfigOwner, configured: v.expectedConfigOwner }, 'Feeder expectedConfigOwner differs from CHAINLINK_CONFIG_OWNER_PARTY');
    }
  } else {
    const missing = [['CHAINLINK_VERIFIER_CID', v.verifierCid], ['CHAINLINK_VERIFIER_CONFIG_CID', v.verifierConfigCid], ['CHAINLINK_CONFIG_OWNER_PARTY', v.expectedConfigOwner]]
      .filter(([, x]) => !x).map(([n]) => n);
    if (missing.length) throw new Error(`Creating the feeder needs: ${missing.join(', ')}`);
    const res = await operatorLedger.submitCommand([{
      CreateCommand: {
        templateId: templateIds.feeder,
        createArguments: {
          operator,
          oraclePusher: pusher,
          verifierCid: v.verifierCid,
          verifierConfigCid: v.verifierConfigCid,
          expectedConfigOwner: v.expectedConfigOwner,
        },
      },
    }], [operator]);
    const ce = createdEventsOf(res, feederQ)[0];
    if (!ce) throw new Error('Feeder create succeeded but no ChainlinkPriceFeeder created event was returned');
    feeder = ce;
    result.created.push('ChainlinkPriceFeeder');
    logger.info({ feederCid: ce.contractId }, 'ChainlinkPriceFeeder created');
  }
  result.feederCid = feeder.contractId;

  // 3. ValidateVerifier (operator controller; disclosure sourced as the pusher).
  const disclosed = await fetchVerifierDisclosure(pusherLedger, feeder, pusher);
  await operatorLedger.submitCommand([{
    ExerciseCommand: {
      templateId: templateIds.feeder,
      contractId: feeder.contractId,
      choice: 'ValidateVerifier',
      choiceArgument: {},
    },
  }], [operator], disclosed);
  logger.info({ feederCid: feeder.contractId }, 'ValidateVerifier passed');

  // 4. RegisterFeed for each label. Each one archives the store and creates a new one.
  for (const f of cfg.feeds.filter((x) => x.label)) {
    const done = await submitWithContentionRetry(async () => {
      const cur = await resolveStore(operatorLedger, cfg, { party: operator, logger });
      if (!cur) throw new Error('PriceStore disappeared during setup');
      const bound = new Map(textMapEntries(cur.createArgument?.feedAliases)).get(f.label);
      if (bound === f.feedId) return { skipped: true, storeCid: cur.contractId };
      if (bound) throw new Error(`Label ${f.label} is already registered to ${bound}; RegisterFeed is add-only and will not re-point it to ${f.feedId}`);
      const res = await operatorLedger.submitCommand([{
        ExerciseCommand: {
          templateId: templateIds.store,
          contractId: cur.contractId,
          choice: 'RegisterFeed',
          choiceArgument: { label: f.label, rawFeedId: f.feedId },
        },
      }], [operator]);
      return { skipped: false, storeCid: createdEventsOf(res, storeQ).slice(-1)[0]?.contractId || null };
    }, { label: `RegisterFeed:${f.label}`, logger });
    if (done.skipped) {
      result.skipped.push(f.label);
      logger.info({ label: f.label, feedId: f.feedId }, 'Feed already registered; skipping');
    } else {
      result.registered.push(f.label);
      logger.info({ label: f.label, feedId: f.feedId, storeCid: done.storeCid }, 'Feed registered');
    }
  }

  result.storeCid = (await resolveStore(operatorLedger, cfg, { party: operator, logger }))?.contractId || null;
  return result;
}

module.exports = { runSetup, validateStoreParams };
