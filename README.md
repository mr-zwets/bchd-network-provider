# cashscript-bchd-provider

A [CashScript](https://cashscript.org) `NetworkProvider` backed by a [bchd](https://github.com/gcash/bchd) node's gRPC API.
The same code runs in browsers and in Node.js.

> Initial version, not published to npm.

```ts
import { Contract, Network } from 'cashscript';
import { BchdNetworkProvider } from 'cashscript-bchd-provider';

const provider = new BchdNetworkProvider(Network.MAINNET, { url: 'https://bchd.example.com:8335' });
const contract = new Contract(artifact, args, { provider });
```

## How browser + Node.js works

bchd serves **gRPC-Web** on the same `--grpclisten` port as native gRPC, with CORS open to any origin
(see bchd's `bchrpc/documentation/web.md`). gRPC-Web is plain HTTP requests, so a client only needs `fetch`,
which browsers and Node.js ≥ 18 both have. The provider uses [Connect-ES](https://connectrpc.com)'s
`createGrpcWebTransport` by default, so there is one code path and no Node-only dependency in the bundle.

Server streaming works over gRPC-Web too (`fetch` response streams), so `subscribeTransactions` and
`subscribeBlocks` work in the browser. Only the bidirectional `SubscribeTransactionStream` does not, and
bchd offers `SubscribeTransactions` for that reason.

In Node.js you can instead use native HTTP/2 gRPC by passing your own transport:

```ts
import { createGrpcTransport } from '@connectrpc/connect-node';

const transport = createGrpcTransport({ baseUrl: 'https://localhost:8335', nodeOptions: { ca: rpcCert } });
const provider = new BchdNetworkProvider(Network.MAINNET, { transport });
```

`@connectrpc/connect-node` is only a dev dependency here; install it yourself if you want this.

## Node requirements

- `--addrindex` for UTXO lookups and `--txindex` for `getRawTransaction`. A missing index gives a clear error.
- bchd only serves gRPC over **TLS**. Browsers need a certificate they trust (a public CA cert via
  `--rpccert`/`--rpckey`, or a reverse proxy). In Node.js, trust a self-signed `rpc.cert` with
  `NODE_EXTRA_CA_CERTS=~/.bchd/rpc.cert`, or pass `ca` to a native transport as above.
- `authToken` is sent as the `AuthenticationToken` header for nodes run with `--grpcauthtoken`.

## API

`BchdNetworkProvider` implements CashScript's `NetworkProvider`:
`getUtxos`, `getUtxosForLockingBytecode`, `getBlockHeight`, `getRawTransaction`, `sendRawTransaction`.

Extras:

- `subscribeTransactions(addresses, { signal })`: an async iterator of `{ txid, transaction, confirmed }`.
- `subscribeBlocks({ signal })`: an async iterator of `{ hash, height, connected }`.
- `client`: the generated Connect client, for any other bchd RPC.

Aborting the `signal` ends an iterator without an error.

Options: `url` | `transport`, `authToken`, `timeoutMs` (default 30s), `verifyNetwork` (default true).

## Compared to [CashScript PR #267](https://github.com/CashScript/cashscript/pull/267)

| | PR #267 | this package |
|---|---|---|
| Location | inside the `cashscript` package, which everyone would then depend on | separate package, `cashscript` as a peer dependency |
| Generated code | gitignored, generated at build time | committed (`src/generated`), regenerate with `npm run generate` |
| Transport | gRPC-Web only, hardcoded | gRPC-Web by default, any Connect transport can be passed in |
| NFTs | detected by "has a commitment", so **NFTs with an empty commitment were lost** | detected by the bitfield's NFT flag |
| Byte order | `.reverse()` mutated the response buffers in place | copies before reversing |
| Interface | predates `getUtxosForLockingBytecode` / `SpendableUtxo.lockingBytecode` | current CashScript 0.14 interface |
| Broadcast errors | plain errors | mapped to CashScript's `NetworkProvider*Error` classes, from bchd's own wording |
| Network | not checked | checks on first use that the node runs on the configured network |
| Streaming | none | transaction and block subscriptions |
| Tests | none | unit tests + a regtest suite against a real bchd |

## Development

```sh
npm install
npm test                       # unit tests, no node needed (in-memory Connect transport)

# regtest suite against a real bchd (built from source, e.g. `go build` in the bchd repo)
BCHD_BIN=/path/to/bchd scripts/regtest.sh &
npm run test:regtest

npm run generate               # regenerate src/generated from proto/bchrpc.proto
```

`proto/bchrpc.proto` is copied from bchd; `proto/BCHD_COMMIT` records which commit.

The regtest suite is a port of CashScript's `MockNetworkProvider` tests: tracking the UTXO set through a
P2PKH contract spend, resubmission, invalid transactions, missing inputs, double spends, absolute and
relative timelocks, CashTokens (including an empty-commitment NFT and a 2^62 amount), streaming, and the
native gRPC transport.

## Notes and limitations

- bchd's address index is keyed by address, so `getUtxosForLockingBytecode` only works for locking bytecode
  with a CashAddress (P2PKH, P2SH20, P2SH32).
- bchd's `tx rejected:` message does not always contain the BCHN reject reason, so error classification
  matches bchd's own wording (`mempool/mempool.go`). Including the reason in bchd's gRPC status would make
  this sturdier.
- `sendRawTransaction` sets `skipSlpValidityCheck`, as CashScript transactions are not SLP aware.
