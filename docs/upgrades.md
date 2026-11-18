# Upgrade policy

Packages follow semantic versioning, and upgrades use Daml smart contract upgrades where possible.

- **Patch and minor versions** are shipped as compatible upgrades: new optional fields, new choices,
  bug fixes that do not change a template's fields or a choice's signature. Live contracts keep
  working; upload the new DAR and the participant picks it up.
- **Major versions** need a new deployment: a change to a template's fields, a choice's arguments or
  result, or anything in `oracle-api`. Create a new store and feeder, move the pusher to them, then
  move consumers.
- `oracle-api` changes rarely, because every feeder and store depends on it.

Each release lists its package ids in [CHANGELOG.md](../CHANGELOG.md), and CI checks that the built
ids match.
