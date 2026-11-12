import {
  binToHex,
  cashAddressToLockingBytecode,
  hashTransaction,
  hexToBin,
  isHex,
  lockingBytecodeToCashAddress,
} from '@bitauth/libauth';
import { createClient, type Client, type Interceptor, type Transport } from '@connectrpc/connect';
import { createGrpcWebTransport } from '@connectrpc/connect-web';
import { Network, type NetworkProvider, type SpendableUtxo } from 'cashscript';
import {
  bchrpc,
  BlockNotification_Type,
  GetBlockchainInfoResponse_BitcoinNet as BitcoinNet,
  TransactionNotification_Type,
} from './generated/bchrpc_pb.js';
import { hashToHex, hexToHash, parseCashToken } from './encoding.js';
import { classifyBroadcastError, toError } from './errors.js';

interface CommonOptions {
  /** Timeout in milliseconds for unary calls. Defaults to 30 seconds. Subscriptions never time out. */
  timeoutMs?: number;
  /**
   * Check on first use that the node runs on `network`, so that a mainnet node is never used as a
   * chipnet one or vice versa. Defaults to true.
   */
  verifyNetwork?: boolean;
}

interface UrlOptions extends CommonOptions {
  /**
   * The `--grpclisten` URL of the bchd node, e.g. `https://bchd.example.com:8335`. bchd serves
   * gRPC-Web on the same port as native gRPC, always over TLS.
   * Used to create a gRPC-Web transport, which only needs `fetch` and so works in browsers and Node.js.
   */
  url: string;
  /** Sent as the `AuthenticationToken` header, for nodes run with `--grpcauthtoken`. */
  authToken?: string;
  transport?: never;
}

interface TransportOptions extends CommonOptions {
  /**
   * A custom Connect v2 transport, used instead of `url`. Use this to e.g. connect over native HTTP/2
   * gRPC in Node.js with `createGrpcTransport` from `@connectrpc/connect-node`. Add an authentication
   * token through the transport's own interceptors.
   */
  transport: Transport;
  url?: never;
  authToken?: never;
}

export type BchdNetworkProviderOptions = UrlOptions | TransportOptions;

export interface TransactionEvent {
  txid: string;
  /** The serialized transaction, hex encoded. */
  transaction: string;
  confirmed: boolean;
}

export interface BlockEvent {
  hash: string;
  height: number;
  /** `false` when the block was disconnected in a reorg. */
  connected: boolean;
}

export interface SubscriptionOptions {
  /** Abort to close the stream. The async iterator then ends without throwing. */
  signal?: AbortSignal;
}

export interface TransactionSubscriptionOptions extends SubscriptionOptions {
  /** Notify of unconfirmed (mempool) transactions. Defaults to true. */
  includeMempool?: boolean;
  /** Notify of transactions again when they confirm. Defaults to true. */
  includeConfirmed?: boolean;
}

type CashAddressPrefix = 'bitcoincash' | 'bchtest' | 'bchreg';

const NETWORK_BY_BITCOIN_NET: Partial<Record<BitcoinNet, Network>> = {
  [BitcoinNet.MAINNET]: Network.MAINNET,
  [BitcoinNet.TESTNET3]: Network.TESTNET3,
  [BitcoinNet.TESTNET4]: Network.TESTNET4,
  [BitcoinNet.CHIPNET]: Network.CHIPNET,
  [BitcoinNet.REGTEST]: Network.REGTEST,
};

const CASHADDRESS_PREFIX: Partial<Record<Network, CashAddressPrefix>> = {
  [Network.MAINNET]: 'bitcoincash',
  [Network.TESTNET3]: 'bchtest',
  [Network.TESTNET4]: 'bchtest',
  [Network.CHIPNET]: 'bchtest',
  [Network.REGTEST]: 'bchreg',
};

/**
 * A CashScript `NetworkProvider` backed by a bchd node's gRPC API.
 *
 * The node must run with `--addrindex` (UTXO lookups) and `--txindex` (`getRawTransaction`).
 */
export default class BchdNetworkProvider implements NetworkProvider {
  /**
   * The generated Connect client, for the bchd RPCs this provider does not wrap. Calls through it
   * are raw: they skip the network check, the default timeout and the error mapping.
   */
  readonly client: Client<typeof bchrpc>;

  private readonly timeoutMs: number;
  private readonly prefix: CashAddressPrefix;
  private networkCheck?: Promise<void>;

  constructor(public readonly network: Network, options: BchdNetworkProviderOptions) {
    const prefix = CASHADDRESS_PREFIX[network];
    if (!prefix) throw new Error(`Unsupported network for BchdNetworkProvider: ${network}`);
    this.prefix = prefix;

    this.client = createClient(bchrpc, createTransport(options));
    this.timeoutMs = options?.timeoutMs ?? 30_000;
    if (options?.verifyNetwork === false) this.networkCheck = Promise.resolve();
  }

  async getUtxos(address: string): Promise<SpendableUtxo[]> {
    return this.getUtxosForLockingBytecode(addressToLockingBytecode(address));
  }

  async getUtxosForLockingBytecode(lockingBytecode: Uint8Array | string): Promise<SpendableUtxo[]> {
    if (typeof lockingBytecode === 'string' && !isHex(lockingBytecode)) {
      throw new Error(`Invalid locking bytecode: ${lockingBytecode} is not a valid hex string`);
    }
    const bytecode = typeof lockingBytecode === 'string' ? hexToBin(lockingBytecode) : lockingBytecode;
    const bytecodeHex = binToHex(bytecode);

    // bchd's address index is keyed by address, so only locking bytecode that has a CashAddress
    // (P2PKH, P2SH20, P2SH32) can be looked up.
    const address = this.toAddress(bytecode);

    const response = await this.call(() => this.client.getAddressUnspentOutputs(
      { address, includeMempool: true },
      { timeoutMs: this.timeoutMs },
    ));

    // bchd also files bare-pubkey (P2PK) outputs under the key's P2PKH address; leave those out.
    return response.outputs
      .filter((output) => binToHex(output.pubkeyScript) === bytecodeHex)
      .map((output) => ({
        txid: hashToHex(output.outpoint!.hash),
        vout: output.outpoint!.index,
        satoshis: output.value,
        lockingBytecode: bytecodeHex,
        token: parseCashToken(output.cashToken),
      }));
  }

  async getBlockHeight(): Promise<number> {
    const response = await this.call(() => this.client.getBlockchainInfo({}, { timeoutMs: this.timeoutMs }));
    return response.bestHeight;
  }

  async getRawTransaction(txid: string): Promise<string> {
    const hash = hexToHash(txid);
    const response = await this.call(() => this.client.getRawTransaction({ hash }, { timeoutMs: this.timeoutMs }));
    return binToHex(response.transaction);
  }

  async sendRawTransaction(txHex: string): Promise<string> {
    if (!isHex(txHex)) throw new Error('Invalid transaction: not a valid hex string');
    await this.verifyNetwork();
    try {
      const response = await this.client.submitTransaction(
        // CashScript transactions are not SLP aware, so don't let an slpindex node refuse them.
        { transaction: hexToBin(txHex), skipSlpValidityCheck: true },
        { timeoutMs: this.timeoutMs },
      );
      return hashToHex(response.hash);
    } catch (error) {
      throw classifyBroadcastError(error);
    }
  }

  /**
   * Stream the transactions that pay to or spend from any of `addresses`. Uses the server-streaming
   * `SubscribeTransactions` RPC, which also works over gRPC-Web in browsers. To change the
   * addresses, abort and subscribe again.
   */
  async *subscribeTransactions(
    addresses: string[],
    options: TransactionSubscriptionOptions = {},
  ): AsyncGenerator<TransactionEvent> {
    if (addresses.length === 0) throw new Error('subscribeTransactions needs at least one address');
    const includeMempool = options.includeMempool ?? true;
    const includeInBlock = options.includeConfirmed ?? true;
    if (!includeMempool && !includeInBlock) {
      throw new Error('subscribeTransactions needs includeMempool or includeConfirmed, or it would never notify');
    }
    // Use the provider's network prefix, as bchd refuses addresses of other networks
    const networkAddresses = addresses.map((address) => this.toAddress(addressToLockingBytecode(address)));

    const stream = this.subscribe(options.signal, () => this.client.subscribeTransactions({
      subscribe: { addresses: networkAddresses },
      includeMempool,
      includeInBlock,
      serializeTx: true,
    }, { signal: options.signal, timeoutMs: 0 }));

    for await (const notification of stream) {
      if (notification.transaction.case !== 'serializedTransaction') continue;
      const transaction = notification.transaction.value;
      yield {
        txid: hashTransaction(transaction),
        transaction: binToHex(transaction),
        confirmed: notification.type === TransactionNotification_Type.CONFIRMED,
      };
    }
  }

  /** Stream the blocks connected to (and disconnected from) the node's best chain. */
  async *subscribeBlocks(options: SubscriptionOptions = {}): AsyncGenerator<BlockEvent> {
    const stream = this.subscribe(options.signal, () => this.client.subscribeBlocks(
      {},
      { signal: options.signal, timeoutMs: 0 },
    ));

    for await (const notification of stream) {
      if (notification.block.case !== 'blockInfo') continue;
      const info = notification.block.value;
      yield {
        hash: hashToHex(info.hash),
        height: info.height,
        connected: notification.type === BlockNotification_Type.CONNECTED,
      };
    }
  }

  private toAddress(bytecode: Uint8Array): string {
    const encoded = lockingBytecodeToCashAddress({ bytecode, prefix: this.prefix });
    if (typeof encoded === 'string') {
      throw new Error(`bchd can only look up locking bytecode that has a CashAddress: ${encoded}`);
    }
    return encoded.address;
  }

  private async call<T>(request: () => Promise<T>): Promise<T> {
    await this.verifyNetwork();
    try {
      return await request();
    } catch (error) {
      throw toError(error);
    }
  }

  /**
   * Run a server stream after the network check. Aborting `signal`, also during the check, ends
   * the iteration quietly instead of throwing a `Canceled` (or connection) error.
   */
  private async *subscribe<T>(signal: AbortSignal | undefined, open: () => AsyncIterable<T>): AsyncGenerator<T> {
    try {
      await untilAborted(this.verifyNetwork(), signal);
      if (signal?.aborted) return;
      yield* open();
    } catch (error) {
      if (signal?.aborted) return;
      throw toError(error);
    }
  }

  private verifyNetwork(): Promise<void> {
    this.networkCheck ??= this.client.getBlockchainInfo({}, { timeoutMs: this.timeoutMs }).then((info) => {
      const nodeNetwork = NETWORK_BY_BITCOIN_NET[info.bitcoinNet];
      if (nodeNetwork !== this.network) {
        throw new Error(`bchd node runs on ${nodeNetwork ?? BitcoinNet[info.bitcoinNet]}, `
          + `but the provider was created for ${this.network}`);
      }
    }).catch((error) => {
      // Retry on the next call, as the node may only have been unreachable.
      this.networkCheck = undefined;
      throw toError(error);
    });
    return this.networkCheck;
  }
}

function addressToLockingBytecode(address: string): Uint8Array {
  const decoded = cashAddressToLockingBytecode(address);
  if (typeof decoded === 'string') throw new Error(`Invalid address ${address}: ${decoded}`);
  return decoded.bytecode;
}

function createTransport(options: BchdNetworkProviderOptions | undefined): Transport {
  const { url, transport, authToken } = options ?? {};
  if (transport) {
    if (url || authToken) throw new Error('Pass either a url (and authToken) or a transport, not both');
    return transport;
  }
  if (!url) throw new Error('BchdNetworkProvider needs a url or a transport');

  const interceptors: Interceptor[] = [];
  if (authToken) {
    interceptors.push((next) => (request) => {
      request.header.set('AuthenticationToken', authToken);
      return next(request);
    });
  }
  return createGrpcWebTransport({ baseUrl: url, interceptors });
}

/** Resolves when `promise` settles, or as soon as `signal` aborts (the shared promise keeps running). */
function untilAborted(promise: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve();
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}
