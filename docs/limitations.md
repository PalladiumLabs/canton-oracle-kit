# Known limitations

- **Reads are operator-controlled.** `GetPrice` and `GetPriceWithStaleness` are `controller
  operator`, so a third party cannot read a price inside its own transaction. The consuming
  application must be signed by the store's operator; see the
  [example consumer](../oracle-example-consumer).
- **The feeder pins the `VerifierConfig` contract id.** When Chainlink updates its config, the old id
  is archived and every push fails until the operator runs `RotateVerifier`.
- **`ValidateVerifier` and `RotateVerifier` have not yet been run on a live participant.** The
  operator is not a stakeholder of Chainlink's `VerifierConfig`, so both choices depend on it being
  passed as a disclosed contract. The Daml Script tests cover both choices but do not exercise
  disclosure. `PushVerifiedPrice` uses the same disclosure mechanism and is proven in production.
- **One store contract holds every feed, and its id changes on every push.** Consumers must re-read
  the current id. Pushes to different feeds contend for the same contract.
- **V3 crypto reports only.** Other report schemas are rejected.
- **A genuine large move is delayed** by one report; see the
  [deviation hold](price-store.md#the-deviation-hold-and-its-trade-off).
