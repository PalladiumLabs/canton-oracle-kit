#!/usr/bin/env bash
# Copyright 2026 Sats Labs Inc. (d/b/a Palladium Labs)
# SPDX-License-Identifier: Apache-2.0
#
# Fetch the Chainlink Data Streams Canton contracts this project builds against, and verify them.
#
# These DARs are published by Chainlink under the MIT license and are NOT redistributed in this
# repository (see THIRD_PARTY_NOTICES.md). This script downloads them from the official release into
# ./data-streams-dars/ and checks each one against a pinned SHA-256. Any mismatch aborts with a
# non-zero exit and deletes the bad file, so a build can never silently run against different code.
#
# Usage:  ./scripts/fetch-dars.sh
set -euo pipefail

VERSION="v1.0.0"
BASE="https://github.com/smartcontractkit/data-streams-canton/releases/download/${VERSION}"
DEST="$(cd "$(dirname "$0")/.." && pwd)/data-streams-dars"

# SHA-256 of each DAR in the official v1.0.0 release. The release also ships
# master-verifier-config-1.0.0.dar, which this project does not build against.
DARS=(
  "verifier-1.0.0.dar          1573c4d80a1557e5650950c89623459971e1e2c53abf7ef1e6a1056b2a6bdeb2"
  "verifier-config-1.0.0.dar   1904f452b1f4b5b1c8848b2f66349c54f086b1c58f73bbf415c93858cda5a544"
  "domain-1.0.0.dar            437c71821bf73fa1cd3d00d786d339098bdbecbdc3df50b1fa8e63ca1595537d"
  "common-1.0.0.dar            1fe079d0f545f8412221071e89678e0f275607aa5c5817629600f7946928c23f"
)

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

mkdir -p "$DEST"
for entry in "${DARS[@]}"; do
  read -r dar expected <<<"$entry"
  echo "Fetching ${dar} ..."
  curl --fail --location --silent --show-error "${BASE}/${dar}" --output "${DEST}/${dar}"
  actual="$(sha256 "${DEST}/${dar}")"
  if [[ "$actual" != "$expected" ]]; then
    rm -f "${DEST}/${dar}"
    echo "ERROR: SHA-256 mismatch for ${dar}" >&2
    echo "  expected ${expected}" >&2
    echo "  got      ${actual}" >&2
    exit 1
  fi
  echo "  sha256 OK"
done
echo "Done. Verified DARs are in ${DEST}"
