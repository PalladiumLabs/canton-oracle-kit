// Copyright 2026 Sats Labs Inc. (d/b/a Palladium Labs)
// SPDX-License-Identifier: Apache-2.0

/**
 * Library entry point.
 *
 *   const { loadConfig, createLedgerClient, currentStoreCid } = require('@palladiumlabs/canton-oracle-pusher');
 *   const cfg = loadConfig(process.env);
 *   const ledger = createLedgerClient(cfg.ledger);
 *   const storeCid = await currentStoreCid(ledger, cfg, { party: cfg.operator });
 */
const config = require('./config');
const ledger = require('./ledger');
const chainlink = require('./chainlink');
const oracle = require('./oracle');
const decide = require('./decide');
const { createBot } = require('./bot');
const { runProbe, predictStoreAction } = require('./probe');
const { runSetup } = require('./setup');
const { createLogger, silentLogger } = require('./log');
const { createNotifier } = require('./notify');
const state = require('./state');

module.exports = {
  ...config,
  ...ledger,
  ...chainlink,
  ...oracle,
  ...decide,
  ...state,
  createBot,
  runProbe,
  predictStoreAction,
  runSetup,
  createLogger,
  silentLogger,
  createNotifier,
};
