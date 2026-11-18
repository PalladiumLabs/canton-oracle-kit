// Copyright 2026 Sats Labs Inc. (d/b/a Palladium Labs)
// SPDX-License-Identifier: Apache-2.0

/** Test helpers: build a synthetic V3 fullReport (unsigned; only the layout matters here). */

const w = (v) => BigInt.asUintN(256, BigInt(v)).toString(16).padStart(64, '0');

const FEED = '000359843a543ee2fe414dc14c7e7920ef10f4372990b79d6361cdc0dd1ba782';

function buildFullReport({ feedId = FEED, validFrom, obsTs, expiresAt, price }) {
  const reportData = [
    feedId.padStart(64, '0'),
    w(validFrom),
    w(obsTs),
    w(0), // nativeFee
    w(0), // linkFee
    w(expiresAt),
    w(price), // benchmarkPrice (int192, 18 decimals)
    w(price), // bid
    w(price), // ask
  ].join('');
  const head = [w(1), w(2), w(3), w(7 * 32), w(0), w(0), w(0)].join('');
  return `0x${head}${w(reportData.length / 2)}${reportData}`;
}

module.exports = { buildFullReport, FEED };
