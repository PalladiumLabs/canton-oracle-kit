# Example pusher

The example pusher for `canton-oracle-kit`. It fetches signed Chainlink Data Streams V3 reports
and writes them on-ledger through `ChainlinkPriceFeeder.PushVerifiedPrice`, which verifies the
report against the pinned Chainlink verifier and records the price in a `PriceStore`.

This is an example to start from, not a supported product. It covers the push path, a deviation
gate and heartbeat, staleness alerts, a read-only preflight and an idempotent setup command. Review
it, test it on DevNet or TestNet, and adapt it to your own infrastructure before relying on it.

- Node.js 22, CommonJS, **no runtime dependencies** (built-in `fetch`, `crypto`, `node:test`).
- Talks to the Canton **JSON Ledger API v2** and the Chainlink Data Streams **REST** API.
- Holds per-feed state in a small local JSON file.

## Commands

```bash
cp .env.example .env      # fill it in
npm ci
npm run setup             # operator setup (idempotent)
npm run probe             # read-only preflight; exit code 1 on any failure
npm start                 # the push loop
npm run current-store     # print the current PriceStore contract id
npm test && npm run lint
```

The same commands are available as `node bin/pusher.js <command>` and as the
`canton-oracle-pusher` bin. A `.env` in the working directory (or the file named by `ENV_FILE`) is
loaded on start; variables already in the environment take precedence.

| Command         | Acts as             | What it does                                                                                                                                                                                                                                                                                                       |
| --------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `setup`         | operator            | Creates the `PriceStore` and the `ChainlinkPriceFeeder` for `(OPERATOR_PARTY, PUSHER_PARTY)` if none is active, runs `ValidateVerifier`, and runs `RegisterFeed` for each `label=feedId` not yet registered. Prints the contract ids as JSON. Safe to re-run. Run it while the pusher is stopped. |
| `probe`         | pusher (read-only)  | Checks the Chainlink credentials, ledger auth, feeder and store resolution, label bindings, the heartbeat against the store's `maxStalenessSeconds`, and the disclosure fetch; then predicts per feed what a push would do (`ACTIVATE`, `HOLD_PENDING`, `SKIP_NOT_NEWER`, `REJECT`). Submits nothing.           |
| `start`         | pusher              | The push loop. Refuses to start if `HEARTBEAT_MS` is not below the store's `maxStalenessSeconds`.                                                                                                                                                                                                                |
| `current-store` | pusher, or operator | Prints the current `PriceStore` contract id.                                                                                                                                                                                                                                                                      |

`setup` does not rotate anything. If the existing feeder pins a different verifier pair from the one
configured, it warns; exercise `RotateVerifier` as the operator yourself. It also warns when an
existing store's parameters differ from the configured ones, since they cannot be changed.

## Configuration

Every variable is documented in [`.env.example`](.env.example).

| Variable                                                 | Default                        | Meaning                                                                                                    |
| -------------------------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `CHAINLINK_API_KEY`, `CHAINLINK_API_SECRET`              | (required for `start`)         | Data Streams credentials. The key is the `Authorization` header; the secret is the HMAC key.              |
| `CHAINLINK_NETWORK` / `CHAINLINK_ENDPOINT`               | `testnet`                      | `testnet` or `mainnet` selects the REST endpoint; `CHAINLINK_ENDPOINT` overrides it.                       |
| `LEDGER_URL`                                             | (required)                     | JSON Ledger API v2 base URL.                                                                               |
| `AUTH_TOKEN_URL`, `AUTH_CLIENT_ID`, `AUTH_CLIENT_SECRET` | none                           | OAuth2 client-credentials. No `AUTH_TOKEN_URL` means no auth header (local sandbox).                       |
| `AUTH_AUDIENCE`, `AUTH_SCOPE`, `AUTH_BODY_FORMAT`        | none, none, `json`             | Extra token-request fields; `form` sends `application/x-www-form-urlencoded`.                              |
| `LEDGER_STATIC_TOKEN`                                    | none                           | Fixed bearer token instead of OAuth (development).                                                        |
| `OPERATOR_*` auth variables                              | same as the main client        | Separate operator credentials for `setup`.                                                                 |
| `OPERATOR_PARTY`, `PUSHER_PARTY`                         | (required)                     | The store/feeder signatory and the hot pusher key.                                                         |
| `CHAINLINK_VERIFIER_CID`, `CHAINLINK_VERIFIER_CONFIG_CID` | (required to create a feeder) | Chainlink's `Verifier` and `VerifierConfig` on your synchronizer.                                          |
| `CHAINLINK_CONFIG_OWNER_PARTY`                           | (required to create a feeder)  | The feeder's `expectedConfigOwner`.                                                                        |
| `FEEDS`                                                  | (required)                     | `label=feedId,...`. V3 ids only; `0x` optional. Labels are registered by `setup`.                         |
| `POLL_INTERVAL_MS`                                       | (required for `start`)         | Fetch interval.                                                                                            |
| `HEARTBEAT_MS`                                           | (required for `start`)         | Forced push interval. Must be below the store's `maxStalenessSeconds`.                                    |
| `DEVIATION_BPS`, `DEFAULT_DEVIATION_BPS`                 | none, `0`                      | Per-feed gate (`label=bps` or `feedId=bps`). `0` pushes every poll.                                       |
| `STORE_MAX_STALENESS_SECONDS`                            | (required for `setup`)         | Store parameter (`setup` only).                                                                            |
| `STORE_LENIENT_MAX_STALENESS_SECONDS`                    | (required for `setup`)         | Store parameter (`setup` only). Must be >= the strict bound.                                              |
| `STORE_MAX_DEVIATION_BPS`                                | (required for `setup`)         | Store parameter (`setup` only). Moves larger than this are held pending.                                  |
| `STATE_FILE`                                             | `./pusher-state.json`          | Per-feed state. Put it on persistent storage.                                                              |
| `STALE_ALERT_MS`                                         | (required for `start`)         | Alert when no report has been fetched for this long.                                                       |
| `PUSH_STALE_MS`                                          | `HEARTBEAT_MS + 2 polls`       | Alert when the stored price has not been refreshed for this long.                                          |
| `ALERT_WEBHOOK_URL`                                      | none                           | Optional JSON webhook for alerts.                                                                          |
| `STORE_PACKAGE_REF`, `CHAINLINK_PACKAGE_REF`             | `#oracle-price-store`, `#oracle-chainlink` | Package-name references used to build the template ids.                                       |
| `SYNCHRONIZER_ID`, `PACKAGE_ID_SELECTION_PREFERENCE`, `LEDGER_USER_ID` | none               | Optional ledger submission fields.                                                                         |
| `LOG_LEVEL`                                              | `info`                         | `debug`, `info`, `warn` or `error`.                                                                        |

## How a cycle works

For each feed, every `POLL_INTERVAL_MS`:

1. Fetch the latest signed report from Data Streams (HMAC-SHA256 auth) and decode it locally. The
   local decode is used only for logging and for the gate. The ledger verifies and decodes the
   report itself.
2. **Gate.** Push if this is the first price, the report could not be decoded (fail open), the
   heartbeat has elapsed since the last refresh, the feed has no gate, or the price moved at least
   the feed's `DEVIATION_BPS` from the last price this pusher activated. Otherwise skip.
3. **Push.** Resolve the feeder and the current store, fetch the `Verifier` and `VerifierConfig`
   disclosure blobs as the pusher, and exercise `PushVerifiedPrice { sinkCid, signedReportBytes }`
   as the pusher. Stale contract ids (another transaction consumed the store) are re-resolved and
   retried up to three times.
4. **Classify** the result from the new store contract: the price was activated, or it was held in
   `pendingPrices` because the move exceeded the store's `maxDeviationBps`. A held push is not a
   refresh and keeps the baseline, so the next poll pushes again and the second report corroborates
   the move.

Alerts are always written as structured log lines with `"alert": true`. With `ALERT_WEBHOOK_URL`
set, they are also POSTed as:

```json
{
  "service": "canton-oracle-pusher",
  "severity": "critical",
  "title": "Oracle feed stale",
  "fields": { "feed": "ETH-USD", "reason": "..." },
  "ts": "2026-01-01T00:00:00.000Z",
  "text": "[critical] Oracle feed stale feed=ETH-USD ..."
}
```

`severity` is `critical` or `resolved`. The `text` field makes the payload usable as-is by
Slack-style incoming webhooks.

## Rules that are not obvious


**The heartbeat must be shorter than the store's `maxStalenessSeconds`.** A skipped poll never
advances the stored observation timestamp. In a flat market the deviation gate skips every poll,
so only the heartbeat keeps the price fresh. Once the stored price ages past `maxStalenessSeconds`,
every `GetPrice` aborts. Leave enough room between the heartbeat and the bound for a heartbeat push
to fail and be retried, at least a few polls, before reads start failing. Raising the heartbeat past
the bound means creating a new store with a larger bound first. `start` refuses to run with a heartbeat at or above the bound, and `probe` reports it.

**"Not newer than the stored price" means there was no fresher report.** The store rejects a report
whose observation timestamp is not strictly newer than the stored one. The pusher treats that abort
as a skip, not an error, and **not as a refresh**: `lastPushAt` keeps aging. If the feed is truly
frozen, the refresh alert (`PUSH_STALE_MS`) fires instead of the problem hiding behind a benign skip.
A heartbeat push that fails for any other reason pages immediately, because it is the direct
precursor to the store going stale.

**The pusher sources both disclosure blobs itself, on every push.** `Verify` runs against the
pinned `Verifier` and Chainlink's `VerifierConfig`. The feeder's operator is a stakeholder of
neither by default, so both are passed as disclosed contracts. The pusher is an observer of the `VerifierConfig`; the operator is not, and
cannot see it. So the pusher fetches both blobs as itself (`/v2/events/events-by-contract-id`), on
every attempt, which also picks up a Chainlink config change. When Chainlink rotates its config, the
old cid is archived and every push fails until the operator runs `RotateVerifier`. `setup` also uses
the pusher's view to build the disclosure for the operator's `ValidateVerifier`.

**Run exactly one pusher per store.** Every push, and every `RegisterFeed`, archives the store and
creates a new one. Two writers race for the same contract: one wins, the other fails with a
contention error and retries. Pushes to different feeds of the same store contend in the same way,
which is why this pusher pushes its feeds sequentially. Use one process per store, and stop it before
running `setup` or any operator ceremony against the store.

**Find the current store cid, don't cache it.** Because the store cid changes on every push,
consumers must look up the current one each time they need it. Query the active contracts of
`#oracle-price-store:Palladium.Oracle.PriceStore:PriceStore` as any stakeholder (the operator or the
pusher) and filter on `operator`. From the command line:

```bash
npm run --silent current-store
```

From code:

```js
const { loadConfig, createLedgerClient, currentStoreCid } = require('@palladiumlabs/canton-oracle-pusher');

const cfg = loadConfig(process.env);
const ledger = createLedgerClient(cfg.ledger);
const storeCid = await currentStoreCid(ledger, cfg, { party: cfg.operator });
```

If a read races a push, the cid it got may already be archived. Retry with a fresh lookup.

## State file

`STATE_FILE` holds, per feed: the last price this pusher activated (the deviation baseline), the
times of the last refresh, last successful submit and last successful fetch, and whether a staleness
alert is open. It is written atomically. Losing it is safe: the next poll pushes as if it were the
first price. Keep it on a persistent volume so a restart neither re-pages an open alert nor forgets
when the price was last refreshed.

The baseline comes from this file rather than from an on-ledger read on purpose: `GetPrice` aborts
once the price is stale, which is exactly the situation the pusher has to handle.

## Docker

```bash
docker build -t canton-oracle-pusher .
docker run --env-file .env -v pusher-data:/data canton-oracle-pusher            # start
docker run --env-file .env canton-oracle-pusher probe
```

The image runs as the non-root `node` user and keeps its state in `/data`.

## License

Apache-2.0. See the repository [LICENSE](../LICENSE).
