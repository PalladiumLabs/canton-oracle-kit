// Copyright 2026 Sats Labs Inc. (d/b/a Palladium Labs)
// SPDX-License-Identifier: Apache-2.0

/**
 * Configuration, parsed from environment variables. `loadConfig(env)` is pure so it can be tested
 * with a plain object; the CLI passes `process.env`.
 *
 * CREDENTIAL BOUNDARY: the process holds both the ledger OAuth client credentials and the Chainlink
 * Data Streams HMAC keys. Keep the env file readable only by the service account.
 */

const DEFAULT_STORE_PACKAGE_REF = '#oracle-price-store';
const DEFAULT_CHAINLINK_PACKAGE_REF = '#oracle-chainlink';

const CHAINLINK_ENDPOINTS = {
  mainnet: 'https://api.dataengine.chain.link',
  testnet: 'https://api.testnet-dataengine.chain.link',
};

function int(v, d) {
  if (v == null || String(v).trim() === '') return d;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
}

function str(v, d = null) {
  if (v == null) return d;
  const s = String(v).trim();
  return s === '' ? d : s;
}

/** Feed ids are stored on-ledger WITHOUT `0x`, lower-case. */
function normFeedId(id) {
  return String(id || '').trim().toLowerCase().replace(/^0x/, '');
}

/** Chainlink's REST API takes the id WITH `0x`. */
function chainlinkFeedId(id) {
  return `0x${normFeedId(id)}`;
}

/**
 * Parse `label=feedId,label=feedId` (a bare `feedId` is allowed and gets no label). Returns
 * [{ label|null, feedId (normalized, no 0x) }].
 */
function parseFeeds(raw) {
  const out = [];
  const seen = new Set();
  for (const part of String(raw || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const eq = part.indexOf('=');
    const label = eq >= 0 ? part.slice(0, eq).trim() || null : null;
    const feedId = normFeedId(eq >= 0 ? part.slice(eq + 1) : part);
    if (!/^[0-9a-f]{64}$/.test(feedId)) {
      throw new Error(`FEEDS: "${part}" is not a 32-byte hex feed id`);
    }
    if (!feedId.startsWith('0003')) {
      throw new Error(`FEEDS: "${part}" is not a V3 feed id (must start with 0003); the feeder rejects other schemas`);
    }
    if (seen.has(feedId)) throw new Error(`FEEDS: feed id ${feedId} listed twice`);
    seen.add(feedId);
    out.push({ label, feedId });
  }
  return out;
}

/** Parse `key=int,key=int` into { key: int }. Keys may be labels or feed ids. */
function parseIntMap(raw, name) {
  const out = {};
  for (const part of String(raw || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const eq = part.indexOf('=');
    if (eq < 0) throw new Error(`${name}: "${part}" must be key=value`);
    const key = part.slice(0, eq).trim();
    const n = parseInt(part.slice(eq + 1), 10);
    if (!key || !Number.isFinite(n) || n < 0) throw new Error(`${name}: "${part}" must be key=<non-negative integer>`);
    out[key] = n;
  }
  return out;
}

function loadConfig(env = process.env) {
  const storeRef = str(env.STORE_PACKAGE_REF, DEFAULT_STORE_PACKAGE_REF);
  const chainlinkRef = str(env.CHAINLINK_PACKAGE_REF, DEFAULT_CHAINLINK_PACKAGE_REF);
  const network = str(env.CHAINLINK_NETWORK, 'testnet');

  const feeds = parseFeeds(env.FEEDS);
  const deviationMap = parseIntMap(env.DEVIATION_BPS, 'DEVIATION_BPS');
  const defaultDeviationBps = int(env.DEFAULT_DEVIATION_BPS, 0);
  for (const f of feeds) {
    const byLabel = f.label != null ? deviationMap[f.label] : undefined;
    const byId = deviationMap[f.feedId] ?? deviationMap[`0x${f.feedId}`];
    f.deviationBps = byLabel ?? byId ?? defaultDeviationBps;
  }

  // Timing has no defaults on purpose: the right values depend on the store's maxStalenessSeconds
  // and on how fast your application needs to see a move. See docs/deployment.md.
  const pollIntervalMs = int(env.POLL_INTERVAL_MS, null);
  const heartbeatMs = int(env.HEARTBEAT_MS, null);

  const ledgerAuth = {
    staticToken: str(env.LEDGER_STATIC_TOKEN),
    tokenUrl: str(env.AUTH_TOKEN_URL),
    clientId: str(env.AUTH_CLIENT_ID),
    clientSecret: str(env.AUTH_CLIENT_SECRET),
    audience: str(env.AUTH_AUDIENCE),
    scope: str(env.AUTH_SCOPE),
    bodyFormat: str(env.AUTH_BODY_FORMAT, 'json'),
  };
  // Optional separate credentials for the operator (setup only). Falls back to the main client.
  const operatorAuth = {
    staticToken: str(env.OPERATOR_LEDGER_STATIC_TOKEN, ledgerAuth.staticToken),
    tokenUrl: str(env.OPERATOR_AUTH_TOKEN_URL, ledgerAuth.tokenUrl),
    clientId: str(env.OPERATOR_AUTH_CLIENT_ID, ledgerAuth.clientId),
    clientSecret: str(env.OPERATOR_AUTH_CLIENT_SECRET, ledgerAuth.clientSecret),
    audience: str(env.OPERATOR_AUTH_AUDIENCE, ledgerAuth.audience),
    scope: str(env.OPERATOR_AUTH_SCOPE, ledgerAuth.scope),
    bodyFormat: str(env.OPERATOR_AUTH_BODY_FORMAT, ledgerAuth.bodyFormat),
  };

  const ledgerUrl = (str(env.LEDGER_URL, '') || '').replace(/\/$/, '');

  return {
    chainlink: {
      apiKey: str(env.CHAINLINK_API_KEY),
      apiSecret: str(env.CHAINLINK_API_SECRET),
      network,
      endpoint: (str(env.CHAINLINK_ENDPOINT) || CHAINLINK_ENDPOINTS[network] || CHAINLINK_ENDPOINTS.testnet).replace(/\/$/, ''),
      timeoutMs: int(env.CHAINLINK_TIMEOUT_MS, 15000),
    },
    ledger: {
      url: ledgerUrl,
      auth: ledgerAuth,
      timeoutMs: int(env.LEDGER_TIMEOUT_MS, 60000),
      synchronizerId: str(env.SYNCHRONIZER_ID, ''),
      packageIdSelectionPreference: String(env.PACKAGE_ID_SELECTION_PREFERENCE || '')
        .split(',').map((s) => s.trim()).filter(Boolean),
      userId: str(env.LEDGER_USER_ID),
    },
    operatorLedger: {
      url: (str(env.OPERATOR_LEDGER_URL, ledgerUrl) || '').replace(/\/$/, ''),
      auth: operatorAuth,
    },
    operator: str(env.OPERATOR_PARTY),
    pusher: str(env.PUSHER_PARTY),
    templateIds: {
      store: `${storeRef}:Palladium.Oracle.PriceStore:PriceStore`,
      feeder: `${chainlinkRef}:Palladium.Oracle.Chainlink:ChainlinkPriceFeeder`,
    },
    verifier: {
      verifierCid: str(env.CHAINLINK_VERIFIER_CID),
      verifierConfigCid: str(env.CHAINLINK_VERIFIER_CONFIG_CID),
      expectedConfigOwner: str(env.CHAINLINK_CONFIG_OWNER_PARTY),
    },
    store: {
      maxStalenessSeconds: int(env.STORE_MAX_STALENESS_SECONDS, null),
      lenientMaxStalenessSeconds: int(env.STORE_LENIENT_MAX_STALENESS_SECONDS, null),
      maxDeviationBps: int(env.STORE_MAX_DEVIATION_BPS, null),
    },
    feeds,
    pollIntervalMs,
    heartbeatMs,
    // Fetch-liveness alert: no report fetched for this long.
    staleAlertMs: int(env.STALE_ALERT_MS, null),
    // On-chain refresh alert: heartbeat + two polls of grace, unless set explicitly.
    pushStaleMs: int(env.PUSH_STALE_MS,
      heartbeatMs != null && pollIntervalMs != null ? heartbeatMs + 2 * pollIntervalMs : null),
    stateFile: str(env.STATE_FILE, './pusher-state.json'),
    webhookUrl: str(env.ALERT_WEBHOOK_URL),
    logLevel: str(env.LOG_LEVEL, 'info'),
  };
}

const ENV_NAME = {
  'ledger.url': 'LEDGER_URL',
  operator: 'OPERATOR_PARTY',
  pusher: 'PUSHER_PARTY',
  'chainlink.apiKey': 'CHAINLINK_API_KEY',
  'chainlink.apiSecret': 'CHAINLINK_API_SECRET',
  feeds: 'FEEDS',
  'verifier.verifierCid': 'CHAINLINK_VERIFIER_CID',
  'verifier.verifierConfigCid': 'CHAINLINK_VERIFIER_CONFIG_CID',
  'verifier.expectedConfigOwner': 'CHAINLINK_CONFIG_OWNER_PARTY',
  pollIntervalMs: 'POLL_INTERVAL_MS',
  heartbeatMs: 'HEARTBEAT_MS',
  staleAlertMs: 'STALE_ALERT_MS',
  'store.maxStalenessSeconds': 'STORE_MAX_STALENESS_SECONDS',
  'store.lenientMaxStalenessSeconds': 'STORE_LENIENT_MAX_STALENESS_SECONDS',
  'store.maxDeviationBps': 'STORE_MAX_DEVIATION_BPS',
};

function get(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}

function authProblems(auth, prefix) {
  if (auth.staticToken) return [];
  if (!auth.tokenUrl) return []; // no auth at all (e.g. a local sandbox) is allowed
  return ['clientId', 'clientSecret']
    .filter((k) => !auth[k])
    .map((k) => `${prefix}AUTH_${k === 'clientId' ? 'CLIENT_ID' : 'CLIENT_SECRET'}`);
}

/**
 * Throw if anything a command needs is missing. `needs` is a list of config paths from ENV_NAME.
 */
function assertConfig(cfg, needs, { operatorCreds = false } = {}) {
  const missing = needs.filter((p) => {
    const v = get(cfg, p);
    return v == null || v === '' || (Array.isArray(v) && v.length === 0);
  }).map((p) => ENV_NAME[p] || p);
  missing.push(...authProblems(cfg.ledger.auth, ''));
  if (operatorCreds) missing.push(...authProblems(cfg.operatorLedger.auth, 'OPERATOR_'));
  if (missing.length) throw new Error(`Missing config: ${[...new Set(missing)].join(', ')}`);
}

/** Problems with the timing settings relative to the on-ledger staleness bound. */
function timingWarnings(cfg, maxStalenessSeconds) {
  const out = [];
  const boundMs = Number(maxStalenessSeconds) * 1000;
  if (!Number.isFinite(boundMs) || boundMs <= 0) return out;
  if (cfg.heartbeatMs == null || cfg.pollIntervalMs == null) return out;
  if (cfg.heartbeatMs >= boundMs) {
    out.push(`HEARTBEAT_MS (${cfg.heartbeatMs}) must be below the store's maxStalenessSeconds (${maxStalenessSeconds}s); prices WILL go stale in a flat market`);
  } else if (cfg.heartbeatMs + cfg.pollIntervalMs >= boundMs) {
    out.push(`HEARTBEAT_MS + POLL_INTERVAL_MS (${cfg.heartbeatMs + cfg.pollIntervalMs}) reaches maxStalenessSeconds (${maxStalenessSeconds}s); leave at least one poll of margin`);
  }
  if (cfg.pushStaleMs >= boundMs) {
    out.push(`PUSH_STALE_MS (${cfg.pushStaleMs}) is not below maxStalenessSeconds (${maxStalenessSeconds}s); the refresh alert would fire only after prices are already stale`);
  }
  return out;
}

module.exports = {
  loadConfig,
  assertConfig,
  timingWarnings,
  parseFeeds,
  parseIntMap,
  normFeedId,
  chainlinkFeedId,
  CHAINLINK_ENDPOINTS,
};
