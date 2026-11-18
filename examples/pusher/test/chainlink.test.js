// Copyright 2026 Sats Labs Inc. (d/b/a Palladium Labs)
// SPDX-License-Identifier: Apache-2.0

const test = require('node:test');
const assert = require('node:assert/strict');
const { generateHmac, authHeaders, decodeV3, createChainlinkClient } = require('../src/chainlink');
const { buildFullReport, FEED } = require('./helpers');

// Known vector, computed independently with OpenSSL:
//   B=$(printf '' | openssl dgst -sha256 -r | cut -d' ' -f1)
//   printf '%s' "GET <path> $B test-client-id 1718885772000" | openssl dgst -sha256 -hmac test-client-secret
const PATH = `/api/v1/reports/latest?feedID=0x${FEED}`;
const VECTOR = '81842affae8a72c050ca654b7517ac611c08410489aa3c8a7f00b0feb4e42db3';

test('HMAC signature matches the known vector', () => {
  assert.equal(generateHmac('GET', PATH, 'test-client-id', 'test-client-secret', 1718885772000), VECTOR);
});

test('HMAC signs the empty-body SHA-256 by default', () => {
  const a = generateHmac('GET', PATH, 'id', 'secret', 1);
  const b = generateHmac('GET', PATH, 'id', 'secret', 1, '');
  assert.equal(a, b);
  assert.notEqual(a, generateHmac('GET', PATH, 'id', 'secret', 2));
});

test('auth headers carry key, timestamp and signature', () => {
  const h = authHeaders('GET', PATH, 'test-client-id', 'test-client-secret', 1718885772000);
  assert.deepEqual(h, {
    Authorization: 'test-client-id',
    'X-Authorization-Timestamp': '1718885772000',
    'X-Authorization-Signature-SHA256': VECTOR,
  });
});

test('decodeV3 reads feed id, timestamps and price', () => {
  const fr = buildFullReport({ validFrom: 1700000000, obsTs: 1700000001, expiresAt: 1700086400, price: 1918123456789987654321n });
  const d = decodeV3(fr);
  assert.equal(d.feedId, FEED);
  assert.equal(d.validFromTimestamp, 1700000000);
  assert.equal(d.observationsTimestamp, 1700000001);
  assert.equal(d.expiresAt, 1700086400);
  assert.equal(d.benchmarkPriceRaw, '1918123456789987654321');
  assert.ok(Math.abs(d.price - 1918.123456789987654321) < 1e-9);
});

test('decodeV3 treats the price as signed', () => {
  const d = decodeV3(buildFullReport({ validFrom: 1, obsTs: 1, expiresAt: 2, price: -5n * 10n ** 18n }));
  assert.equal(d.price, -5);
});

test('fetchSignedReport sends signed headers and passes fullReport through', async () => {
  const fr = buildFullReport({ validFrom: 10, obsTs: 11, expiresAt: 12, price: 2n * 10n ** 18n });
  let seen;
  const client = createChainlinkClient({
    apiKey: 'k', apiSecret: 's', endpoint: 'https://example.invalid',
    fetchImpl: async (url, opts) => {
      seen = { url, opts };
      return { ok: true, status: 200, text: async () => JSON.stringify({ report: { feedID: `0x${FEED}`, fullReport: fr } }) };
    },
  });
  const r = await client.fetchSignedReport(FEED); // no 0x: client adds it
  assert.equal(seen.url, `https://example.invalid${PATH}`);
  assert.equal(seen.opts.headers.Authorization, 'k');
  assert.equal(seen.opts.headers['X-Authorization-Signature-SHA256'],
    generateHmac('GET', PATH, 'k', 's', Number(seen.opts.headers['X-Authorization-Timestamp'])));
  assert.equal(r.fullReport, fr);
  assert.equal(r.decoded.price, 2);
});

test('fetchSignedReport surfaces HTTP errors', async () => {
  const client = createChainlinkClient({
    apiKey: 'k', apiSecret: 's', endpoint: 'https://example.invalid',
    fetchImpl: async () => ({ ok: false, status: 401, text: async () => '{"error":"unauthorized"}' }),
  });
  await assert.rejects(client.fetchSignedReport(FEED), /Data Streams 401/);
});
