// Copyright 2026 Sats Labs Inc. (d/b/a Palladium Labs)
// SPDX-License-Identifier: Apache-2.0

/**
 * Durable per-feed state in a small local JSON file, so a restart neither re-pages an alert nor
 * forgets when the price was last refreshed. Written atomically (temp file + rename).
 *
 * File shape: { "version": 1, "feeds": { "<rawFeedId>": FeedState } }
 */
const fs = require('node:fs');
const path = require('node:path');

/** Per-feed state. Timestamps are epoch milliseconds. */
function newFeedState() {
  return {
    lastPrice: null, // last price this pusher ACTIVATED on-ledger (the deviation baseline)
    lastPushAt: null, // last time the stored active price was refreshed by this pusher
    lastSuccessAt: null, // last successful submit of any kind
    lastFetchOkAt: null, // last time a Data Streams report was fetched
    staleAlerted: false,
  };
}

function loadState(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed.feeds === 'object' && parsed.feeds ? parsed.feeds : {};
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw new Error(`Cannot read state file ${file}: ${err.message}`);
  }
}

function saveState(file, feeds) {
  const dir = path.dirname(path.resolve(file));
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, feeds }, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

module.exports = { newFeedState, loadState, saveState };
