# Trust model

The design centres on one property: **a compromised pusher key cannot forge a price.**

## The pusher key

What the `oraclePusher` key can do:

- exercise `PushVerifiedPrice` with a genuine, currently valid Chainlink report. That writes the
  real price, which is the key's job;
- see the feeder and the store, because it is an observer on both.

What it cannot do:

- **Write a price directly.** `RecordVerifiedPrice` is controlled by the store's `operator`, and the
  pusher holds no operator authority.
- **Make a fabricated report pass.** Verification runs against the verifier and config pair pinned
  on the feeder, not one passed in the call.
- **Re-point the verifier.** `RotateVerifier` is operator-only. It fetches the new verifier, requires
  an active digest with `f >= 1` and at least `f + 1` signers, and requires the config to be owned by
  the feeder's pinned `expectedConfigOwner`. That last check blocks a rotation to a self-minted
  config carrying the caller's own keys.
- **Install its own feeder.** The feeder is `signatory operator`.
- **Bind labels to feeds or rotate keys.** `RegisterFeed` and both `RotateOraclePusher` choices are
  operator-only.

If the pusher key leaks, follow [operations: rotating the pusher key](operations.md#rotating-the-pusher-key).

## The operator

What the design does not prevent: a transaction signed by the operator writing a price directly. The
store is `signatory operator` alone, so the operator can always archive and recreate it with any
prices, or call `RecordVerifiedPrice` itself. That control is off-ledger: hold the operator key
accordingly, and monitor for direct writes as described below.

`validateVerifierPair` performs ledger actions, so it cannot be an `ensure`, and a direct `create` of
the feeder bypasses it. Run `ValidateVerifier` immediately after initial deployment and after any
Chainlink config change.

## Detecting a direct operator write

Every legitimate price change happens inside a `PushVerifiedPrice` exercise. In the transaction tree
it appears as:

```
Exercise ChainlinkPriceFeeder.PushVerifiedPrice   (actor: oraclePusher)
 ├─ Exercise Verifier.Verify
 └─ Exercise VerifiedPriceSink.RecordVerifiedPrice (on PriceStore)
     └─ Create PriceStore   ← the new prices / pendingPrices
```

Monitor every transaction that archives a `PriceStore`. Each one should be one of:

- `RecordVerifiedPrice` nested under `PushVerifiedPrice`;
- `RotateOraclePusher` or `RegisterFeed`, which leave `prices` and `pendingPrices` unchanged.

Treat anything else as an incident until explained, including `RecordVerifiedPrice` as a root
exercise, or an archive followed by a fresh `create PriceStore`. Apply the same check to
`ChainlinkPriceFeeder`: a `RotateVerifier`, or a re-create, that nobody scheduled is a change to the
root of trust for every price.

## Chainlink's signer set

The on-ledger rule is `f + 1` signers, which is what verification needs. Chainlink's own policy is
stronger (`signers > 3f`). Check that margin of Chainlink's config yourself; it is not enforced
on-ledger.
