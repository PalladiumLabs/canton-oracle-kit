// Copyright 2026 Sats Labs Inc. (d/b/a Palladium Labs)
// SPDX-License-Identifier: Apache-2.0

/**
 * On-ledger side of the pusher: resolve the feeder and the CURRENT price store, assemble the
 * Verifier + VerifierConfig disclosure, and push a signed report through
 * `ChainlinkPriceFeeder.PushVerifiedPrice`.
 *
 * DISCLOSURE: `PushVerifiedPrice` runs `Verifier.Verify` against the Chainlink `Verifier` and
 * `VerifierConfig` pinned on the feeder. The config is owned by Chainlink's config party, and the
 * Verifier may be too (or be one we created), so both are passed as disclosed contracts on every push. The PUSHER is an observer of the
 * VerifierConfig (Verify fetches it with the pusher's authority); the operator is not and cannot see
 * it. So the blobs are fetched AS THE PUSHER, on every attempt, so a Chainlink config rotation is
 * picked up instead of being pushed stale.
 */
const {
  createdEventsOf,
  qualifiedName,
  submitWithContentionRetry,
  textMapEntries,
} = require('./ledger');
const { normFeedId } = require('./config');

const NOT_NEWER_RE = /not newer than the stored price/i;

/** The store's "observation timestamp must increase" abort: the feed had no fresher report. */
function isNotNewerError(err) {
  return NOT_NEWER_RE.test(err?.message || '');
}

function pickLatest(rows, what, logger) {
  if (rows.length > 1) {
    logger?.warn({ count: rows.length, picked: rows[rows.length - 1].contractId }, `More than one active ${what} matches; using the last one returned. Archive the others.`);
  }
  return rows[rows.length - 1] || null;
}

/**
 * The active ChainlinkPriceFeeder for (operator, pusher). Read as `party` (either is a stakeholder).
 */
async function resolveFeeder(ledger, { templateIds, operator, pusher }, { party = pusher, logger } = {}) {
  const rows = (await ledger.queryContracts(templateIds.feeder, party)).filter((c) =>
    c.createArgument?.operator === operator && (!pusher || c.createArgument?.oraclePusher === pusher));
  return pickLatest(rows, 'ChainlinkPriceFeeder', logger);
}

/** The active PriceStore for `operator` (and `pusher`, when given), or null. */
async function resolveStore(ledger, { templateIds, operator, pusher }, { party = pusher || operator, logger } = {}) {
  const rows = (await ledger.queryContracts(templateIds.store, party)).filter((c) =>
    c.createArgument?.operator === operator && (!pusher || c.createArgument?.oraclePusher === pusher));
  return pickLatest(rows, 'PriceStore', logger);
}

/**
 * The CURRENT PriceStore contract id. Every push and every RegisterFeed archives the store and
 * creates a new one, so consumers must look this up rather than cache it.
 *
 *   const cid = await currentStoreCid(ledger, { templateIds, operator, pusher }, { party });
 *
 * `party` is whoever is reading: any stakeholder (the operator or the pusher). Returns null if no
 * store is active.
 */
async function currentStoreCid(ledger, ids, opts = {}) {
  const store = await resolveStore(ledger, ids, opts);
  return store?.contractId || null;
}

/** Fetch the feeder's pinned Verifier + VerifierConfig as disclosed contracts, AS `party`. */
async function fetchVerifierDisclosure(ledger, feeder, party) {
  const { verifierCid, verifierConfigCid } = feeder.createArgument || {};
  if (!verifierCid || !verifierConfigCid) {
    throw new Error('Feeder is missing verifierCid/verifierConfigCid; cannot assemble disclosure');
  }
  return Promise.all([
    ledger.fetchDisclosedContract(verifierCid, party),
    ledger.fetchDisclosedContract(verifierConfigCid, party),
  ]);
}

/**
 * Classify what the store did with a pushed report, from the new store's create arguments:
 *   'activated' — prices[feedId] now carries this report's observation timestamp;
 *   'held'      — the move exceeded maxDeviationBps and went to pendingPrices; the old price is
 *                 still served and its timestamp did NOT advance;
 *   'unknown'   — the new store was not in the transaction result, or the report was not decodable.
 */
function classifyPushOutcome(newStoreArg, feedId, observationsTimestamp) {
  if (!newStoreArg || observationsTimestamp == null) return 'unknown';
  const id = normFeedId(feedId);
  const find = (tm) => textMapEntries(tm).find(([k]) => normFeedId(k) === id)?.[1];
  const sameTs = (pd) => pd != null && Number(pd.observationsTimestamp) === Number(observationsTimestamp);
  if (sameTs(find(newStoreArg.prices))) return 'activated';
  if (sameTs(find(newStoreArg.pendingPrices))) return 'held';
  return 'unknown';
}

/**
 * Push a signed report for one feed. Re-resolves the feeder, the current store and both disclosure
 * blobs on every contention retry. Throws the ledger error on failure; callers treat
 * `isNotNewerError(err)` as a benign skip.
 *
 * Returns { feedId, decodedPrice, newStoreCid, outcome, updateId }.
 */
async function pushFeed(ledger, cfg, feedId, report, { logger } = {}) {
  const storeQName = qualifiedName(cfg.templateIds.store);
  return submitWithContentionRetry(async () => {
    const feeder = await resolveFeeder(ledger, cfg, { party: cfg.pusher, logger });
    if (!feeder) throw new Error(`No active ChainlinkPriceFeeder for operator ${cfg.operator} / pusher ${cfg.pusher}`);
    const store = await resolveStore(ledger, cfg, { party: cfg.pusher, logger });
    if (!store) throw new Error(`No active PriceStore for operator ${cfg.operator} / pusher ${cfg.pusher}`);

    const disclosed = await fetchVerifierDisclosure(ledger, feeder, cfg.pusher);

    const result = await ledger.submitCommand(
      [{
        ExerciseCommand: {
          templateId: cfg.templateIds.feeder,
          contractId: feeder.contractId,
          choice: 'PushVerifiedPrice',
          choiceArgument: {
            // A PriceStore cid is a valid ContractId VerifiedPriceSink (the store implements it).
            sinkCid: store.contractId,
            signedReportBytes: report.fullReport,
          },
        },
      }],
      [cfg.pusher],
      disclosed,
    );

    const created = createdEventsOf(result, storeQName).slice(-1)[0] || null;
    return {
      feedId: normFeedId(feedId),
      decodedPrice: report.decoded?.price ?? null,
      newStoreCid: created?.contractId || null,
      outcome: classifyPushOutcome(created?.createArgument, feedId, report.decoded?.observationsTimestamp),
      updateId: result?.transaction?.updateId || result?.updateId || null,
    };
  }, { label: `PushVerifiedPrice:${normFeedId(feedId).slice(0, 12)}`, logger });
}

module.exports = {
  resolveFeeder,
  resolveStore,
  currentStoreCid,
  fetchVerifierDisclosure,
  pushFeed,
  classifyPushOutcome,
  isNotNewerError,
};
