# Operations

## Alerts to set up

- **Staleness.** Alert when the newest stored observation for a feed approaches
  `maxStalenessSeconds`. A stopped pusher, or a Chainlink config rotation that hasn't been followed
  by `RotateVerifier`, shows up as prices going stale, not as an error. The example pusher raises
  this alert itself; see the [example pusher README](../examples/pusher/README.md).
- **Direct operator writes.** See [trust model](trust-model.md#detecting-a-direct-operator-write).

## Rotating the pusher key

The pusher can only push genuine, currently valid Chainlink reports, so a leaked key cannot forge a
price. It can still push valid reports at times you didn't choose, and it can see prices. Revoke it:

1. Rotate every contract that names the pusher, using operator-only choices:
   - `ChainlinkPriceFeeder.RotateOraclePusher`
   - `PriceStore.RotateOraclePusher` (keeps every price and alias, so it is safe mid-incident)
   - anything your own application created that names the pusher.

   Rotating only one contract is not a revocation. The old key stays live on the others; in
   particular, a revoked key can still drive an un-rotated feeder with a genuine report.
2. Make sure the new pusher is an observer of the `VerifierConfig`. `Verify` fetches it with the
   pusher's authority.
3. Restart the pusher with the new key and confirm a push succeeds.
4. Review the transactions submitted by the old key since it may have leaked.

## Following a Chainlink config change

The feeder pins the `VerifierConfig` contract id. When Chainlink updates its config, the old
contract is archived and every push fails until the operator runs:

1. `RotateVerifier` with the new verifier and config ids (the operator needs both disclosed).
2. `ValidateVerifier`, to confirm the new pair.

The same applies after a synchronizer migration that re-creates Chainlink's contracts.

## Error messages

| Message (prefix)                                                       | Raised by                  | Cause                                                                                          | What to do                                                                                   |
| ---------------------------------------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `VerifierConfig is not owned by the expected Chainlink config owner`   | `RotateVerifier`, `ValidateVerifier` | The config's owner differs from the feeder's `expectedConfigOwner`                    | Check you are pointing at Chainlink's config, and that `expectedConfigOwner` is Chainlink's party |
| `VerifierConfig has no config digests at all`                          | same                       | Empty config                                                                                   | Use Chainlink's current config contract                                                      |
| `VerifierConfig has no ACTIVE, USABLE digest`                          | same                       | No active digest with `f >= 1` and at least `f + 1` signers                                    | Use Chainlink's current config contract; contact Chainlink if it persists                    |
| `Report is not a V3-schema report`                                     | `PushVerifiedPrice`        | The report's feed id does not start with `0003`                                                | Only V3 crypto feeds are supported                                                          |
| `Report not yet valid`                                                 | `PushVerifiedPrice`        | Ledger time is before the report's `validFromTimestamp`                                        | Check clock skew between Chainlink and the synchronizer; retry                              |
| `Report has expired`                                                   | `PushVerifiedPrice`        | Ledger time is past the report's `expiresAt`                                                   | Fetch a fresh report; check the pusher is not submitting old reports                        |
| `RecordVerifiedPrice expects a raw V3 Chainlink feed id`               | `RecordVerifiedPrice`      | A write under a label or non-V3 id                                                             | Writes use raw ids; read by label instead                                                   |
| `Price must be positive`                                               | `RecordVerifiedPrice`      | The report carried a zero or negative price                                                    | Nothing to fix on your side; the report is refused                                          |
| `Price report is stale`                                                | `RecordVerifiedPrice`      | The observation is older than `maxStalenessSeconds`, or in the future                         | Fetch a fresh report; check clocks                                                          |
| `Report is not newer than the stored price`                            | `RecordVerifiedPrice`      | The report is not strictly newer than the active price                                         | No fresher report exists yet. Skip, but do not count it as a refresh                        |
| `No price for feed`                                                    | `GetPrice`, `GetPriceWithStaleness` | Neither the key nor a registered alias has a price                                | Register the label, or wait for the first push                                              |
| `Stored price is stale`                                                | `GetPrice`                 | The active price is older than `maxStalenessSeconds`                                           | Check the pusher is running and Chainlink's config is current                               |
| `Stored price is stale (beyond lenient tolerance)`                     | `GetPriceWithStaleness`    | The active price is older than the bound passed in                                             | As above                                                                                    |
| `Feed label must not be empty`, `Raw feed id must not be empty`        | `RegisterFeed`             | Empty argument                                                                                 | Pass both                                                                                   |
| `Raw feed id is not a V3 Chainlink Data Streams id`                    | `RegisterFeed`             | The id does not start with `0003`, often because it still has `0x`                             | Strip `0x`; use a V3 feed id                                                                |
| `Feed label '…' is already registered to raw feed '…'`                 | `RegisterFeed`             | The label is bound to another feed; aliases are add-only                                       | Use a new label                                                                             |
| `hex value too large for Decimal`                                      | decoder                    | A price word above 5.0e26 (about 500,000,000 in human units)                                   | Feed not supported at this precision                                                        |
| `invalid hex digit`, `bad size`                                        | decoder                    | Malformed report data                                                                          | Check the pusher passes Chainlink's `fullReport` unchanged                                  |
