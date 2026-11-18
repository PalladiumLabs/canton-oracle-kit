// Copyright 2026 Sats Labs Inc. (d/b/a Palladium Labs)
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure push-decision and state-transition logic. No I/O, so it is unit-tested directly.
 *
 * The baseline is the last price THIS PUSHER ACTIVATED (persisted), not an on-ledger read: the store's
 * read choices abort once a price is stale, which is exactly the window this logic manages.
 */

/**
 * Decide whether to push this cycle. Push when:
 *   - there is no baseline yet (first price, or no state file);
 *   - the report could not be decoded (fail open: never risk staleness over a decode miss);
 *   - the heartbeat elapsed since the last on-ledger refresh;
 *   - the feed has no deviation gate (deviationBps 0);
 *   - the price moved at least deviationBps from the baseline.
 * Otherwise skip and leave the on-ledger price as it is.
 *
 * Returns { push, heartbeat, reason }.
 */
function decidePush({ feedState: s, newPrice, now, heartbeatMs, deviationBps }) {
  if (s.lastPrice == null) return { push: true, heartbeat: false, reason: 'first price' };
  if (newPrice == null) return { push: true, heartbeat: false, reason: 'undecodable report (fail-open)' };
  const sinceLastPush = s.lastPushAt == null ? Infinity : now - s.lastPushAt;
  if (sinceLastPush >= heartbeatMs) return { push: true, heartbeat: true, reason: 'heartbeat' };
  if (!(deviationBps > 0)) return { push: true, heartbeat: false, reason: 'no deviation gate' };
  const movedBps = s.lastPrice > 0 ? (Math.abs(newPrice - s.lastPrice) / s.lastPrice) * 10000 : Infinity;
  const fmt = (bps) => `${(bps / 100).toFixed(3)}%`;
  return movedBps >= deviationBps
    ? { push: true, heartbeat: false, reason: `moved ${fmt(movedBps)} >= ${fmt(deviationBps)}` }
    : { push: false, heartbeat: false, reason: `moved ${fmt(movedBps)} < ${fmt(deviationBps)}` };
}

/**
 * Apply the result of a push attempt to a feed's state. Returns the NEW state (does not mutate).
 *
 *   kind 'activated' | 'unknown' — the stored price was refreshed: advance lastPushAt, move the
 *        baseline to the pushed price. ('unknown' = the result could not be classified; treated as a
 *        refresh, so an unclassified success never looks like an outage.)
 *   kind 'held'     — the store put the report in pendingPrices (move > maxDeviationBps). The
 *        served price and its timestamp did NOT change, so this is NOT a refresh and the baseline
 *        stays put: the next cycle sees the same large move and pushes again, which corroborates and
 *        activates it, instead of waiting for the heartbeat.
 *   kind 'not-newer' — the store aborted with "not newer than the stored price": the feed had no
 *        fresher report. Nothing changed on-ledger, so it is a skip that does NOT count as a refresh;
 *        lastPushAt keeps aging so a frozen feed trips the staleness alert.
 *   kind 'failed'   — nothing changes.
 */
function applyPushResult(s, { kind, price = null }, now) {
  switch (kind) {
    case 'activated':
    case 'unknown':
      return { ...s, lastPushAt: now, lastSuccessAt: now, lastPrice: price ?? s.lastPrice };
    case 'held':
      return { ...s, lastSuccessAt: now };
    case 'not-newer':
    case 'failed':
      return { ...s };
    default:
      throw new Error(`unknown push result kind: ${kind}`);
  }
}

/**
 * Two independent staleness signals, so that a deliberate skip never looks like an outage:
 *   fetchStale — no report fetched for staleAlertMs (pusher dead, Data Streams down, network);
 *   pushStale  — the stored price has not been refreshed for pushStaleMs (heartbeat push failing, or
 *                the feed is frozen). Only judged once this pusher has refreshed at least once.
 * Returns { stale, fetchStale, pushStale, transition: 'alert' | 'resolve' | null }.
 */
function evaluateStaleness(s, now, { staleAlertMs, pushStaleMs }) {
  const fetchAge = s.lastFetchOkAt == null ? Infinity : now - s.lastFetchOkAt;
  const fetchStale = fetchAge > staleAlertMs;
  const pushStale = s.lastPushAt != null && now - s.lastPushAt > pushStaleMs;
  const stale = fetchStale || pushStale;
  let transition = null;
  if (stale && !s.staleAlerted) transition = 'alert';
  else if (!stale && s.staleAlerted) transition = 'resolve';
  return { stale, fetchStale, pushStale, transition };
}

module.exports = { decidePush, applyPushResult, evaluateStaleness };
