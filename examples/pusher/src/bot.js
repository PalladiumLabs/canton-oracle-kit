// Copyright 2026 Sats Labs Inc. (d/b/a Palladium Labs)
// SPDX-License-Identifier: Apache-2.0

/**
 * The push loop. Every poll, for each feed: fetch the latest signed report, run the deviation gate,
 * and push through `ChainlinkPriceFeeder.PushVerifiedPrice` when it says so.
 *
 * DEVIATION GATE + HEARTBEAT: a push happens only when the price moved at least the feed's threshold
 * from the last price this pusher activated, or when the heartbeat elapsed. The heartbeat MUST be
 * shorter than the store's maxStalenessSeconds: a skip never advances the stored observation
 * timestamp, and once that ages past the bound every strict read (`GetPrice`) aborts.
 *
 * "Not newer than the stored price" aborts mean Data Streams had no fresher report. They are a skip
 * and NOT a refresh: lastPushAt keeps aging, so a feed that is genuinely frozen trips the staleness
 * alert instead of hiding behind a benign skip.
 *
 * STALENESS ALERTS (see decide.evaluateStaleness): fetch liveness and on-chain refresh age, plus an
 * immediate critical alert when a heartbeat push fails outright.
 *
 * Run exactly ONE pusher per store: every push consumes the store contract, so two writers contend.
 */
const { decidePush, applyPushResult, evaluateStaleness } = require('./decide');
const { newFeedState } = require('./state');
const { pushFeed: defaultPushFeed, isNotNewerError } = require('./oracle');

function minutes(ms) {
  return Number.isFinite(ms) ? Math.round(ms / 60000) : null;
}

/**
 * deps: { cfg, ledger, chainlink, notify, logger, loadState, saveState, pushFeed?, now? }
 *   loadState() -> { [feedId]: FeedState }; saveState(feeds) persists the whole map.
 */
function createBot(deps) {
  const { cfg, ledger, chainlink, notify, logger, loadState, saveState } = deps;
  const pushFeed = deps.pushFeed || ((feedId, report) => defaultPushFeed(ledger, cfg, feedId, report, { logger }));
  const clock = deps.now || Date.now;

  const persisted = loadState() || {};
  const state = {};
  for (const f of cfg.feeds) state[f.feedId] = { ...newFeedState(), ...(persisted[f.feedId] || {}) };

  let running = false;
  let timer = null;

  function persist() {
    try { saveState(state); } catch (err) { logger.error({ err: err.message }, 'Failed to save state file'); }
  }

  async function checkStaleness(feed, now) {
    const s = state[feed.feedId];
    const ev = evaluateStaleness(s, now, cfg);
    if (ev.transition === 'alert') {
      s.staleAlerted = true;
      await notify('critical', 'Oracle feed stale', {
        feed: feed.label || feed.feedId,
        feedId: feed.feedId,
        reason: ev.fetchStale ? 'no fresh report fetched' : 'on-ledger price not refreshed (push failing or feed frozen)',
        fetchAgeMin: minutes(s.lastFetchOkAt == null ? Infinity : now - s.lastFetchOkAt) ?? 'never fetched',
        pushAgeMin: s.lastPushAt == null ? 'never pushed' : minutes(now - s.lastPushAt),
        lastPrice: s.lastPrice ?? 'never pushed',
      });
      persist();
    } else if (ev.transition === 'resolve') {
      s.staleAlerted = false;
      await notify('resolved', 'Oracle feed recovered', { feed: feed.label || feed.feedId, feedId: feed.feedId, price: s.lastPrice });
      persist();
    }
  }

  async function runFeed(feed) {
    const { feedId } = feed;
    const tag = feed.label || feedId.slice(0, 12);
    const now = clock();

    // 1. Fetch once. A failure does not advance lastFetchOkAt.
    let report;
    try {
      report = await chainlink.fetchSignedReport(feedId);
      state[feedId].lastFetchOkAt = now;
    } catch (err) {
      logger.error({ feed: tag, err: err.message }, 'Report fetch failed');
      await checkStaleness(feed, now);
      return;
    }
    const newPrice = report.decoded?.price ?? null;

    // 2. Gate.
    const decision = decidePush({ feedState: state[feedId], newPrice, now, heartbeatMs: cfg.heartbeatMs, deviationBps: feed.deviationBps });
    if (!decision.push) {
      logger.debug({ feed: tag, price: newPrice, reason: decision.reason }, 'Push gated (skip)');
      persist();
      await checkStaleness(feed, now);
      return;
    }

    // 3. Push.
    try {
      const out = await pushFeed(feedId, report);
      const kind = out.outcome === 'held' ? 'held' : out.outcome === 'activated' ? 'activated' : 'unknown';
      state[feedId] = applyPushResult(state[feedId], { kind, price: out.decodedPrice ?? newPrice }, now);
      persist();
      if (kind === 'held') {
        logger.info({ feed: tag, price: newPrice, reason: decision.reason, store: out.newStoreCid, updateId: out.updateId }, 'Price held pending by the store (move > maxDeviationBps); will push again to corroborate');
      } else {
        logger.info({ feed: tag, price: newPrice, reason: decision.reason, outcome: out.outcome, store: out.newStoreCid, updateId: out.updateId }, 'Price pushed');
      }
    } catch (err) {
      if (isNotNewerError(err)) {
        state[feedId] = applyPushResult(state[feedId], { kind: 'not-newer' }, now);
        logger.info({ feed: tag, reason: decision.reason }, 'Push skipped: no report newer than the stored price (not a refresh)');
      } else {
        if (decision.heartbeat) {
          // A failing heartbeat push is the direct precursor to an on-ledger staleness breach.
          await notify('critical', 'Oracle heartbeat push FAILED; staleness breach imminent', {
            feed: tag,
            feedId,
            err: err.message.slice(0, 500),
            sinceLastPushMin: state[feedId].lastPushAt == null ? 'never pushed' : minutes(now - state[feedId].lastPushAt),
          });
        }
        logger.error({ feed: tag, err: err.message.slice(0, 1000), heartbeat: decision.heartbeat }, 'Price push failed');
      }
      persist();
    }
    await checkStaleness(feed, now);
  }

  async function runOnce() {
    if (running) return;
    running = true;
    try {
      for (const feed of cfg.feeds) {
        try {
          await runFeed(feed);
        } catch (err) {
          logger.error({ feed: feed.label || feed.feedId, err: err.message }, 'Unexpected error in feed cycle');
        }
      }
    } finally {
      running = false;
    }
  }

  function start() {
    logger.info({
      pollIntervalMs: cfg.pollIntervalMs,
      heartbeatMs: cfg.heartbeatMs,
      staleAlertMs: cfg.staleAlertMs,
      pushStaleMs: cfg.pushStaleMs,
      feeds: cfg.feeds.map((f) => ({ label: f.label, feedId: f.feedId, deviationBps: f.deviationBps })),
    }, 'Pusher started (deviation gate + heartbeat)');
    runOnce();
    timer = setInterval(runOnce, cfg.pollIntervalMs);
    return timer;
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { runOnce, start, stop, state, isRunning: () => running };
}

module.exports = { createBot };
