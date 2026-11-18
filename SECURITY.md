# Security policy

## Reporting a vulnerability

Report suspected vulnerabilities privately by email to **hello@palladiumlabs.org**, or through
GitHub: **Security → Report a vulnerability** on this repository.

Do not open a public issue or pull request for a security report. We aim to acknowledge a report
within 3 working days and to agree a coordinated disclosure timeline with you.

## Supported versions

| Version | Supported          |
| ------- | ------------------ |
| 1.x     | yes                |
| < 1.0   | no                 |

## Scope

The security goal is narrow: a compromised pusher key cannot forge a price. The operator is out of
scope on-ledger, because the store and the feeder are both `signatory operator`. See
[docs/trust-model.md](docs/trust-model.md) for what the pusher key can and cannot do, and
[docs/operations.md](docs/operations.md) for key rotation and monitoring.

Chainlink's contracts (`verifier`, `verifier-config`, `domain`, `common`) are Chainlink's; report
issues in them to Chainlink.
