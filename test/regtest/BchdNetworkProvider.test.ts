/**
 * Runs against a real regtest bchd, started with scripts/regtest.sh. Ported from CashScript's
 * MockNetworkProvider tests (test/e2e/network/MockNetworkProvider.test.ts).
 *
 *   BCHD_BIN=/path/to/bchd scripts/regtest.sh &
 *   npm run test:regtest
 *
 * The tests can run in any order, alone, and many times against the same node.
 */
import { readFileSync } from 'node:fs';
import { binToHex, cashAddressToLockingBytecode } from '@bitauth/libauth';
import { Code, ConnectError } from '@connectrpc/connect';
import { createGrpcTransport } from '@connectrpc/connect-node';
import {
  Contract,
  Network,
  NetworkProviderAbsoluteTimelockError,
  NetworkProviderError,
  NetworkProviderMempoolConflictError,
  NetworkProviderMissingInputsError,
  NetworkProviderRelativeTimelockError,
  NetworkProviderTransactionAlreadySubmittedError,
  randomUtxo,
  SignatureTemplate,
  TransactionBuilder,
  type SpendableUtxo,
  type Utxo,
} from 'cashscript';
import { BchdNetworkProvider, type BlockEvent, type TransactionEvent } from '../../src/index.js';
import p2pkhArtifact from '../fixture/p2pkh.artifact.js';
import { aliceAddress, alicePkh, alicePriv, alicePub, aliceTokenAddress, bobAddress, bobPriv } from '../fixture/vars.js';

const GRPC_URL = process.env.BCHD_GRPC_URL ?? 'https://127.0.0.1:18335';
const RPC_URL = process.env.BCHD_RPC_URL ?? 'https://127.0.0.1:18334';
const CERT_PATH = new URL('../../.regtest/rpc.cert', import.meta.url);
const FEE = 1000n;

async function rpc<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
  const response = await fetch(RPC_URL, {
    method: 'POST',
    headers: { Authorization: `Basic ${btoa('regtest:regtest')}` },
    body: JSON.stringify({ jsonrpc: '1.0', id: 1, method, params }),
  });
  const { result, error } = await response.json();
  if (error) throw new Error(error.message);
  return result as T;
}

const generate = (blocks: number) => rpc<string[]>('generate', [blocks]);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Resolves with the promise's value, or with undefined after `ms`. */
const within = <T>(promise: Promise<T>, ms: number) => Promise.race([promise, sleep(ms).then(() => undefined)]);
const lockingBytecodeHex = (address: string) => {
  const decoded = cashAddressToLockingBytecode(address);
  if (typeof decoded === 'string') throw new Error(decoded);
  return binToHex(decoded.bytecode);
};
const sameOutpoint = (a: Utxo) => (b: Utxo) => a.txid === b.txid && a.vout === b.vout;
const byOutpoint = (a: Utxo, b: Utxo) => `${a.txid}:${a.vout}`.localeCompare(`${b.txid}:${b.vout}`);

describe.runIf(process.env.BCHD_REGTEST === '1')('BchdNetworkProvider (regtest)', () => {
  const provider = new BchdNetworkProvider(Network.REGTEST, { url: GRPC_URL });
  const aliceTemplate = new SignatureTemplate(alicePriv);
  const p2pkhInstance = new Contract(p2pkhArtifact, [alicePkh], { provider });

  // Fresh, non-coinbase UTXOs of alice for each test, split from a mature coinbase
  const coins: SpendableUtxo[] = [];
  const takeCoin = (): SpendableUtxo => {
    const coin = coins.shift();
    if (!coin) throw new Error('Out of coins');
    return coin;
  };
  const payFrom = (coin: SpendableUtxo, to: string) => new TransactionBuilder({ provider })
    .addInput(coin, aliceTemplate.unlockP2PKH())
    .addOutput({ to, amount: coin.satoshis - FEE })
    .build();

  beforeAll(async () => {
    // Mines to alice (scripts/regtest.sh sets --miningaddr); the first new coinbase is then mature
    // Fund the run from alice's largest spendable UTXO, mining only on a fresh node. A new coinbase
    // can't be relied on: the block reward halves every 150 blocks on regtest, so after many runs
    // against one node it is worth next to nothing.
    const COINBASE_MATURITY = 100;
    let height = await provider.getBlockHeight();
    if (height <= COINBASE_MATURITY) {
      await generate(COINBASE_MATURITY + 1);
      height = await provider.getBlockHeight();
    }
    // The raw client tells coinbases and their heights apart, which SpendableUtxo does not
    const { outputs } = await provider.client.getAddressUnspentOutputs({ address: aliceAddress, includeMempool: true });
    const [largest] = outputs
      .filter((output) => !output.isCoinbase || height - output.blockHeight + 1 >= COINBASE_MATURITY)
      .sort((a, b) => (b.value > a.value ? 1 : -1));
    const [funding] = (await provider.getUtxos(aliceAddress))
      .filter((utxo) => utxo.txid === binToHex(largest.outpoint!.hash.slice().reverse()) && utxo.vout === largest.outpoint!.index);

    const coinCount = 30;
    const coinValue = 10_000_000n;
    const split = new TransactionBuilder({ provider }).addInput(funding, aliceTemplate.unlockP2PKH());
    for (let i = 0; i < coinCount; i += 1) split.addOutput({ to: aliceAddress, amount: coinValue });
    split.addOutput({ to: aliceAddress, amount: funding.satoshis - coinValue * BigInt(coinCount) - 10n * FEE });
    const splitTxid = await provider.sendRawTransaction(split.build());

    const splitUtxos = (await provider.getUtxos(aliceAddress)).filter((utxo) => utxo.txid === splitTxid);
    coins.push(...splitUtxos.sort((a, b) => a.vout - b.vout));
    expect(coins).toHaveLength(coinCount + 1);
  });

  it('should return the block height', async () => {
    const info = await rpc<{ blocks: number }>('getblockchaininfo');
    await expect(provider.getBlockHeight()).resolves.toBe(info.blocks);
  });

  it('should refuse to use the node as another network', async () => {
    const chipnetProvider = new BchdNetworkProvider(Network.CHIPNET, { url: GRPC_URL });
    await expect(chipnetProvider.getBlockHeight()).rejects.toThrow('bchd node runs on regtest');
  });

  it('should keep track of utxo set changes', async () => {
    const fundingCoin = takeCoin();
    const aliceCoin = takeCoin();

    // fund the contract
    const fundingTxid = await provider.sendRawTransaction(new TransactionBuilder({ provider })
      .addInput(fundingCoin, aliceTemplate.unlockP2PKH())
      .addOutput({ to: p2pkhInstance.address, amount: 1500n })
      .addOutput({ to: aliceAddress, amount: fundingCoin.satoshis - 1500n - FEE })
      .build());

    // other runs against the same node may have left UTXOs on the contract, so look at this one
    const p2pkhUtxos = (await provider.getUtxos(p2pkhInstance.address)).filter((utxo) => utxo.txid === fundingTxid);
    expect(p2pkhUtxos).toEqual([{
      txid: fundingTxid, vout: 0, satoshis: 1500n, lockingBytecode: lockingBytecodeHex(p2pkhInstance.address), token: undefined,
    }]);

    // spend both utxos to bob
    const tx = new TransactionBuilder({ provider })
      .addInputs(p2pkhUtxos, p2pkhInstance.unlock.spend(alicePub, aliceTemplate))
      .addInput(aliceCoin, aliceTemplate.unlockP2PKH())
      .addOutput({ to: bobAddress, amount: aliceCoin.satoshis + 1500n - FEE })
      .build();

    // try to send an invalid transaction
    await expect(provider.sendRawTransaction(tx.slice(0, -2))).rejects.toThrow('unable to deserialize transaction');

    const txid = await provider.sendRawTransaction(tx);

    // spent utxos are gone, bob has the new one
    expect((await provider.getUtxos(p2pkhInstance.address)).some(sameOutpoint(p2pkhUtxos[0]))).toBe(false);
    expect((await provider.getUtxos(aliceAddress)).some(sameOutpoint(aliceCoin))).toBe(false);
    expect((await provider.getUtxos(bobAddress)).filter((utxo) => utxo.txid === txid))
      .toEqual([{ txid, vout: 0, satoshis: aliceCoin.satoshis + 500n, lockingBytecode: lockingBytecodeHex(bobAddress), token: undefined }]);

    // resubmission is refused as already submitted, also after it confirmed
    await expect(provider.sendRawTransaction(tx)).rejects.toThrow(NetworkProviderTransactionAlreadySubmittedError);
    await generate(1);
    await expect(provider.sendRawTransaction(tx)).rejects.toThrow(NetworkProviderTransactionAlreadySubmittedError);

    // and the transaction is returned as sent, also for an upper case txid
    await expect(provider.getRawTransaction(txid)).resolves.toBe(tx);
    await expect(provider.getRawTransaction(txid.toUpperCase())).resolves.toBe(tx);
  });

  it('should look up UTXOs by locking bytecode, in any hex case', async () => {
    const coin = takeCoin();
    const txid = await provider.sendRawTransaction(payFrom(coin, bobAddress));
    const bobBytecode = lockingBytecodeHex(bobAddress);

    for (const bytecode of [bobBytecode, bobBytecode.toUpperCase()]) {
      const utxos = await provider.getUtxosForLockingBytecode(bytecode);
      expect(utxos.filter((utxo) => utxo.txid === txid)).toEqual([
        { txid, vout: 0, satoshis: coin.satoshis - FEE, lockingBytecode: bobBytecode, token: undefined },
      ]);
    }
  });

  it('should throw for an unknown transaction', async () => {
    const error = await provider.getRawTransaction(randomUtxo().txid).catch((e) => e);
    expect(error).toBeInstanceOf(ConnectError);
    expect(error.code).toBe(Code.NotFound);
  });

  it('should reject a transaction that spends a UTXO with a mismatched unlocker', async () => {
    const coin = takeCoin();
    // Pretend the coin is bob's, so that the TransactionBuilder's own check does not trigger
    const utxo = { ...coin, lockingBytecode: lockingBytecodeHex(bobAddress) };

    const transaction = new TransactionBuilder({ provider })
      .addInput(utxo, new SignatureTemplate(bobPriv).unlockP2PKH())
      .addOutput({ to: aliceAddress, amount: 5000n })
      .build();

    const error = await provider.sendRawTransaction(transaction).catch((e) => e);
    expect(error.message).toMatch(/failed to validate input .* OP_EQUALVERIFY failed/);
    expect(error).not.toBeInstanceOf(NetworkProviderError);

    // the failed transaction did not touch the utxo set
    expect((await provider.getUtxos(aliceAddress)).some(sameOutpoint(coin))).toBe(true);
  });

  it('should reject a transaction with missing inputs', async () => {
    const utxo = { ...randomUtxo(), lockingBytecode: lockingBytecodeHex(aliceAddress) };
    const transaction = new TransactionBuilder({ provider })
      .addInput(utxo, aliceTemplate.unlockP2PKH())
      .addOutput({ to: aliceAddress, amount: 5000n })
      .build();

    await expect(provider.sendRawTransaction(transaction)).rejects.toThrow(NetworkProviderMissingInputsError);
  });

  it('should reject a double spend of a mempool transaction', async () => {
    const coin = takeCoin();
    await provider.sendRawTransaction(payFrom(coin, aliceAddress));
    await expect(provider.sendRawTransaction(payFrom(coin, bobAddress))).rejects.toThrow(NetworkProviderMempoolConflictError);
  });

  it('should reject transactions with a block height locktime above the current block height', async () => {
    const blockHeight = await provider.getBlockHeight();
    const build = (coin: SpendableUtxo, locktime: number, sequence?: number): string => new TransactionBuilder({ provider })
      .setLocktime(locktime)
      .addInput(coin, aliceTemplate.unlockP2PKH(), { sequence })
      .addOutput({ to: aliceAddress, amount: coin.satoshis - FEE })
      .build();

    // The next block is blockHeight + 1, so a locktime of blockHeight + 1 is not final yet
    const coin = takeCoin();
    await expect(provider.sendRawTransaction(build(coin, blockHeight + 1))).rejects.toThrow(NetworkProviderAbsoluteTimelockError);
    // The same transaction with a final sequence number ignores the locktime
    await expect(provider.sendRawTransaction(build(coin, blockHeight + 1, 0xffffffff))).resolves.toBeTruthy();
    await expect(provider.sendRawTransaction(build(takeCoin(), blockHeight))).resolves.toBeTruthy();
  });

  it('should reject transactions with a time locktime above the median time past', async () => {
    const { mediantime } = await rpc<{ mediantime: number }>('getblockchaininfo');
    const build = (locktime: number): string => {
      const coin = takeCoin();
      return new TransactionBuilder({ provider })
        .setLocktime(locktime)
        .addInput(coin, aliceTemplate.unlockP2PKH())
        .addOutput({ to: aliceAddress, amount: coin.satoshis - FEE })
        .build();
    };

    await expect(provider.sendRawTransaction(build(mediantime + 3600))).rejects.toThrow(NetworkProviderAbsoluteTimelockError);
    await expect(provider.sendRawTransaction(build(mediantime - 1))).resolves.toBeTruthy();
  });

  it('should reject transactions with an unmet relative timelock, and accept them once met', async () => {
    const coin = takeCoin();
    // Confirm the coin so its age counts from now
    await generate(1);
    const transaction = new TransactionBuilder({ provider })
      .addInput(coin, aliceTemplate.unlockP2PKH(), { sequence: 10 })
      .addOutput({ to: aliceAddress, amount: coin.satoshis - FEE })
      .build();

    await expect(provider.sendRawTransaction(transaction)).rejects.toThrow(NetworkProviderRelativeTimelockError);
    await generate(9);
    await expect(provider.sendRawTransaction(transaction)).resolves.toBeTruthy();
  });

  it('should return CashTokens, including an NFT with an empty commitment', async () => {
    // A token genesis has to spend an output 0, whose txid becomes the category
    const coin = takeCoin();
    const category = await provider.sendRawTransaction(payFrom(coin, aliceAddress));
    const genesisInput = { ...coin, txid: category, vout: 0, satoshis: coin.satoshis - FEE };

    const genesis = new TransactionBuilder({ provider })
      .addInput(genesisInput, aliceTemplate.unlockP2PKH())
      .addOutput({ to: aliceTokenAddress, amount: 1000n, token: { category, amount: 1_000_000n, nft: { capability: 'none', commitment: '' } } })
      .addOutput({ to: aliceTokenAddress, amount: 1000n, token: { category, amount: 0n, nft: { capability: 'minting', commitment: 'beef' } } })
      .addOutput({ to: aliceTokenAddress, amount: 1000n, token: { category, amount: 2n ** 62n } })
      .addOutput({ to: aliceAddress, amount: genesisInput.satoshis - 3000n - FEE })
      .build();
    const txid = await provider.sendRawTransaction(genesis);

    const tokenUtxos = (await provider.getUtxos(aliceTokenAddress))
      .filter((utxo) => utxo.txid === txid)
      .sort((a, b) => a.vout - b.vout);

    expect(tokenUtxos.map((utxo) => utxo.token)).toEqual([
      { category, amount: 1_000_000n, nft: { capability: 'none', commitment: '' } },
      { category, amount: 0n, nft: { capability: 'minting', commitment: 'beef' } },
      { category, amount: 2n ** 62n },
      undefined,
    ]);
  });

  /**
   * A subscription is only registered once its request reaches the node, and there is no event for
   * that. Send payments (or mine blocks) until the stream delivers one, so the test never depends
   * on how long that takes.
   */
  async function waitUntilStreaming<T>(next: () => Promise<IteratorResult<T>>, poke: () => Promise<unknown>): Promise<void> {
    const first = next();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await poke();
      if (await within(first, 250)) return;
    }
    throw new Error('Subscription never delivered an event');
  }

  it('should stream transactions over gRPC-Web', async () => {
    const controller = new AbortController();
    const transactions = provider.subscribeTransactions([bobAddress], { signal: controller.signal })[Symbol.asyncIterator]();
    try {
      await waitUntilStreaming(() => transactions.next(), () => provider.sendRawTransaction(payFrom(takeCoin(), bobAddress)));

      const coin = takeCoin();
      const transaction = payFrom(coin, bobAddress);
      const txid = await provider.sendRawTransaction(transaction);
      await generate(1);

      // Collect this transaction's events, skipping those of the warm-up payments
      const events: TransactionEvent[] = [];
      while (!events.some((event) => event.confirmed)) {
        const { value } = await transactions.next();
        if (value.txid === txid) events.push(value);
      }
      expect(events).toEqual([
        { txid, transaction, confirmed: false },
        { txid, transaction, confirmed: true },
      ]);
    } finally {
      controller.abort();
    }
    await expect(transactions.next()).resolves.toMatchObject({ done: true });
  });

  it('should stream only confirmed transactions without includeMempool', async () => {
    const controller = new AbortController();
    const transactions = provider.subscribeTransactions([bobAddress], { signal: controller.signal, includeMempool: false })[Symbol.asyncIterator]();
    try {
      await waitUntilStreaming(() => transactions.next(), async () => {
        await provider.sendRawTransaction(payFrom(takeCoin(), bobAddress));
        await generate(1);
      });

      const txid = await provider.sendRawTransaction(payFrom(takeCoin(), bobAddress));
      await generate(1);
      let event: TransactionEvent;
      do ({ value: event } = await transactions.next()); while (event.txid !== txid);
      expect(event.confirmed).toBe(true);
    } finally {
      controller.abort();
    }
  });

  it('should stream connected and disconnected blocks over gRPC-Web', async () => {
    const controller = new AbortController();
    const blocks = provider.subscribeBlocks({ signal: controller.signal })[Symbol.asyncIterator]();
    try {
      await waitUntilStreaming(() => blocks.next(), () => generate(1));

      const [blockHash] = await generate(1);
      const height = await provider.getBlockHeight();
      let event: BlockEvent;
      do ({ value: event } = await blocks.next()); while (event.hash !== blockHash);
      expect(event).toEqual({ hash: blockHash, height, connected: true });

      // A reorg disconnects the block
      await rpc('invalidateblock', [blockHash]);
      expect((await blocks.next()).value).toEqual({ hash: blockHash, height, connected: false });
      await rpc('reconsiderblock', [blockHash]);
      expect((await blocks.next()).value).toEqual({ hash: blockHash, height, connected: true });
    } finally {
      controller.abort();
    }
    await expect(blocks.next()).resolves.toMatchObject({ done: true });
  });

  it('should work over native HTTP/2 gRPC with a custom transport', async () => {
    const transport = createGrpcTransport({ baseUrl: GRPC_URL, nodeOptions: { ca: readFileSync(CERT_PATH) } });
    const grpcProvider = new BchdNetworkProvider(Network.REGTEST, { transport });

    await expect(grpcProvider.getBlockHeight()).resolves.toBe(await provider.getBlockHeight());
    // bchd returns unconfirmed UTXOs in no fixed order
    const [grpcUtxos, webUtxos] = await Promise.all([grpcProvider.getUtxos(aliceAddress), provider.getUtxos(aliceAddress)]);
    expect(grpcUtxos.sort(byOutpoint)).toEqual(webUtxos.sort(byOutpoint));
  });
});
