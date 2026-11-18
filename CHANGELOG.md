# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and every package follows
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.0.0] — 2026-11-16

First public release. Every package is at 1.0.0.

### Added
- `oracle-api`: the `VerifiedPriceSink` interface (`RecordVerifiedPrice feedId price observationsTimestamp`).
- `oracle-chainlink`: `ChainlinkPriceFeeder` (pinned verifier/config pair, `PushVerifiedPrice`,
  `RotateVerifier`, `RotateOraclePusher`, `ValidateVerifier`), the V3 report decoder, and hex/time helpers.
- `oracle-price-store`: `PriceStore`, which implements `VerifiedPriceSink`. It provides positivity,
  observation-age, future-timestamp and monotonicity guards, a deviation hold with fresh-pending
  corroboration, strict and lenient reads, an add-only feed alias registry, and pusher rotation.
- `oracle-example-consumer`: an example template that reads a price inside its own choice, with the
  store passed as a disclosed contract (example only, not for deployment).
- `oracle-tests`: Daml Script suite (OC-01..09, PS-01..19, EX-01..04) and a local demo.
- `examples/pusher`: example Node.js pusher with `setup`, `probe`, `start` and `current-store` commands.
- Documentation under `docs/`, community files, CI lint and package-id check, release workflow.
- `scripts/fetch-dars.sh`, which fetches the Chainlink v1.0.0 DARs and checks their SHA-256 against pinned values.

### Package ids (Daml SDK 3.4.11)
| Package | Package id |
| --- | --- |
| oracle-api-1.0.0 | `6430aa3d2d0536d385bda6571f2733bd1a015d53f948ce9ed61396f7a425e5c1` |
| oracle-chainlink-1.0.0 | `909eded8b07980b69fac002114b67d52d026f75a884d5d7b61aa78db6b828a9a` |
| oracle-price-store-1.0.0 | `0010e8b5abdac103bd15e43a245e2e6b4fcdc617e22f82788f76b97529cfb949` |

The SHA-256 of each DAR is published in `SHA256SUMS` with the GitHub release.

