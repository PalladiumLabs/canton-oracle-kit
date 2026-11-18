# Contributing

Thanks for your interest. Applications rely on these contracts for prices, and changes are reviewed
with that in mind. Questions belong in [Discussions](https://github.com/PalladiumLabs/canton-oracle-kit/discussions).

## Ground rules

- **Security issues go through [SECURITY.md](SECURITY.md), not issues or pull requests.**
- **Do not weaken a guard.** Every check in the feeder and the price store has a reason documented
  next to it. A change that relaxes, reorders or removes a check needs a test showing why the old
  behaviour was wrong.
- **One passing and one failing case per guard.** A new guard needs both tests. A failing case must
  fail for exactly one reason. See the "NOTE ON CONSTRUCTION" comment in `oracle-tests/src/Tests/PriceStore.daml`.
- **Keep `oracle-api` minimal.** Other packages depend on it, so any change to it is a breaking
  change for every implementer. Add things there only when there is no alternative.
- **Do not commit Chainlink DARs.** They are fetched and checksum-verified by `scripts/fetch-dars.sh`.

## Building and testing

Requires DPM with Daml SDK 3.4.11 and Node.js 22.

```sh
make build        # fetch Chainlink's DARs (checksum-verified) and build every package
make test         # Daml Script suite and pusher unit tests
make lint         # licence headers, placeholders, pusher lint
make demo         # end-to-end write path on an in-memory ledger
```

The pusher alone: `cd examples/pusher && npm ci && npm test && npm run lint`.

CI runs the same steps on every pull request, and checks that the built package ids match
`CHANGELOG.md`. If you change a Daml package, update the id in the changelog (`make package-ids`
prints it).

## Pull requests

- Keep each PR to one concern.
- Update `CHANGELOG.md` under "Unreleased".
- Bump the version in the affected `daml.yaml` files following semver. A change to a template's
  fields or a choice's signature is a breaking change for anyone with live contracts.
- Add the licence header to new source files (`make lint` checks it).
- Commits do not need a sign-off. By contributing you agree that your contribution is licensed under
  the Apache License 2.0.
- Be kind; see [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
