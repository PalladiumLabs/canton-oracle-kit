// Copyright 2026 Sats Labs Inc. (d/b/a Palladium Labs)
// SPDX-License-Identifier: Apache-2.0

/**
 * Minimal Canton JSON Ledger API v2 client: token fetch, submit-and-wait, active-contract query,
 * disclosed-contract fetch, and a contention-retry helper.
 *
 * Endpoints used:
 *   POST {url}/v2/commands/submit-and-wait-for-transaction
 *   GET  {url}/v2/state/ledger-end
 *   POST {url}/v2/state/active-contracts
 *   POST {url}/v2/events/events-by-contract-id
 *
 * Auth, in order of precedence:
 *   1. a static bearer token (LEDGER_STATIC_TOKEN), e.g. for a local sandbox;
 *   2. OAuth2 client-credentials against AUTH_TOKEN_URL (cached until 60s before expiry);
 *   3. none (no Authorization header) when neither is configured.
 */

function createLedgerClient({
  url,
  auth = {},
  timeoutMs = 60000,
  synchronizerId = '',
  packageIdSelectionPreference = [],
  userId = null,
  commandIdPrefix = 'oracle-pusher',
  fetchImpl = globalThis.fetch,
}) {
  if (!url) throw new Error('LEDGER_URL is not set');
  let cachedToken = null;
  let tokenExpiry = 0;

  async function getToken() {
    if (auth.staticToken) return auth.staticToken;
    if (!auth.tokenUrl) return null;
    if (cachedToken && Date.now() < tokenExpiry - 60000) return cachedToken;

    const fields = { grant_type: 'client_credentials', client_id: auth.clientId, client_secret: auth.clientSecret };
    if (auth.audience) fields.audience = auth.audience;
    if (auth.scope) fields.scope = auth.scope;
    const form = auth.bodyFormat === 'form';
    const resp = await fetchImpl(auth.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json' },
      body: form ? new URLSearchParams(fields).toString() : JSON.stringify(fields),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) throw new Error(`Auth failed: ${resp.status} ${(await resp.text()).slice(0, 200)}`);
    const data = await resp.json();
    if (!data.access_token) throw new Error('Auth response has no access_token');
    cachedToken = data.access_token;
    tokenExpiry = Date.now() + (Number(data.expires_in) || 300) * 1000;
    return cachedToken;
  }

  async function headers(json = true) {
    const token = await getToken();
    const h = {};
    if (token) h.Authorization = `Bearer ${token}`;
    if (json) h['Content-Type'] = 'application/json';
    return h;
  }

  async function post(pathname, body, errLabel) {
    const resp = await fetchImpl(`${url}${pathname}`, {
      method: 'POST',
      headers: await headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) {
      const errBody = await resp.text();
      const e = new Error(`${errLabel} ${resp.status}: ${errBody}`);
      e.status = resp.status;
      throw e;
    }
    return resp.json();
  }

  /**
   * Submit a command batch and wait for the transaction. `actAs` is caller-supplied because the right
   * controller depends on the choice (pusher for PushVerifiedPrice, operator for everything else).
   */
  async function submitCommand(commands, actAs, disclosedContracts = [], { readAs = [] } = {}) {
    const cmd = {
      commands,
      commandId: `${commandIdPrefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      actAs: Array.isArray(actAs) ? actAs : [actAs],
      readAs,
      disclosedContracts,
    };
    if (userId) cmd.userId = userId;
    if (packageIdSelectionPreference.length) cmd.packageIdSelectionPreference = packageIdSelectionPreference;
    return post('/v2/commands/submit-and-wait-for-transaction', { commands: cmd }, 'Ledger error');
  }

  async function fetchLedgerEnd() {
    const resp = await fetchImpl(`${url}/v2/state/ledger-end`, {
      headers: await headers(false),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) throw new Error(`ledger-end ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    const data = await resp.json();
    return data?.offset || 0;
  }

  const PAGE_SIZE = 100;
  const MAX_PAGES = 100;

  /** Active contracts matching `identifierFilter`, visible to `party`. Returns CreatedEvents. */
  async function activeContracts(identifierFilter, party) {
    const activeAtOffset = await fetchLedgerEnd();
    const payload = {
      eventFormat: {
        filtersByParty: { [party]: { cumulative: [{ identifierFilter }] } },
        verbose: true,
      },
      activeAtOffset,
      pageSize: PAGE_SIZE,
    };
    const out = [];
    let pageToken;
    for (let page = 0; page < MAX_PAGES; page++) {
      const data = await post('/v2/state/active-contracts', pageToken ? { ...payload, pageToken } : payload, 'Query error');
      const entries = Array.isArray(data) ? data : (data.activeContracts || []);
      const next = entries.find((e) => e?.nextPageToken)?.nextPageToken || null;
      out.push(...collectCreatedEvents(entries));
      if (!next || entries.length < PAGE_SIZE) break;
      pageToken = next;
    }
    return out;
  }

  /** Active contracts of one template visible to `party`. */
  function queryContracts(templateId, party) {
    return activeContracts({ TemplateFilter: { value: { templateId, includeCreatedEventBlob: false } } }, party);
  }

  /**
   * Fetch ONE contract's created event with its disclosure blob, AS `party`. Returns the shape a
   * submit's `disclosedContracts` expects. Throws if `party` cannot see the contract.
   */
  async function fetchDisclosedContract(contractId, party) {
    const payload = {
      contractId,
      eventFormat: {
        filtersByParty: { [party]: { cumulative: [{ identifierFilter: { WildcardFilter: { value: { includeCreatedEventBlob: true } } } }] } },
        verbose: true,
      },
    };
    let data;
    try {
      data = await post('/v2/events/events-by-contract-id', payload, 'events-by-contract-id');
    } catch (err) {
      throw new Error(`Cannot fetch ${short(contractId)} as ${short(party, 24)}: ${err.message.slice(0, 240)}`);
    }
    const created = data?.created || data;
    const ce = created?.createdEvent || data?.createdEvent;
    if (!ce?.createdEventBlob) throw new Error(`No createdEventBlob for ${short(contractId)} as ${short(party, 24)} (not visible?)`);
    if (data?.archived) throw new Error(`Contract ${short(contractId)} is archived`);
    return {
      templateId: ce.templateId,
      contractId: ce.contractId || contractId,
      createdEventBlob: ce.createdEventBlob,
      synchronizerId: created?.synchronizerId || ce.synchronizerId || synchronizerId,
    };
  }

  return { getToken, submitCommand, fetchLedgerEnd, activeContracts, queryContracts, fetchDisclosedContract };
}

function short(s, n = 16) {
  s = String(s || '');
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** The active-contracts response wraps each CreatedEvent a few different ways. */
function collectCreatedEvents(entries) {
  const out = [];
  for (const entry of entries) {
    const ce =
      entry?.contractEntry?.JsActiveContract?.createdEvent ||
      entry?.contractEntry?.activeContract?.createdEvent ||
      entry?.createdEvent;
    if (ce) out.push(ce);
  }
  return out;
}

/** True when `templateId` (package-id or package-name form) names `Module:Entity`. */
function templateMatches(templateId, qualifiedName) {
  const parts = String(templateId || '').split(':');
  return parts.length >= 3 && parts.slice(-2).join(':') === qualifiedName;
}

/** The `Module:Entity` part of a template id such as `#pkg:Module:Entity`. */
function qualifiedName(templateId) {
  return String(templateId).split(':').slice(-2).join(':');
}

/** CreatedEvents in a submit result whose template is `Module:Entity`, in transaction order. */
function createdEventsOf(result, qName) {
  const events = result?.transaction?.events || [];
  return events
    .map((e) => e.CreatedEvent || e.created || null)
    .filter((ce) => ce && templateMatches(ce.templateId, qName));
}

const CONTENTION_RE = /contract not found|CONTENTION|CONTRACT_NOT_FOUND|already archived|INACTIVE_CONTRACTS|not found or not active|LOCAL_VERDICT_LOCKED/i;

/** True when an error looks like stale-contract-id contention (re-resolve and retry). */
function isContentionError(err) {
  return CONTENTION_RE.test(err?.message || '');
}

/**
 * Run build-and-submit, retrying on contention. `buildAndSubmit` is called fresh on each attempt and
 * MUST re-resolve contract ids before submitting.
 */
async function submitWithContentionRetry(buildAndSubmit, { maxAttempts = 3, baseDelayMs = 1500, label = 'submit', logger = null, sleep } = {}) {
  const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await buildAndSubmit(attempt);
    } catch (err) {
      lastErr = err;
      if (!isContentionError(err) || attempt === maxAttempts) throw err;
      const delay = baseDelayMs + Math.floor(Math.random() * 500);
      logger?.warn({ label, attempt, maxAttempts, delay, err: err.message.slice(0, 300) }, 'Ledger contention; re-resolving and retrying');
      await wait(delay);
    }
  }
  throw lastErr;
}

/** DA.TextMap arrives as a JSON object, but tolerate an array of [k, v] / {key, value} pairs. */
function textMapEntries(tm) {
  if (!tm) return [];
  if (Array.isArray(tm)) return tm.map((e) => (Array.isArray(e) ? e : [e.key ?? e[0], e.value ?? e[1]]));
  return Object.entries(tm);
}

module.exports = {
  createLedgerClient,
  collectCreatedEvents,
  createdEventsOf,
  templateMatches,
  qualifiedName,
  isContentionError,
  submitWithContentionRetry,
  textMapEntries,
};
