#!/usr/bin/env node
// Copyright 2026 Sats Labs Inc. (d/b/a Palladium Labs)
// SPDX-License-Identifier: Apache-2.0

/**
 * CLI: canton-oracle-pusher <setup | probe | start | current-store>
 *
 * Reads configuration from the environment. If a `.env` file exists in the working directory (or
 * the file named by ENV_FILE), it is loaded first; variables already set in the environment win.
 */
const fs = require('node:fs');
const {
  loadConfig, assertConfig, timingWarnings, createLedgerClient, createChainlinkClient, createLogger,
  createNotifier, createBot, runProbe, runSetup, currentStoreCid, resolveStore, loadState, saveState,
} = require('../src');

const USAGE = `usage: canton-oracle-pusher <command>

  setup          create the PriceStore and ChainlinkPriceFeeder if absent, run ValidateVerifier,
                 RegisterFeed each configured label (idempotent; run as the operator)
  probe          read-only preflight: credentials, auth, contracts, disclosure, predicted push
  start          run the push loop
  current-store  print the current PriceStore contract id`;

function loadEnvFile() {
  const file = process.env.ENV_FILE || '.env';
  if (fs.existsSync(file)) process.loadEnvFile(file);
}

function ledgerFor(cfg, which = 'pusher') {
  const base = { ...cfg.ledger };
  if (which === 'operator') {
    base.url = cfg.operatorLedger.url;
    base.auth = cfg.operatorLedger.auth;
  }
  return createLedgerClient(base);
}

async function main() {
  const cmd = process.argv[2];
  if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help') {
    console.log(USAGE);
    return 0;
  }
  loadEnvFile();
  const cfg = loadConfig(process.env);
  const logger = createLogger({ level: cfg.logLevel });

  switch (cmd) {
    case 'setup': {
      assertConfig(cfg, ['ledger.url', 'operator', 'pusher', 'store.maxStalenessSeconds',
        'store.lenientMaxStalenessSeconds', 'store.maxDeviationBps'], { operatorCreds: true });
      const out = await runSetup({ cfg, operatorLedger: ledgerFor(cfg, 'operator'), pusherLedger: ledgerFor(cfg), logger });
      console.log(JSON.stringify(out, null, 2));
      return 0;
    }
    case 'probe': {
      const chainlink = createChainlinkClient(cfg.chainlink);
      let ledger;
      try {
        ledger = ledgerFor(cfg);
      } catch (e) {
        // Still run the probe so every other problem is reported too; ledger checks fail with this.
        const fail = async () => { throw e; };
        ledger = { getToken: fail, fetchLedgerEnd: fail, queryContracts: fail, fetchDisclosedContract: fail };
      }
      return (await runProbe({ cfg, ledger, chainlink })) ? 0 : 1;
    }
    case 'current-store': {
      assertConfig(cfg, ['ledger.url', 'operator']);
      const party = process.env.READ_AS_PARTY || cfg.pusher || cfg.operator;
      const cid = await currentStoreCid(ledgerFor(cfg), { templateIds: cfg.templateIds, operator: cfg.operator, pusher: cfg.pusher }, { party, logger });
      if (!cid) { console.error('No active PriceStore found'); return 1; }
      console.log(cid);
      return 0;
    }
    case 'start': {
      assertConfig(cfg, ['ledger.url', 'operator', 'pusher', 'chainlink.apiKey', 'chainlink.apiSecret', 'feeds',
        'pollIntervalMs', 'heartbeatMs', 'staleAlertMs']);
      const ledger = ledgerFor(cfg);
      const chainlink = createChainlinkClient(cfg.chainlink);
      const notify = createNotifier({ webhookUrl: cfg.webhookUrl, logger });
      // Fail fast on a heartbeat that cannot keep the store fresh.
      try {
        const store = await resolveStore(ledger, cfg, { party: cfg.pusher, logger });
        if (!store) logger.warn({}, 'No active PriceStore visible to the pusher yet; pushes will fail until `setup` has run');
        const warnings = timingWarnings(cfg, store?.createArgument?.maxStalenessSeconds);
        if (warnings.length) {
          warnings.forEach((w) => logger.error({}, w));
          if (cfg.heartbeatMs >= Number(store.createArgument.maxStalenessSeconds) * 1000) return 1;
        }
      } catch (e) {
        logger.warn({ err: e.message }, 'Could not read the store at startup; continuing (the loop retries every poll)');
      }
      const bot = createBot({
        cfg, ledger, chainlink, notify, logger,
        loadState: () => loadState(cfg.stateFile),
        saveState: (feeds) => saveState(cfg.stateFile, feeds),
      });
      const shutdown = (sig) => {
        logger.info({ signal: sig }, 'Shutting down');
        bot.stop();
        const wait = setInterval(() => { if (!bot.isRunning()) { clearInterval(wait); process.exit(0); } }, 200);
      };
      process.on('SIGTERM', () => shutdown('SIGTERM'));
      process.on('SIGINT', () => shutdown('SIGINT'));
      bot.start();
      return null; // keep running
    }
    default:
      console.error(`unknown command: ${cmd}\n\n${USAGE}`);
      return 2;
  }
}

main().then((code) => { if (code != null) process.exitCode = code; })
  .catch((e) => { console.error(e.message); process.exitCode = 1; });
