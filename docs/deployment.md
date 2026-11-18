# Deployment

The [example pusher's `setup` command](../examples/pusher/README.md) performs steps 2 to 5 for you. They are listed
here so you know what it does.

1. Upload `oracle-api`, `oracle-price-store` and `oracle-chainlink`, together with Chainlink's four
   DARs, to the operator's and the pusher's participants. Participants that only read prices need
   `oracle-api` and `oracle-price-store`.
2. Create `PriceStore` with `operator`, `oraclePusher`, `maxStalenessSeconds`,
   `lenientMaxStalenessSeconds` and `maxDeviationBps`. Leave `prices`, `pendingPrices` and
   `feedAliases` empty.
3. Create `ChainlinkPriceFeeder` with the same `operator` and `oraclePusher`, Chainlink's
   `verifierCid` and `verifierConfigCid`, and `expectedConfigOwner` set to Chainlink's config-owner
   party (see [Chainlink onboarding](chainlink-onboarding.md)). Do this while the pusher is stopped.
4. Exercise `ValidateVerifier`. It must succeed before the pusher starts.
5. Optionally `RegisterFeed` a label for each raw feed id.
6. Start the pusher. It exercises `PushVerifiedPrice` with the current store id and the signed report.

The feeder does not check that its operator equals the store's operator. A mismatch fails
authorization when the feeder calls `RecordVerifiedPrice`.

## Choosing parameters

| Parameter                     | Where      | What it bounds                                              | Guidance                                                                                                 |
| ----------------------------- | ---------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `maxStalenessSeconds`         | store      | Oldest observation accepted on write and by `GetPrice`      | The longest your application can safely act on an old price. Fixed at creation.                          |
| `lenientMaxStalenessSeconds`  | store      | The bound callers are meant to pass to `GetPriceWithStaleness` | For paths that must not be blocked by one stale unrelated feed (for example, repayments). Fixed at creation. |
| `maxDeviationBps`             | store      | Largest single move that activates without corroboration    | Above the feed's normal move between two pushes, below a move you would not trust from one report.      |
| heartbeat                     | pusher     | Longest gap between pushes when the price is flat           | Must be shorter than `maxStalenessSeconds`, with room for a failed push or two.                          |
| deviation threshold (per feed) | pusher    | Move that triggers a push before the heartbeat              | Small enough that consumers see meaningful moves quickly; each push costs traffic.                      |
| poll interval                 | pusher     | How often the pusher fetches a report                       | Sets the reaction time and the minimum delay of a held large move.                                       |

**Worked example.** Say your application must never act on a price older than `S` seconds. Set
`maxStalenessSeconds = S`. Pick a poll interval `P` that matches how quickly you need to react, and a
heartbeat `H` with `H + 3P < S`, so a heartbeat push can fail and be retried a few times before
`GetPrice` starts failing. Set `maxDeviationBps` above the largest move you expect between two
polls; a larger move is then held and confirmed on the next poll, about `P` later. Set
`lenientMaxStalenessSeconds` to how long paths such as repayments should keep working during an
outage, which is usually much longer than `S`.

## Finding the current store contract

The store is one contract holding every feed, and its contract id changes on every push. A consumer
must pass the current id, not a stored one. Query the active `PriceStore` for your operator (the
pusher's `current-store` command and `currentStoreCid()` library function do this). A transaction
built on a just-archived id fails with a contention error; re-read and retry.

## Gotchas

- **Feed ids are stored without `0x`** and must match the registered raw id character for
  character. Chainlink publishes ids with `0x`; strip it before `RegisterFeed`.
- **Testnet and mainnet feed ids differ** for the same pair. Register the ids for your network.
- The pusher must be an **observer of the `VerifierConfig`**. `Verify` fetches it with the pusher's
  authority, so a config the pusher cannot see fails before any signature is checked.
- The operator needs the `Verifier` and `VerifierConfig` **disclosed** when running `RotateVerifier`
  or `ValidateVerifier`.
- Run **exactly one pusher per store**. Two writers contend for the same contract.
