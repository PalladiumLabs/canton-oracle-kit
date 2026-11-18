#!/usr/bin/env bash
# Copyright 2026 Sats Labs Inc. (d/b/a Palladium Labs)
# SPDX-License-Identifier: Apache-2.0
#
# Repository lint: licence headers on every source file, no leftover placeholders, no tabs or
# trailing whitespace in Daml sources.
set -euo pipefail
cd "$(dirname "$0")/.."
fail=0

while IFS= read -r f; do
  if ! head -5 "$f" | grep -q "SPDX-License-Identifier: Apache-2.0"; then
    echo "missing SPDX header: $f"; fail=1
  fi
done < <(git ls-files '*.daml' '*.sh' 'examples/pusher/*.js' 'Makefile')

if git grep -nE '<(COPYRIGHT HOLDER|SECURITY CONTACT)>|\[INSERT ' -- . ':!scripts/lint.sh'; then
  echo "placeholder text found"; fail=1
fi

if git grep -nP '\t| +$' -- '*.daml'; then
  echo "tabs or trailing whitespace in Daml sources"; fail=1
fi

exit "$fail"
