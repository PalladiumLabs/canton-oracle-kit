# Copyright 2026 Sats Labs Inc. (d/b/a Palladium Labs)
# SPDX-License-Identifier: Apache-2.0

DPM ?= dpm
DARS := oracle-api oracle-price-store oracle-chainlink

.PHONY: all fetch-dars build test test-daml test-pusher demo lint package-ids clean

all: build test

data-streams-dars/verifier-1.0.0.dar:
	./scripts/fetch-dars.sh

fetch-dars: data-streams-dars/verifier-1.0.0.dar

build: fetch-dars
	$(DPM) build --all

test: test-daml test-pusher

test-daml: build
	cd oracle-tests && $(DPM) test

test-pusher:
	cd examples/pusher && npm ci --no-audit --no-fund && npm test

# Create a store and feeder, push Chainlink's signed test report and read it back, on an
# in-memory ledger. No credentials needed.
demo: build
	cd oracle-tests && $(DPM) test --files src/Tests/Demo.daml

lint:
	./scripts/lint.sh
	cd examples/pusher && npm run lint

# Print the package id of each deployable DAR and compare it with CHANGELOG.md.
package-ids: build
	./scripts/check-package-ids.sh

clean:
	rm -rf */.daml data-streams-dars examples/pusher/node_modules
