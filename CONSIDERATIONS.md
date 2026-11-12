# Considerations before publishing

This repo is a prototype. These are the open questions and known trade-offs to settle before it becomes a
published library, roughly in order of importance.

## 1. Is there a bchd to connect to?

The provider is only useful if apps have a node to point at.
- **Public nodes.** Are there public mainnet and chipnet bchd nodes with `--addrindex`, `--txindex`, gRPC-Web
  and a CA-signed certificate? bchd's docs mention `bchd.greyh.at:8335`, run by a third party. Electrum
  has several well-known public servers; bchd may have one or none.
- **No default URL.** Without public nodes there is no sensible default, so `url` stays required, unlike
  `ElectrumNetworkProvider`'s per-network defaults. If reliable public nodes exist, add defaults.
- **Self-hosting needs** `--addrindex --txindex`, TLS that browsers trust, and enough
  `--grpcmaxconcurrentcalls` / `--grpcmaxsubscriptions` for the expected clients
  (`bchrpc/documentation/server_configuration.md`).
- **Auth tokens.** An `authToken` in a web page is visible to its users, so browser apps need a public node
  or a proxy.

## 2. Should this live in CashScript itself?

This repo is separate, with `cashscript` as a peer dependency.
- **For moving it into CashScript:** discoverability and one place for providers.
- **Against:** every CashScript user would install gRPC dependencies, and CashScript would take on bchd as a
  supported backend.
- **Middle way:** an official `@cashscript/bchd-provider` package in the monorepo.

Decide before advertising it.

## 3. Bundle size

Measured with esbuild, minified, `cashscript` and `@bitauth/libauth` excluded: about 147 KB, ~43 KB gzipped.

| Part | Size |
|---|---|
| `@bufbuild/protobuf` runtime | ~100 KB |
| ↳ its descriptor schema, needed to load the embedded bchrpc schema | ~24 KB |
| ↳ JSON (de)serialization, which Connect pulls in although gRPC-Web binary never uses it | ~20 KB |
| embedded `bchrpc` schema, all ~30 RPCs including SLP | ~21 KB |
| `@connectrpc/connect` + `connect-web` | ~18 KB |
| our code | ~5 KB |

For comparison, CashScript's own browser bundle is ~250 KB gzipped, mostly libauth, so this adds about 17%.
The Electrum provider's `@electrum-cash/network` is ~13 KB minified.

Options:
1. **Keep it.** It is typed, follows bchd's documentation and has a full client for other RPCs.
2. **Trim the proto to the RPCs used.** Saves ~4 KB gzipped, but the copy drifts from upstream and the full
   `client` goes away.
3. **Hand-write a minimal gRPC-Web client.** `fetch`, the 5-byte frame header, the trailer frame, and
   protobuf encoding for the ~8 messages used. Probably ~2–3 KB gzipped with no dependencies. We would own
   the wire code, including stream parsing, and lose the generated full client. The regtest suite would
   catch regressions.

Option 3 is the one to do if this becomes a recommended provider for browser dapps.

## 4. Dependencies and versions

- **`@connectrpc/connect`** is a regular dependency, so a user who passes their own transport may get a
  second copy. A transport made with another major version would not work. Consider making
  `@connectrpc/connect` a peer dependency, as `connect-web` does.
- **`@bitauth/libauth`** uses the same range as cashscript 0.14 (`^3.1.0-next.8`), so installs get one copy.
  Keep the two in step when CashScript bumps it.
- **`cashscript`** is a peer dependency `^0.14.0`. The provider imports CashScript's `NetworkProvider*Error`
  classes and `Network`, so a breaking change to those in CashScript breaks this package.
- **Installing from git runs `prepare`** (`npm run build`) to build `dist/`. Recent npm warns that this
  script isn't covered by its install-script allowlist; it still ran in testing, but stricter settings could
  block it. Publishing to npm, which ships the built `dist/`, avoids this.
- **ESM-only.** `require()` fails because libauth uses top-level await. That matches CashScript.

## 5. Behaviour that depends on bchd

- **Error classification depends on bchd's wording.** bchd answers a rejected transaction with
  `tx rejected: <description>`. The description is bchd's own text from `mempool/mempool.go`, which mostly
  does not include the BCHN reject reason. The provider matches that wording, plus the BCHN reasons in case
  they appear.
  - Proposed bchd change (the fork is ours): include the reject reason in the gRPC status message or as
    status details. Classification could then rely on the reason codes alone.
- **The address index is keyed by address.** `getUtxosForLockingBytecode` only works for locking bytecode
  with a CashAddress (P2PKH, P2SH20, P2SH32); anything else throws. CashScript contracts are always
  P2SH, so this only affects unusual uses.
- **bchd's own docs call `GetAddressUnspentOutputs` slow.** They recommend that wallets build UTXOs from
  `GetAddressTransactions` instead. Measure on a mainnet address with a large history before relying on it.
- **Subscriptions are capped.** By default each client IP may hold 25 subscriptions, and a slow reader's
  stream is reset (`ResourceExhausted`). Long-running apps should catch a stream error and resubscribe;
  the provider doesn't reconnect automatically. Consider a reconnecting helper.
- **The proto is a copy.** `proto/bchrpc.proto` is copied from our bchd fork (`proto/BCHD_COMMIT`). Fields
  added there, such as `bcmr_index`, may not exist on other bchd nodes. Unknown fields are ignored, so old
  nodes still work, but new RPCs fail on them.

## 6. API questions

- **Extra API surface.** `subscribeTransactions` / `subscribeBlocks` / `client` go beyond CashScript's
  `NetworkProvider`. Keep them, or move streaming into a separate helper? CashScript has no subscription
  interface yet; if this gets upstreamed, agree on one first.
- **`client` is raw.** It skips the network check, timeouts and error mapping, and makes the generated
  schema part of the public API (`./generated` export). Any regeneration that renames things is then a
  breaking change.
- **Network check cost.** The first call costs an extra `GetBlockchainInfo`, so the first `getBlockHeight`
  makes two calls. A mismatch is re-checked on every call rather than cached as a failure. Both are minor.
- **SLP checks.** `skipSlpValidityCheck` is always true, as CashScript transactions are not SLP aware. An
  app that also handles SLP tokens would lose bchd's burn protection; consider an option.
- **No connection management.** Unlike Electrum, there is no connection to manage, since gRPC-Web uses
  `fetch`. A native HTTP/2 transport keeps a session open; document how to close it if that matters.

## 7. Testing and CI

- **Regtest in CI.** The regtest suite needs a bchd binary. For CI, build bchd from a pinned commit (or use
  its Docker image), start `scripts/regtest.sh`, and run `npm run test:regtest`. It is opt-in
  (`BCHD_REGTEST=1`) and fails loudly if the node is unreachable.
- **Real browsers.** Nothing here runs in a real browser yet; the browser claim rests on the bundle having no
  Node built-ins and on bchd's documented gRPC-Web support. Add a Playwright test against the regtest node.
  That needs the browser to trust the self-signed cert, or a proxy with a trusted cert.
- **Public network.** Before publishing, run once against chipnet and mainnet nodes.
- **CashScript's e2e tests** could run with this provider in place of Electrum, as a broader check.

## 8. Before making the repo public

- **Name.** Package, folder and planned GitHub repo are all `bchd-network-provider`. If this is ever published
  to npm, check the name is free or use a scope (e.g. `@mr-zwets/bchd-network-provider`).
- **CashScript PR #267.** If we propose this instead of #267, put the comparison in that PR's discussion, not
  in this README. In short, this version:
  - detects NFTs from the bitfield, where #267 checked for a commitment and so dropped NFTs with empty
    commitments;
  - doesn't reverse response buffers in place;
  - follows the 0.14 interface;
  - maps errors to CashScript's error classes, checks the network, streams, and has tests.
