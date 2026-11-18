# Price store

## Write guards (`RecordVerifiedPrice`)

| Guard            | Rejects                                                                                                                      |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Raw V3 feed id   | anything whose id does not start with `0003`, including labels such as `ETH-USD` (a label key would shadow the alias lookup) |
| Positive price   | `price <= 0`                                                                                                                 |
| Observation age  | `now - observationsTimestamp > maxStalenessSeconds`                                                                          |
| Future timestamp | `observationsTimestamp > now`. A negative age would otherwise always read as fresh.                                          |
| Monotonicity     | an observation not strictly newer than the stored active price                                                               |
| Deviation hold   | see below                                                                                                                    |

Template `ensure`: `maxStalenessSeconds > 0`, `lenientMaxStalenessSeconds >= maxStalenessSeconds`,
`maxDeviationBps > 0`. These fields have no update choice, so a bad value would be permanent.

## Reads

- `GetPrice`: strict, checked against `maxStalenessSeconds`.
- `GetPriceWithStaleness`: checked against a bound the caller passes in, intended to be
  `lenientMaxStalenessSeconds`.
- Both look up the key directly first, then through a registered label alias. Both abort if
  neither lookup finds a price.
- Both are `controller operator`. See [limitations](limitations.md) and the
  [example consumer](../oracle-example-consumer) for how an application reads a price.

## Feed registry

`RegisterFeed label rawFeedId` is operator-only and checks for a V3 id. It is add-only: re-pointing a
live label at another feed is rejected, because it would silently value everything read through
that label at another asset's price. Re-registering the same mapping is allowed, so retries are
idempotent.

## The deviation hold and its trade-off

A move within `maxDeviationBps` of the active price activates immediately. A larger move is put in
`pendingPrices` and the old price keeps being served. It activates only when a later report
corroborates it: within `maxDeviationBps` of the pending value, while the pending value is itself
still within `maxStalenessSeconds`. A stale pending value cannot confirm a large move; the new value
is held as a fresh pending value instead.

The cost: a genuine large move is delayed by one report. That is the price of not letting a single
outlier report move the price. The example pusher pushes again on the next poll after a held
report, so the delay is one poll interval.

## Freshness: two different checks

- **Report validity window** (feeder): `validFromTimestamp <= now <= expiresAt`. This is Chainlink's
  window for verifying the report, set per report. Chainlink's documented example reports expire
  about 24 hours after `validFromTimestamp`; the 120-second window in this repo's tests comes from
  Chainlink's test fixture. It says nothing about how old the price is once stored.
- **Observation age** (store): `now - observationsTimestamp`, checked against
  `maxStalenessSeconds` when the price is written, and again on every read. This is the check that
  keeps prices fresh. A stored price goes stale if no new report is pushed, regardless of the window
  it arrived in.

## Precision

V3 prices are 18-decimal fixed point. Daml `Decimal` has 10 decimal places. The feeder computes
`benchmarkPrice / 1.0e18`, and Daml rounds the result half-to-even at the 10th decimal place. For
example, `1918.123456789987654321` is stored as `1918.1234567900`. Anything below 1e-10 is lost.

Before scaling, a raw word above `5.0e26` aborts with "hex value too large for Decimal". That caps a
decodable price at about 500,000,000 in human units.

The three price words (`benchmarkPrice`, `bid`, `ask`) are `int192` and are decoded as signed two's
complement. A negative price decodes correctly and is then rejected by the positivity guard.
