# Chainlink onboarding

What you need from Chainlink before the example pusher can push a price, and where each value goes.

Chainlink's own guide is the
[Canton integration guide](https://docs.chain.link/data-streams/canton-integration); this page maps
it onto the kit.

This page reflects Palladium Labs' own onboarding. Chainlink's process may differ or
change; their guide is the authority.

## 1. Data Streams API credentials

The pusher fetches signed reports from Chainlink's Data Streams REST API with an API key and a
secret (requests are HMAC-signed with the secret).

- Request access through Chainlink's Data Streams contact form:
  <https://chain.link/contact?ref_id=datastreams>. Say that you are verifying reports on Canton, and
  give:
  - the network you are deploying to, and whether you need testnet or mainnet API credentials;
  - the streams you need (V3 crypto streams, see [feed ids](#4-feed-ids));
  - your **pusher party id** (see [section 3](#3-making-the-config-visible-to-your-parties)), so the
    same request covers the on-ledger side.
- Put the credentials in the pusher's `.env` as `CHAINLINK_API_KEY` and `CHAINLINK_API_SECRET`.
- Endpoints: testnet `https://api.testnet-dataengine.chain.link`, mainnet
  `https://api.dataengine.chain.link`. Set `CHAINLINK_NETWORK` or `CHAINLINK_ENDPOINT`.

## 2. Verifier contracts on your synchronizer

On-ledger verification uses two contracts from Chainlink's
[data-streams-canton](https://github.com/smartcontractkit/data-streams-canton) packages. Chainlink
issues the `VerifierConfig`; the `Verifier` is stateless and you normally create it yourself.

| Value                          | Used as                      | Where it comes from                                                                                                   |
| ------------------------------ | ---------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `Verifier` contract id         | feeder `verifierCid`         | You create it (below), or Chainlink gives you the id of a shared one that your pusher party observes                  |
| `VerifierConfig` contract id   | feeder `verifierConfigCid`   | Chainlink issues a config to your pusher party; query the ledger as the pusher for the current id (below)             |
| Chainlink's config-owner party | feeder `expectedConfigOwner` | Chainlink tells you, in writing. Do not take it from the ledger (below)                                                |

### `Verifier`

A `Verifier` holds no keys and no state; all trust sits in the `VerifierConfig`, and `Verify` does
not require the two to share an owner. Create one with the operator as `owner`. Its `observers`
**must include the pusher party**: the pusher fetches the `Verifier`'s disclosure blob on every
push, and cannot if it is not a stakeholder.

```json
POST /v2/commands/submit-and-wait-for-transaction
{
  "commands": {
    "commandId": "create-verifier-1",
    "actAs": ["<OPERATOR_PARTY>"],
    "commands": [{
      "CreateCommand": {
        "templateId": "#verifier:Verifier:Verifier",
        "createArguments": { "owner": "<OPERATOR_PARTY>", "observers": ["<PUSHER_PARTY>"] }
      }
    }]
  }
}
```

The contract id is in the returned created event. Set it as `CHAINLINK_VERIFIER_CID`. The owner can
archive the `Verifier`, which stops every push until the operator rotates to a new one, so do not
make a party you do not control its owner.

### `VerifierConfig`

Chainlink creates one `VerifierConfig` per onboarded party and adds that party as an observer. Once
Chainlink confirms your pusher party is onboarded, list the configs the pusher can see:

```json
POST /v2/state/active-contracts
{
  "eventFormat": {
    "filtersByParty": {
      "<PUSHER_PARTY>": {
        "cumulative": [{
          "identifierFilter": {
            "TemplateFilter": {
              "value": { "templateId": "#verifier-config:VerifierConfig:VerifierConfig", "includeCreatedEventBlob": false }
            }
          }
        }]
      }
    },
    "verbose": true
  },
  "activeAtOffset": <offset from GET /v2/state/ledger-end>
}
```

Take `contractId` as `CHAINLINK_VERIFIER_CONFIG_CID`. The id changes whenever Chainlink updates the
config; repeat this query to find the new one and follow
[operations](operations.md#following-a-chainlink-config-change).

### Config-owner party

`expectedConfigOwner` is what stops the feeder from being pointed at a forged config, so get the
value **from Chainlink, not from the ledger**. Anyone can create a `VerifierConfig` carrying their
own keys and name your pusher as an observer, and it would appear in the query above. Reading the
owner off a config only tells you who owned the config you happened to look at.

1. Ask your Chainlink contact for their config-owner party id on your network, in writing, and keep
   the record.
2. Set it as `CHAINLINK_CONFIG_OWNER_PARTY`.
3. Check that `confirmedOwnerView.owner` on the config returned by the query equals it. If the query
   returns more than one config, use the one that matches; if none does, stop and ask Chainlink.

## 3. Making the config visible to your parties

`Verify` fetches the `VerifierConfig` with the pusher's authority, so your **pusher party must be an
observer** of it. The operator also needs the `Verifier` and `VerifierConfig` disclosed to run
`ValidateVerifier` and `RotateVerifier`.

**Getting the pusher party added.** Chainlink does this by hand; there is no self-service flow.

1. Upload Chainlink's four DARs (`common`, `domain`, `verifier-config`, `verifier`, version 1.0.0)
   to the pusher's and the operator's participants. `make fetch-dars` downloads them.
2. Send Chainlink the pusher party id (`name::1220…`) and the network it is on, through the same
   contact as in [section 1](#1-data-streams-api-credentials).
3. Chainlink issues a `VerifierConfig` with that party as an observer. The query in
   [section 2](#verifierconfig) returns it once this is done.

Only the pusher needs to be an observer; the operator does not. If you rotate the pusher key, the
new party must be onboarded the same way before it can push.

**Fetching the disclosure blobs.** Read each contract as the pusher, asking for the created-event
blob:

```json
POST /v2/events/events-by-contract-id
{
  "contractId": "<Verifier or VerifierConfig contract id>",
  "eventFormat": {
    "filtersByParty": {
      "<PUSHER_PARTY>": {
        "cumulative": [{ "identifierFilter": { "WildcardFilter": { "value": { "includeCreatedEventBlob": true } } } }]
      }
    },
    "verbose": true
  }
}
```

A disclosed contract is the `templateId`, `contractId`, `createdEventBlob` and `synchronizerId` from
the response's created event, passed in `disclosedContracts` on the command.

The example pusher does this itself: on every push, and in `setup` for the operator's
`ValidateVerifier`. You need the request above only when the operator submits `RotateVerifier` or
`ValidateVerifier` by hand.

## 4. Feed ids

Chainlink lists V3 crypto stream ids at <https://docs.chain.link/data-streams/crypto-streams>.

- Only V3 ids (starting `0x0003`) are supported.
- Strip the `0x` before `RegisterFeed`; the pusher's `FEEDS` setting accepts either form.
- Testnet and mainnet ids differ for the same pair.

## 5. Check it

Run the example pusher's `probe` command. It checks the credentials, ledger auth, contract resolution and
the disclosure fetch, and predicts what a push would do, without submitting anything.
