// Copyright 2026 Sats Labs Inc. (d/b/a Palladium Labs)
// SPDX-License-Identifier: Apache-2.0

/**
 * Read-only preflight. Exercises every dependency the push path needs (Chainlink credentials, ledger
 * auth, feeder and store resolution, disclosure as the pusher) WITHOUT submitting anything, then
 * predicts what a push would do right now for each feed, per the store's guards.
 *
 * Returns true when every hard check passed.
 */
const { timingWarnings } = require('./config');
const { textMapEntries } = require('./ledger');
const { resolveFeeder, resolveStore, fetchVerifierDisclosure } = require('./oracle');

const short = (s, n = 20) => (s && s.length > n ? `${s.slice(0, n)}…` : String(s));

/**
 * Mirror of the store's write path for one report: the RecordVerifiedPrice guards, then
 * decidePriceUpdate. Returns { action, detail } with action one of
 * ACTIVATE | HOLD_PENDING | SKIP_NOT_NEWER | REJECT.
 */
function predictStoreAction({ report, active, pending, maxStalenessSeconds, maxDeviationBps, nowSeconds }) {
  if (!report) return { action: 'UNKNOWN', detail: 'no decoded report' };
  const { price, observationsTimestamp: ts, validFromTimestamp, expiresAt } = report;
  if (validFromTimestamp != null && validFromTimestamp > nowSeconds) return { action: 'REJECT', detail: 'report not yet valid (validFromTimestamp in the future)' };
  if (expiresAt != null && nowSeconds > expiresAt) return { action: 'REJECT', detail: 'report expired' };
  if (!(price > 0)) return { action: 'REJECT', detail: 'price must be positive' };
  const age = nowSeconds - ts;
  if (age < 0 || age > maxStalenessSeconds) return { action: 'REJECT', detail: `observation age ${Math.round(age)}s outside [0, ${maxStalenessSeconds}]` };
  if (active && !(ts > Number(active.observationsTimestamp))) {
    return { action: 'SKIP_NOT_NEWER', detail: `report obsTs ${ts} not newer than stored ${Number(active.observationsTimestamp)} (benign, not a refresh)` };
  }
  if (!active) return { action: 'ACTIVATE', detail: 'first price for this feed' };
  const within = (oldP, newP) => oldP <= 0 || (Math.abs(newP - oldP) / oldP) * 10000 <= maxDeviationBps;
  const activeP = Number(active.price);
  const movePct = activeP > 0 ? ((Math.abs(price - activeP) / activeP) * 100).toFixed(3) : '∞';
  if (within(activeP, price)) return { action: 'ACTIVATE', detail: `move ${movePct}% within ${maxDeviationBps / 100}% (${activeP} -> ${price})` };
  if (pending) {
    const pAge = nowSeconds - Number(pending.observationsTimestamp);
    if (pAge >= 0 && pAge <= maxStalenessSeconds && within(Number(pending.price), price)) {
      return { action: 'ACTIVATE', detail: `move ${movePct}% corroborated by the fresh pending price ${Number(pending.price)}` };
    }
  }
  return { action: 'HOLD_PENDING', detail: `move ${movePct}% > ${maxDeviationBps / 100}%; held until a second report corroborates (${activeP} -> ${price})` };
}

async function runProbe({ cfg, ledger, chainlink, out = console }) {
  let hardFail = false;
  const fail = (m) => { hardFail = true; out.error(`  FAIL  ${m}`); };
  const ok = (m) => out.log(`  ok    ${m}`);
  const warn = (m) => out.log(`  WARN  ${m}`);
  const section = (t) => out.log(`\n-- ${t} ${'-'.repeat(Math.max(0, 66 - t.length))}`);
  const labelOf = new Map(cfg.feeds.map((f) => [f.feedId, f.label || f.feedId.slice(0, 12)]));

  out.log('canton-oracle-pusher probe: READ-ONLY, nothing is submitted.');

  section('CONFIG');
  out.log(`  ledger          ${cfg.ledger.url || '(unset)'}`);
  out.log(`  auth            ${cfg.ledger.auth.staticToken ? 'static token' : cfg.ledger.auth.tokenUrl ? `client-credentials @ ${cfg.ledger.auth.tokenUrl}` : 'none'}`);
  out.log(`  operator        ${cfg.operator || '(unset)'}`);
  out.log(`  pusher          ${cfg.pusher || '(unset)'}`);
  out.log(`  store template  ${cfg.templateIds.store}`);
  out.log(`  feeder template ${cfg.templateIds.feeder}`);
  out.log(`  chainlink       ${cfg.chainlink.endpoint}`);
  out.log(`  poll/heartbeat  ${cfg.pollIntervalMs}ms / ${cfg.heartbeatMs}ms`);
  out.log(`  state file      ${cfg.stateFile}`);
  for (const f of cfg.feeds) out.log(`  feed            ${labelOf.get(f.feedId)}  ${f.feedId}  gate=${f.deviationBps}bps`);
  for (const k of ['operator', 'pusher']) if (!cfg[k]) fail(`${k === 'operator' ? 'OPERATOR_PARTY' : 'PUSHER_PARTY'} is not set`);
  if (!cfg.feeds.length) fail('FEEDS is empty');

  section('CHAINLINK Data Streams (latest signed report per feed)');
  const latest = {};
  for (const f of cfg.feeds) {
    try {
      const r = await chainlink.fetchSignedReport(f.feedId);
      latest[f.feedId] = r.decoded;
      if (r.decoded) {
        const ageS = Math.round(Date.now() / 1000 - r.decoded.observationsTimestamp);
        ok(`${labelOf.get(f.feedId)}  price=${r.decoded.price}  obsTs=${r.decoded.observationsTimestamp} (${ageS}s ago)  expiresAt=${r.decoded.expiresAt}`);
        if (r.decoded.feedId && r.decoded.feedId !== f.feedId) fail(`${labelOf.get(f.feedId)}: report carries feedId ${r.decoded.feedId}`);
      } else {
        warn(`${labelOf.get(f.feedId)}  fullReport received but could not be decoded locally`);
      }
    } catch (e) {
      fail(`${labelOf.get(f.feedId)} report fetch failed: ${e.message}`);
      latest[f.feedId] = null;
    }
  }

  section('LEDGER auth');
  let authed = false;
  try {
    const token = await ledger.getToken();
    ok(token ? `token acquired (${token.length} chars, not printed)` : 'no auth configured (sending no Authorization header)');
    await ledger.fetchLedgerEnd();
    ok('ledger-end readable');
    authed = true;
  } catch (e) {
    fail(`ledger auth/read failed: ${e.message}`);
  }

  let storeState = null;
  if (authed && cfg.operator && cfg.pusher) {
    section('FEEDER + STORE (read as the pusher)');
    try {
      const feeder = await resolveFeeder(ledger, cfg, { party: cfg.pusher, logger: { warn: (_f, m) => warn(m) } });
      const store = await resolveStore(ledger, cfg, { party: cfg.pusher, logger: { warn: (_f, m) => warn(m) } });
      if (!feeder) fail('no active ChainlinkPriceFeeder for this operator/pusher (run `setup`)');
      else ok(`feeder  ${feeder.contractId}`);
      if (!store) fail('no active PriceStore for this operator/pusher (run `setup`)');
      else ok(`store   ${store.contractId}  (changes on every push)`);

      if (store) {
        const a = store.createArgument || {};
        const maxStalenessSeconds = Number(a.maxStalenessSeconds);
        const maxDeviationBps = Number(a.maxDeviationBps);
        out.log(`  maxStalenessSeconds        ${a.maxStalenessSeconds}`);
        out.log(`  lenientMaxStalenessSeconds ${a.lenientMaxStalenessSeconds}`);
        out.log(`  maxDeviationBps            ${a.maxDeviationBps}`);
        const warnings = timingWarnings(cfg, maxStalenessSeconds);
        if (cfg.heartbeatMs == null || cfg.pollIntervalMs == null) fail('POLL_INTERVAL_MS and HEARTBEAT_MS must be set');
        else if (warnings.length) warnings.forEach(fail);
        else ok(`heartbeat ${cfg.heartbeatMs / 1000}s is below maxStalenessSeconds ${maxStalenessSeconds}s with margin`);

        const aliases = new Map(textMapEntries(a.feedAliases));
        for (const f of cfg.feeds.filter((x) => x.label)) {
          const bound = aliases.get(f.label);
          if (bound === f.feedId) ok(`label ${f.label} -> ${f.feedId}`);
          else if (bound) fail(`label ${f.label} is registered to ${bound}, not ${f.feedId} (RegisterFeed is add-only)`);
          else warn(`label ${f.label} is not registered yet (run \`setup\`)`);
        }
        const stored = new Map(textMapEntries(a.prices));
        const pending = new Map(textMapEntries(a.pendingPrices));
        for (const f of cfg.feeds) {
          const pd = stored.get(f.feedId);
          out.log(`  stored  ${labelOf.get(f.feedId)}  ${pd ? `price=${pd.price} obsTs=${pd.observationsTimestamp} updatedAt=${pd.updatedAt}` : '(none yet)'}${pending.has(f.feedId) ? '  [pending large move]' : ''}`);
        }
        storeState = { stored, pending, maxStalenessSeconds, maxDeviationBps };
      }

      if (feeder) {
        const fa = feeder.createArgument || {};
        if (store && fa.operator !== store.createArgument?.operator) fail('feeder.operator != store.operator; RecordVerifiedPrice would fail authorization');
        if (fa.oraclePusher === cfg.pusher) ok('feeder.oraclePusher matches PUSHER_PARTY');
        else fail(`feeder.oraclePusher (${fa.oraclePusher}) != PUSHER_PARTY`);
        section('DISCLOSURE (Verifier + VerifierConfig, fetched as the pusher)');
        try {
          const [v, c] = await fetchVerifierDisclosure(ledger, feeder, cfg.pusher);
          ok(`Verifier       ${short(v.contractId)}  ${v.templateId.split(':').slice(1).join(':')}  blob=${v.createdEventBlob.length} chars`);
          ok(`VerifierConfig ${short(c.contractId)}  ${c.templateId.split(':').slice(1).join(':')}  blob=${c.createdEventBlob.length} chars`);
          if (!v.synchronizerId || !c.synchronizerId) warn('a disclosed contract has no synchronizerId; set SYNCHRONIZER_ID');
          ok('PushVerifiedPrice payload assembles; only the on-ledger submit is untested');
        } catch (e) {
          fail(`disclosure failed: ${e.message}. The pusher must be an observer of the VerifierConfig; if Chainlink rotated its config, the operator must run RotateVerifier.`);
        }
      }
    } catch (e) {
      fail(`resolve failed: ${e.message}`);
    }
  }

  section('PREDICTION (what a push would do right now)');
  if (!storeState) {
    out.log('  (store unreadable; cannot predict)');
  } else {
    const nowSeconds = Date.now() / 1000;
    for (const f of cfg.feeds) {
      const p = predictStoreAction({
        report: latest[f.feedId],
        active: storeState.stored.get(f.feedId),
        pending: storeState.pending.get(f.feedId),
        maxStalenessSeconds: storeState.maxStalenessSeconds,
        maxDeviationBps: storeState.maxDeviationBps,
        nowSeconds,
      });
      out.log(`  ${labelOf.get(f.feedId)}  ${p.action}  ${p.detail}`);
    }
  }

  section('SUMMARY');
  if (hardFail) out.error('  RESULT: FAIL. Fix the FAIL items above before starting the pusher.');
  else out.log('  RESULT: PASS. Read path healthy; `start` would behave as predicted above.');
  return !hardFail;
}

module.exports = { runProbe, predictStoreAction };
