#!/usr/bin/env bash
# Copyright 2026 Sats Labs Inc. (d/b/a Palladium Labs)
# SPDX-License-Identifier: Apache-2.0
#
# Compare the package id of each built DAR with the id listed for it in CHANGELOG.md. The ids in the
# changelog are written by hand; this keeps them honest. Run after `dpm build --all`.
set -euo pipefail
cd "$(dirname "$0")/.."
DPM="${DPM:-dpm}"
fail=0
for pkg in oracle-api oracle-price-store oracle-chainlink; do
  version="$(sed -n 's/^version: *//p' "$pkg/daml.yaml")"
  dar="$pkg/.daml/dist/$pkg-$version.dar"
  built="$("$DPM" damlc inspect-dar --json "$dar" | python3 -c 'import json,sys; print(json.load(sys.stdin)["main_package_id"])')"
  listed="$(grep -E "^\| *$pkg-$version *\|" CHANGELOG.md | head -1 | sed -E 's/.*`([0-9a-f]{64})`.*/\1/' || true)"
  echo "$pkg-$version  built $built  changelog ${listed:-<missing>}"
  if [[ "$built" != "$listed" ]]; then fail=1; fi
done
if [[ "$fail" != 0 ]]; then
  echo "Package ids in CHANGELOG.md do not match the build. Update the table." >&2
fi
exit "$fail"
