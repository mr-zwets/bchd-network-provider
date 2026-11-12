/**
 * Runs against a real regtest bchd, started with scripts/regtest.sh. Ported from CashScript's
 * MockNetworkProvider tests (test/e2e/network/MockNetworkProvider.test.ts).
 *
 *   BCHD_BIN=/path/to/bchd scripts/regtest.sh &
 *   npm run test:regtest
 */
import { readFileSync } from 'node:fs';
import { createGrpcTransport } from '@connectrpc/connect-node';
import {
  Contract,
  Network,
  NetworkProviderAbsoluteTimelockError,
  NetworkProviderMempoolConflictError,
  NetworkProviderMissingInputsError,
  NetworkProviderRelativeTimelockError,
  NetworkProviderTransactionAlreadySubmittedError,
  randomUtxo,
  SignatureTemplate,
  TransactionBuilder,
  type SpendableUtxo,
} from 'cashscript';
import { BchdNetworkProvider, type TransactionEvent } from '../../src/index.js';
import p2pkhArtifact from '../fixture/p2pkh.artifact.js';
import { aliceAddress, alicePkh, alicePriv, alicePub, aliceTokenAddress, bobAddress, bobPriv } from '../fixture/vars.js';

const GRPC_URL = process.env.BCHD_GRPC_URL ?? 'https://127.0.0.1:18335';
const RPC_URL = process.env.BCHD_RPC_URL ?? 'https://127.0.0.1:18334';
const CERT_PATH = new URL('../../.regtest/rpc.cert', import.meta.url);

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

describe.runIf(Boolean(process.env.NODE_EXTRA_CA_CERTS))('BchdNetworkProvider (regtest)', () => {
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

  beforeAll(async () => {
    const minedBlocks = await generate(101);
    const block = await rpc<{ tx: string[] }>('getblock', [minedBlocks[0]]);
    const coinbaseTxid = block.tx[0];
    const [coinbase] = (await provider.getUtxos(aliceAddress)).filter((utxo) => utxo.txid === coinbaseTxid);

    const split = new TransactionBuilder({ provider }).addInput(coinbase, aliceTemplate.unlockP2PKH());
    const coinValue = 10_000_000n;
    for (let i = 0; i < 20; i += 1) split.addOutput({ to: aliceAddress, amount: coinValue });
    const splitTxid = await provider.sendRawTransaction(split.build());

    const splitUtxos = (await provider.getUtxos(aliceAddress)).filter((utxo) => utxo.txid === splitTxid);
    coins.push(...splitUtxos.sort((a, b) => a.vout - b.vout));
    expect(coins).toHaveLength(20);
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
    const fee = 1000n;

    // fund the contract
    const fundingTx = new TransactionBuilder({ provider })
      .addInput(fundingCoin, aliceTemplate.unlockP2PKH())
      .addOutput({ to: p2pkhInstance.address, amount: 1500n })
      .addOutput({ to: aliceAddress, amount: fundingCoin.satoshis - 1500n - fee })
      .build();
    await provider.sendRawTransaction(fundingTx);

    const p2pkhUtxos = await provider.getUtxos(p2pkhInstance.address);
    const bobUtxosBefore = await provider.getUtxos(bobAddress);
    expect(p2pkhUtxos).toHaveLength(1);
    expect(p2pkhUtxos[0]).toMatchObject({ satoshis: 1500n, token: undefined });

    // spend both utxos to bob
    const tx = new TransactionBuilder({ provider })
      .addInputs(p2pkhUtxos, p2pkhInstance.unlock.spend(alicePub, aliceTemplate))
      .addInput(aliceCoin, aliceTemplate.unlockP2PKH())
      .addOutput({ to: bobAddress, amount: aliceCoin.satoshis + 1500n - fee })
      .build();

    // try to send an invalid transaction
    await expect(provider.sendRawTransaction(tx.slice(0, -2))).rejects.toThrow('unable to deserialize transaction');

    const txid = await provider.sendRawTransaction(tx);

    // spent utxos are gone, bob has a new one
    expect(await provider.getUtxos(p2pkhInstance.address)).toHaveLength(0);
    const aliceUtxos = await provider.getUtxos(aliceAddress);
    expect(aliceUtxos.some((utxo) => utxo.txid === aliceCoin.txid && utxo.vout === aliceCoin.vout)).toBe(false);
    const bobUtxos = await provider.getUtxos(bobAddress);
    expect(bobUtxos).toHaveLength(bobUtxosBefore.length + 1);
    expect(bobUtxos.find((utxo) => utxo.txid === txid)).toMatchObject({ vout: 0, satoshis: aliceCoin.satoshis + 500n });

    // resubmission is refused as already submitted, also after it confirmed
    await expect(provider.sendRawTransaction(tx)).rejects.toThrow(NetworkProviderTransactionAlreadySubmittedError);
    await generate(1);
    await expect(provider.sendRawTransaction(tx)).rejects.toThrow(NetworkProviderTransactionAlreadySubmittedError);

    // and the transaction is returned as sent
    await expect(provider.getRawTransaction(txid)).resolves.toBe(tx);
  });

  it('should throw for an unknown transaction', async () => {
    await expect(provider.getRawTransaction(randomUtxo().txid)).rejects.toThrow();
  });

  it('should reject a transaction that spends a UTXO with a mismatched unlocker', async () => {
    const coin = takeCoin();
    // Pretend the coin is bob's, so that the TransactionBuilder's own check does not trigger
    const utxo = { ...coin, lockingBytecode: (await provider.getUtxos(bobAddress))[0].lockingBytecode };

    const transaction = new TransactionBuilder({ provider })
      .addInput(utxo, new SignatureTemplate(bobPriv).unlockP2PKH())
      .addOutput({ to: aliceAddress, amount: 5000n })
      .build();

    await expect(provider.sendRawTransaction(transaction)).rejects.toThrow('tx rejected');

    // the failed transaction did not touch the utxo set
    const aliceUtxos = await provider.getUtxos(aliceAddress);
    expect(aliceUtxos.some((u) => u.txid === coin.txid && u.vout === coin.vout)).toBe(true);
  });

  it('should reject a transaction with missing inputs', async () => {
    const utxo = { ...randomUtxo(), lockingBytecode: takeCoin().lockingBytecode };
    const transaction = new TransactionBuilder({ provider })
      .addInput(utxo, aliceTemplate.unlockP2PKH())
      .addOutput({ to: aliceAddress, amount: 5000n })
      .build();

    await expect(provider.sendRawTransaction(transaction)).rejects.toThrow(NetworkProviderMissingInputsError);
  });

  it('should reject a double spend of a mempool transaction', async () => {
    const coin = takeCoin();
    const spendTo = (to: string) => new TransactionBuilder({ provider })
      .addInput(coin, aliceTemplate.unlockP2PKH())
      .addOutput({ to, amount: coin.satoshis - 1000n })
      .build();

    await provider.sendRawTransaction(spendTo(aliceAddress));
    await expect(provider.sendRawTransaction(spendTo(bobAddress))).rejects.toThrow(NetworkProviderMempoolConflictError);
  });

  it('should reject transactions with a block height locktime above the current block height', async () => {
    const blockHeight = await provider.getBlockHeight();
    const buildWithLocktime = (locktime: number, sequence?: number): string => {
      const coin = takeCoin();
      return new TransactionBuilder({ provider })
        .setLocktime(locktime)
        .addInput(coin, aliceTemplate.unlockP2PKH(), { sequence })
        .addOutput({ to: aliceAddress, amount: coin.satoshis - 1000n })
        .build();
    };

    await expect(provider.sendRawTransaction(buildWithLocktime(blockHeight + 2)))
      .rejects.toThrow(NetworkProviderAbsoluteTimelockError);
    await expect(provider.sendRawTransaction(buildWithLocktime(blockHeight))).resolves.toBeTruthy();

    // Final sequence numbers disable the locktime
    await expect(provider.sendRawTransaction(buildWithLocktime(blockHeight + 2, 0xffffffff))).resolves.toBeTruthy();
  });

  it('should reject transactions with an unmet relative timelock', async () => {
    const coin = takeCoin(); // unconfirmed or just confirmed, so 10 blocks have not passed
    const transaction = new TransactionBuilder({ provider })
      .addInput(coin, aliceTemplate.unlockP2PKH(), { sequence: 10 })
      .addOutput({ to: aliceAddress, amount: coin.satoshis - 1000n })
      .build();

    await expect(provider.sendRawTransaction(transaction)).rejects.toThrow(NetworkProviderRelativeTimelockError);
  });

  it('should return CashTokens, including an NFT with an empty commitment', async () => {
    // A token genesis has to spend an output 0, its txid becomes the category
    const coin = coins.find((c) => c.vout === 0) ?? (await (async () => {
      const c = takeCoin();
      const txid = await provider.sendRawTransaction(new TransactionBuilder({ provider })
        .addInput(c, aliceTemplate.unlockP2PKH())
        .addOutput({ to: aliceAddress, amount: c.satoshis - 1000n })
        .build());
      return { ...c, txid, vout: 0, satoshis: c.satoshis - 1000n };
    })());
    const category = coin.txid;

    const genesis = new TransactionBuilder({ provider })
      .addInput(coin, aliceTemplate.unlockP2PKH())
      .addOutput({ to: aliceTokenAddress, amount: 1000n, token: { category, amount: 1_000_000n, nft: { capability: 'none', commitment: '' } } })
      .addOutput({ to: aliceTokenAddress, amount: 1000n, token: { category, amount: 0n, nft: { capability: 'minting', commitment: 'beef' } } })
      .addOutput({ to: aliceTokenAddress, amount: 1000n, token: { category, amount: 2n ** 62n } })
      .addOutput({ to: aliceAddress, amount: coin.satoshis - 5000n })
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

  it('should stream transactions and blocks over gRPC-Web', async () => {
    const controller = new AbortController();
    const events: TransactionEvent[] = [];
    const listening = (async () => {
      for await (const event of provider.subscribeTransactions([bobAddress], { signal: controller.signal })) {
        events.push(event);
        if (event.confirmed) controller.abort();
      }
    })();

    const blockController = new AbortController();
    const blocks = provider.subscribeBlocks({ signal: blockController.signal })[Symbol.asyncIterator]();
    const nextBlock = blocks.next();

    await sleep(500); // let the streams open
    const coin = takeCoin();
    const txid = await provider.sendRawTransaction(new TransactionBuilder({ provider })
      .addInput(coin, aliceTemplate.unlockP2PKH())
      .addOutput({ to: bobAddress, amount: coin.satoshis - 1000n })
      .build());
    const [blockHash] = await generate(1);

    await listening;
    expect(events.map(({ txid: id, confirmed }) => ({ txid: id, confirmed }))).toEqual([
      { txid, confirmed: false },
      { txid, confirmed: true },
    ]);

    const { value: block } = await nextBlock;
    expect(block).toMatchObject({ hash: blockHash, connected: true, height: await provider.getBlockHeight() });
    blockController.abort();
    await expect(blocks.next()).resolves.toMatchObject({ done: true });
  });

  it('should work over native HTTP/2 gRPC with a custom transport', async () => {
    const transport = createGrpcTransport({ baseUrl: GRPC_URL, nodeOptions: { ca: readFileSync(CERT_PATH) } });
    const grpcProvider = new BchdNetworkProvider(Network.REGTEST, { transport });

    await expect(grpcProvider.getBlockHeight()).resolves.toBe(await provider.getBlockHeight());
    await expect(grpcProvider.getUtxos(aliceAddress)).resolves.toEqual(await provider.getUtxos(aliceAddress));
  });
});
