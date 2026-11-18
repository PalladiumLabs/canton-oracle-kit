// Copyright 2026 Sats Labs Inc. (d/b/a Palladium Labs)
// SPDX-License-Identifier: Apache-2.0

/**
 * Chainlink Data Streams REST client. Fetches the RAW signed report (`fullReport` hex) for a feed.
 *
 * The ledger verifies and decodes the raw report itself (`ChainlinkPriceFeeder.PushVerifiedPrice`),
 * so `fullReport` is passed through untouched. `decodeV3` here is for logging and for the deviation
 * gate only; it is NOT trusted for anything written on-ledger.
 */
const crypto = require('node:crypto');
const { chainlinkFeedId } = require('./config');

const EMPTY_BODY_SHA256 = crypto.createHash('sha256').update('').digest('hex');

/**
 * HMAC-SHA256 auth per Chainlink Data Streams. The string to sign is
 *   "<METHOD> <PATH-with-query> <hex sha256 of body> <apiKey> <timestamp-ms>"
 * keyed with the API secret, hex-encoded.
 */
function generateHmac(method, path, apiKey, apiSecret, timestamp, body = '') {
  const bodyHash = body === '' ? EMPTY_BODY_SHA256 : crypto.createHash('sha256').update(body).digest('hex');
  const strToSign = `${method} ${path} ${bodyHash} ${apiKey} ${timestamp}`;
  return crypto.createHmac('sha256', apiSecret).update(strToSign).digest('hex');
}

/** The three auth headers for a request. */
function authHeaders(method, path, apiKey, apiSecret, timestamp = Date.now()) {
  return {
    Authorization: apiKey,
    'X-Authorization-Timestamp': String(timestamp),
    'X-Authorization-Signature-SHA256': generateHmac(method, path, apiKey, apiSecret, timestamp),
  };
}

function word(hex, i) {
  return hex.slice(i * 64, (i + 1) * 64);
}

/** Signed two's-complement 192-bit integer from a 32-byte word (int192 is sign-extended to 256). */
function int256(w) {
  const v = BigInt(`0x${w}`);
  return v >= (1n << 255n) ? v - (1n << 256n) : v;
}

/**
 * Decode a V3 fullReport. Layout: abi.encode(bytes32[3] reportContext, bytes reportData, bytes32[] rs,
 * bytes32[] ss, bytes32 rawVs). Word 3 is the byte offset of reportData; at that offset is its length
 * word, then the V3 fields: feedId, validFromTimestamp, observationsTimestamp, nativeFee, linkFee,
 * expiresAt, benchmarkPrice, bid, ask.
 */
function decodeV3(fullReport) {
  const hex = fullReport.startsWith('0x') ? fullReport.slice(2) : fullReport;
  const reportDataOffset = parseInt(word(hex, 3), 16) * 2;
  const reportData = hex.slice(reportDataOffset + 64);
  const benchmarkRaw = int256(word(reportData, 6));
  return {
    feedId: word(reportData, 0).toLowerCase(),
    validFromTimestamp: Number(BigInt(`0x${word(reportData, 1)}`)),
    observationsTimestamp: Number(BigInt(`0x${word(reportData, 2)}`)),
    expiresAt: Number(BigInt(`0x${word(reportData, 5)}`)),
    benchmarkPriceRaw: benchmarkRaw.toString(),
    price: Number(benchmarkRaw) / 1e18,
  };
}

/**
 * Create a client. `fetchImpl` is injectable for tests.
 */
function createChainlinkClient({ apiKey, apiSecret, endpoint, timeoutMs = 15000, fetchImpl = globalThis.fetch }) {
  /**
   * Fetch the latest signed report for a feed id (with or without `0x`). Returns the raw fullReport
   * hex (passed through to the ledger) plus a best-effort decode for logging and gating.
   */
  async function fetchSignedReport(feedId) {
    if (!apiKey || !apiSecret) {
      throw new Error('CHAINLINK_API_KEY and CHAINLINK_API_SECRET must be set');
    }
    const path = `/api/v1/reports/latest?feedID=${chainlinkFeedId(feedId)}`;
    const resp = await fetchImpl(`${endpoint}${path}`, {
      headers: authHeaders('GET', path, apiKey, apiSecret),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await resp.text();
    let data;
    try { data = JSON.parse(text); } catch {
      throw new Error(`Data Streams ${resp.status}: unparseable response: ${text.slice(0, 200)}`);
    }
    if (!resp.ok) throw new Error(`Data Streams ${resp.status}: ${text.slice(0, 200)}`);

    const report = data?.report;
    if (!report?.fullReport) {
      throw new Error(`No fullReport returned for feed ${feedId}: ${text.slice(0, 200)}`);
    }
    let decoded = null;
    try { decoded = decodeV3(report.fullReport); } catch { /* logging only */ }
    return { fullReport: report.fullReport, feedId: report.feedID || chainlinkFeedId(feedId), decoded };
  }

  return { fetchSignedReport };
}

module.exports = { createChainlinkClient, generateHmac, authHeaders, decodeV3 };
