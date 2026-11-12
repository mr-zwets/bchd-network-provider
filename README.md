# bchd-network-provider

A [CashScript](https://cashscript.org) `NetworkProvider` backed by a [bchd](https://github.com/gcash/bchd) node's gRPC API.
The same code runs in browsers and in Node.js.

> Prototype, not published to npm. See [CONSIDERATIONS.md](./CONSIDERATIONS.md) for what is open before it
> could be a published library.

```sh
npm install github:mr-zwets/bchd-network-provider   # builds on install
```

```ts
import { Contract, Network } from 'cashscript';
import { BchdNetworkProvider } from 'bchd-network-provider';

const provider = new BchdNetworkProvider(Network.MAINNET, { url: 'https://bchd.example.com:8335' });
const contract = new Contract(artifact, args, { provider });
```

The package is ESM-only (as is CashScript) and needs Node.js 20 or newer.

## How browser + Node.js works

bchd serves **gRPC-Web** on the same `--grpclisten` port as native gRPC, with CORS open to any origin
(see bchd's `bchrpc/documentation/web.md`). gRPC-Web is plain HTTP requests, so a client only needs `fetch`,
which browsers and Node.js 20+ both have. The provider uses [Connect-ES](https://connectrpc.com)'s
`createGrpcWebTransport` by default, so there is one code path and no Node-only dependency in the bundle.

Server streaming works over gRPC-Web too (`fetch` response streams), so `subscribeTransactions` and
`subscribeBlocks` work in the browser. Only the bidirectional `SubscribeTransactionStream` does not, and
bchd offers `SubscribeTransactions` for that reason.

In Node.js you can instead use native HTTP/2 gRPC by passing your own Connect v2 transport
(`npm install @connectrpc/connect-node@^2`):

```ts
import { readFileSync } from 'node:fs';
import { createGrpcTransport } from '@connectrpc/connect-node';

const transport = createGrpcTransport({
  baseUrl: 'https://localhost:8335',
  nodeOptions: { ca: readFileSync(`${process.env.HOME}/.bchd/rpc.cert`) }, // for bchd's self-signed cert
});
const provider = new BchdNetworkProvider(Network.MAINNET, { transport });
```

## bchd node requirements

- `--addrindex` for UTXO lookups and `--txindex` for `getRawTransaction`. Without them, calls fail with an
  error naming the missing flags.
- bchd only serves gRPC over **TLS**. Browsers need a certificate they trust (a public CA cert via
  `--rpccert`/`--rpckey`, or a reverse proxy). In Node.js, trust a self-signed `rpc.cert` with
  `NODE_EXTRA_CA_CERTS=~/.bchd/rpc.cert`, or pass `ca` to a native transport as above.
- For nodes run with `--grpcauthtoken`, pass `authToken` with `url`; it is sent as the `AuthenticationToken`
  header. With your own `transport`, add the header through its interceptors.

## API

```ts
new BchdNetworkProvider(network, { url, authToken?, timeoutMs?, verifyNetwork? })
new BchdNetworkProvider(network, { transport, timeoutMs?, verifyNetwork? })
```

- `timeoutMs`: timeout of unary calls, 30 seconds by default. Subscriptions never time out.
- `verifyNetwork`: on first use, check that the node runs on `network` (default `true`), so a mainnet node is
  never used as chipnet or the other way around.

It implements CashScript's `NetworkProvider`: `getUtxos`, `getUtxosForLockingBytecode`, `getBlockHeight`,
`getRawTransaction`, `sendRawTransaction`. Broadcast rejections are mapped to CashScript's
`NetworkProvider*Error` classes (missing inputs, mempool conflict, already submitted, timelocks).

Extras:

- `subscribeTransactions(addresses, { signal?, includeMempool?, includeConfirmed? })`: an async iterator of
  `{ txid, transaction, confirmed }` for transactions paying to or spending from `addresses`. Both kinds of
  notification are on by default; a transaction is reported again once it confirms.
- `subscribeBlocks({ signal? })`: an async iterator of `{ hash, height, connected }`; `connected` is `false`
  for a block disconnected in a reorg.
- `client`: the generated Connect client, for any other bchd RPC. Its calls are raw: no network check,
  default timeout or error mapping. The generated messages and enums are exported from
  `bchd-network-provider/generated`.

Aborting the `signal` ends an iterator without an error, also while it is still connecting. Breaking out of a
`for await` loop closes the stream too.

## Design choices

- **Separate package.** `cashscript` is a peer dependency, so apps that don't use bchd don't carry gRPC code.
- **Transport-agnostic.** gRPC-Web by default for browser + Node.js; any Connect transport can be passed in.
- **Generated code is committed** (`src/generated`), so installing and building need no protobuf tooling.
  Regenerate with `npm run generate` after updating `proto/bchrpc.proto`.
- **Token data is read from the CashTokens bitfield**, so an NFT with an empty commitment is still an NFT.
- **Hashes are reversed on copies**, never in the response buffers.

## Development

```sh
npm install
npm test                       # unit tests, no node needed (in-memory Connect transport)
npm run typecheck

# regtest suite against a real bchd (built from source, e.g. `go build` in the bchd repo)
BCHD_BIN=/path/to/bchd scripts/regtest.sh &
npm run test:regtest

npm run generate               # regenerate src/generated from proto/bchrpc.proto
```

`proto/bchrpc.proto` is copied from bchd; `proto/BCHD_COMMIT` records which commit.

The regtest suite only runs with `BCHD_REGTEST=1` (which `npm run test:regtest` sets). It is a port of
CashScript's `MockNetworkProvider` tests to a real node:
- the UTXO set through a P2PKH contract spend, and resubmission
- invalid transactions, missing inputs and double spends
- absolute (height and time) and relative timelocks
- CashTokens, including an empty-commitment NFT and a 2^62 amount
- transaction and block streams, including a reorg
- the native gRPC transport

Its tests run in any order, alone, and repeatedly against the same node.
