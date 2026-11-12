import { binToHex, cashAddressToLockingBytecode, encodeCashAddress, hexToBin } from '@bitauth/libauth';
import { Code, ConnectError, createRouterTransport, type ServiceImpl, type Transport } from '@connectrpc/connect';
import {
  Network,
  NetworkProviderAbsoluteTimelockError,
  NetworkProviderError,
  NetworkProviderMempoolConflictError,
  NetworkProviderMissingInputsError,
  NetworkProviderRelativeTimelockError,
  NetworkProviderTransactionAlreadySubmittedError,
} from 'cashscript';
import { BchdNetworkProvider } from '../../src/index.js';
import {
  bchrpc,
  BlockNotification_Type,
  GetBlockchainInfoResponse_BitcoinNet as BitcoinNet,
  type SubscribeTransactionsRequest,
} from '../../src/generated/bchrpc_pb.js';
import { aliceAddress, alicePkh, bobAddress } from '../fixture/vars.js';

const TXID = '3062a3271883951558c9d861ed5a7b747537ba56de68206aa89cdb51f216a9aa';
const CATEGORY = '54e797c69abddb0103582be1715c761eafc0facfc3b7e4e01132ffdcabe3d7b8';
const le = (hex: string) => hexToBin(hex).reverse();
const lockingBytecodeOf = (address: string) => {
  const decoded = cashAddressToLockingBytecode(address);
  if (typeof decoded === 'string') throw new Error(decoded);
  return decoded.bytecode;
};

type Impl = Partial<ServiceImpl<typeof bchrpc>>;

function transportWith(impl: Impl): Transport {
  return createRouterTransport(({ service }) => {
    service(bchrpc, {
      getBlockchainInfo: () => ({ bitcoinNet: BitcoinNet.REGTEST, bestHeight: 123 }),
      ...impl,
    });
  });
}

function providerWith(impl: Impl, network: Network = Network.REGTEST) {
  return new BchdNetworkProvider(network, { transport: transportWith(impl) });
}

const never = () => new Promise<never>(() => {});

describe('BchdNetworkProvider (in-memory transport)', () => {
  describe('construction', () => {
    it('should refuse unsupported networks and missing or conflicting options', () => {
      const transport = transportWith({});
      expect(() => new BchdNetworkProvider(Network.MOCKNET, { url: 'https://localhost' })).toThrow('Unsupported network');
      // the options type forbids these, but JavaScript callers can still pass them
      expect(() => new BchdNetworkProvider(Network.REGTEST, {} as never)).toThrow('needs a url or a transport');
      expect(() => new (BchdNetworkProvider as any)(Network.REGTEST)).toThrow('needs a url or a transport');
      expect(() => new BchdNetworkProvider(Network.REGTEST, { transport, authToken: 'x' } as never)).toThrow('not both');
    });

    it('should send the authentication token as a header', async () => {
      const headers: Headers[] = [];
      vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
        headers.push(new Headers(init.headers));
        return new Response(null, { status: 503 });
      });
      try {
        const provider = new BchdNetworkProvider(Network.REGTEST, { url: 'https://bchd.invalid', authToken: 'secret' });
        await expect(provider.getBlockHeight()).rejects.toThrow();
        expect(headers[0].get('AuthenticationToken')).toBe('secret');
        expect(headers[0].get('content-type')).toBe('application/grpc-web+proto');
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });

  describe('network check', () => {
    it('should refuse a node on another network, for every kind of call', async () => {
      const provider = providerWith({}, Network.MAINNET);
      const message = 'bchd node runs on regtest, but the provider was created for mainnet';
      await expect(provider.getBlockHeight()).rejects.toThrow(message);
      await expect(provider.getUtxos(aliceAddress)).rejects.toThrow(message);
      await expect(provider.getRawTransaction(TXID)).rejects.toThrow(message);
      await expect(provider.sendRawTransaction('00')).rejects.toThrow(message);
      await expect(provider.subscribeBlocks().next()).rejects.toThrow(message);
      await expect(provider.subscribeTransactions([aliceAddress]).next()).rejects.toThrow(message);
    });

    it('should check once, and retry after a failure', async () => {
      let calls = 0;
      const provider = providerWith({
        getBlockchainInfo: () => {
          calls += 1;
          if (calls === 1) throw new ConnectError('node down', Code.Unavailable);
          return { bitcoinNet: BitcoinNet.REGTEST, bestHeight: 5 };
        },
        getRawTransaction: () => ({ transaction: Uint8Array.of(1) }),
      });

      await expect(provider.getRawTransaction(TXID)).rejects.toThrow('node down');
      await expect(provider.getRawTransaction(TXID)).resolves.toBe('01');
      await expect(provider.getRawTransaction(TXID)).resolves.toBe('01');
      expect(calls).toBe(2);
    });

    it('should skip the check with verifyNetwork: false', async () => {
      const getBlockchainInfo = vi.fn(() => ({ bitcoinNet: BitcoinNet.MAINNET }));
      const provider = new BchdNetworkProvider(Network.REGTEST, {
        transport: transportWith({ getBlockchainInfo, getRawTransaction: () => ({ transaction: Uint8Array.of(1) }) }),
        verifyNetwork: false,
      });
      await expect(provider.getRawTransaction(TXID)).resolves.toBe('01');
      expect(getBlockchainInfo).not.toHaveBeenCalled();
    });
  });

  describe('getUtxos', () => {
    it('should map UTXOs, tokens and byte order', async () => {
      const aliceLockingBytecode = lockingBytecodeOf(aliceAddress);
      const outpointHash = le(TXID);
      let requestedAddress: string | undefined;

      const provider = providerWith({
        getAddressUnspentOutputs: (request) => {
          requestedAddress = request.address;
          return {
            outputs: [
              { outpoint: { hash: outpointHash, index: 0 }, pubkeyScript: aliceLockingBytecode, value: 1000n },
              {
                outpoint: { hash: outpointHash, index: 1 },
                pubkeyScript: aliceLockingBytecode,
                value: 800n,
                // fungible amount + NFT with an empty commitment
                cashToken: { categoryId: le(CATEGORY), amount: '42', commitment: new Uint8Array(), bitfield: Uint8Array.of(0x30) },
              },
              {
                outpoint: { hash: outpointHash, index: 2 },
                pubkeyScript: aliceLockingBytecode,
                value: 800n,
                // minting NFT with commitment, no amount
                cashToken: { categoryId: le(CATEGORY), amount: '0', commitment: Uint8Array.of(0xbe, 0xef), bitfield: Uint8Array.of(0x62) },
              },
              // an output with other locking bytecode (bchd files P2PK under the P2PKH address) is left out
              { outpoint: { hash: outpointHash, index: 3 }, pubkeyScript: lockingBytecodeOf(bobAddress), value: 5n },
            ],
          };
        },
      });

      const utxos = await provider.getUtxos(aliceAddress);

      expect(requestedAddress).toBe(aliceAddress);
      expect(utxos).toEqual([
        { txid: TXID, vout: 0, satoshis: 1000n, lockingBytecode: binToHex(aliceLockingBytecode), token: undefined },
        {
          txid: TXID, vout: 1, satoshis: 800n, lockingBytecode: binToHex(aliceLockingBytecode),
          token: { category: CATEGORY, amount: 42n, nft: { capability: 'none', commitment: '' } },
        },
        {
          txid: TXID, vout: 2, satoshis: 800n, lockingBytecode: binToHex(aliceLockingBytecode),
          token: { category: CATEGORY, amount: 0n, nft: { capability: 'minting', commitment: 'beef' } },
        },
      ]);
      // the response buffer was not reversed in place
      expect(outpointHash).toEqual(le(TXID));
    });

    it('should query with the provider\'s network prefix, for any address form', async () => {
      const requested: string[] = [];
      const provider = providerWith({
        getAddressUnspentOutputs: (request) => { requested.push(request.address); return { outputs: [] }; },
      });
      const chipnetTokenAddress = encodeCashAddress({ prefix: 'bchtest', type: 'p2pkhWithTokens', payload: alicePkh }).address;

      await provider.getUtxos(chipnetTokenAddress);
      await provider.getUtxosForLockingBytecode(binToHex(lockingBytecodeOf(aliceAddress)).toUpperCase());
      expect(requested).toEqual([aliceAddress, aliceAddress]);
    });

    it('should refuse invalid input', async () => {
      const provider = providerWith({});
      await expect(provider.getUtxosForLockingBytecode('6a')).rejects.toThrow('can only look up locking bytecode');
      await expect(provider.getUtxosForLockingBytecode('xyz')).rejects.toThrow('not a valid hex string');
      await expect(provider.getUtxos('bitcoincash:nope')).rejects.toThrow('Invalid address');
    });

    it('should explain a missing index', async () => {
      const provider = providerWith({
        getAddressUnspentOutputs: () => { throw new ConnectError('addrindex required', Code.Unavailable); },
      });
      await expect(provider.getUtxos(aliceAddress)).rejects.toThrow('--addrindex and --txindex');
    });

    it('should refuse malformed token data', async () => {
      const outputWith = (bitfield: Uint8Array) => providerWith({
        getAddressUnspentOutputs: () => ({
          outputs: [{
            outpoint: { hash: le(TXID), index: 0 },
            pubkeyScript: lockingBytecodeOf(aliceAddress),
            value: 1000n,
            cashToken: { categoryId: le(CATEGORY), amount: '0', commitment: new Uint8Array(), bitfield },
          }],
        }),
      });
      await expect(outputWith(Uint8Array.of(0x23)).getUtxos(aliceAddress)).rejects.toThrow('Invalid NFT capability: 3');
      await expect(outputWith(Uint8Array.of(0x20, 0x00)).getUtxos(aliceAddress)).rejects.toThrow('Invalid CashToken bitfield');
    });
  });

  describe('getRawTransaction', () => {
    it('should request the hash in little-endian, for upper case txids too', async () => {
      const requested: string[] = [];
      const provider = providerWith({
        getRawTransaction: (request) => { requested.push(binToHex(request.hash)); return { transaction: Uint8Array.of(1, 2) }; },
      });
      await expect(provider.getRawTransaction(TXID)).resolves.toBe('0102');
      await expect(provider.getRawTransaction(TXID.toUpperCase())).resolves.toBe('0102');
      expect(requested).toEqual([binToHex(le(TXID)), binToHex(le(TXID))]);
    });

    it('should refuse an invalid txid', async () => {
      const provider = providerWith({});
      await expect(provider.getRawTransaction('abcd')).rejects.toThrow('Invalid hash');
      await expect(provider.getRawTransaction('z'.repeat(64))).rejects.toThrow('Invalid hash');
    });
  });

  describe('sendRawTransaction', () => {
    it('should send the transaction without SLP checks and return the txid', async () => {
      const requests: { transaction: string; skipSlpValidityCheck: boolean }[] = [];
      const provider = providerWith({
        submitTransaction: (request) => {
          requests.push({ transaction: binToHex(request.transaction), skipSlpValidityCheck: request.skipSlpValidityCheck });
          return { hash: le(TXID) };
        },
      });
      await expect(provider.sendRawTransaction('0200beef')).resolves.toBe(TXID);
      expect(requests).toEqual([{ transaction: '0200beef', skipSlpValidityCheck: true }]);
    });

    it('should refuse invalid hex before sending', async () => {
      const submitTransaction = vi.fn(() => ({ hash: le(TXID) }));
      const provider = providerWith({ submitTransaction });
      await expect(provider.sendRawTransaction('abc')).rejects.toThrow('not a valid hex string');
      await expect(provider.sendRawTransaction('0x02')).rejects.toThrow('not a valid hex string');
      expect(submitTransaction).not.toHaveBeenCalled();
    });

    it.each([
      // bchd's own wording (mempool/mempool.go)
      ['tx rejected: orphan transaction aa references outputs of unknown or fully-spent transaction bb', NetworkProviderMissingInputsError],
      ['tx rejected: output aa:0 already spent by transaction bb in the memory pool', NetworkProviderMempoolConflictError],
      ['tx rejected: already have transaction aa', NetworkProviderTransactionAlreadySubmittedError],
      ['tx rejected: transaction already exists', NetworkProviderTransactionAlreadySubmittedError],
      ['tx rejected: transaction aa is not finalized in the next block (bad-txns-nonfinal)', NetworkProviderAbsoluteTimelockError],
      ['tx rejected: transaction\'s sequence locks on inputs not met', NetworkProviderRelativeTimelockError],
      // BCHN reject reasons, in case bchd starts including them
      ['tx rejected: missing-inputs', NetworkProviderMissingInputsError],
      ['tx rejected: bad-txns-inputs-missingorspent', NetworkProviderMissingInputsError],
      ['tx rejected: txn-mempool-conflict', NetworkProviderMempoolConflictError],
      ['tx rejected: txn-already-in-mempool', NetworkProviderTransactionAlreadySubmittedError],
      ['tx rejected: txn-already-known', NetworkProviderTransactionAlreadySubmittedError],
      ['tx rejected: non-BIP68-final', NetworkProviderRelativeTimelockError],
    ])('should classify "%s"', async (message, ErrorClass) => {
      const provider = providerWith({
        submitTransaction: () => { throw new ConnectError(message, Code.InvalidArgument); },
      });
      const error = await provider.sendRawTransaction('00').catch((e) => e);
      expect(error).toBeInstanceOf(ErrorClass);
      expect(error.originalError).toBe(message);
    });

    it('should turn other rejections into plain errors, and leave other codes alone', async () => {
      const rejecting = providerWith({
        submitTransaction: () => { throw new ConnectError('tx rejected: failed to validate input', Code.InvalidArgument); },
      });
      const rejection = await rejecting.sendRawTransaction('00').catch((e) => e);
      expect(rejection).not.toBeInstanceOf(NetworkProviderError);
      expect(rejection.message).toBe('tx rejected: failed to validate input');

      // An unavailable node whose message happens to look like a reject reason is not a rejection
      const unavailable = providerWith({
        submitTransaction: () => { throw new ConnectError('missing-inputs', Code.Unavailable); },
      });
      const error = await unavailable.sendRawTransaction('00').catch((e) => e);
      expect(error).toBeInstanceOf(ConnectError);
      expect(error.code).toBe(Code.Unavailable);
    });
  });

  describe('subscriptions', () => {
    it('should subscribe with the provider\'s network prefix and the requested notification kinds', async () => {
      const requests: SubscribeTransactionsRequest[] = [];
      const provider = providerWith({
        // eslint-disable-next-line require-yield
        async *subscribeTransactions(request) { requests.push(request); },
      });
      const chipnetBob = encodeCashAddress({ prefix: 'bchtest', type: 'p2pkh', payload: lockingBytecodeOf(bobAddress).slice(3, 23) }).address;

      await provider.subscribeTransactions([chipnetBob], { includeMempool: false }).next();
      await provider.subscribeTransactions([aliceAddress], { includeConfirmed: false }).next();

      expect(requests.map((r) => [r.subscribe?.addresses, r.includeMempool, r.includeInBlock, r.serializeTx])).toEqual([
        [[bobAddress], false, true, true],
        [[aliceAddress], true, false, true],
      ]);
    });

    it('should refuse subscriptions that could never notify', async () => {
      const provider = providerWith({});
      await expect(provider.subscribeTransactions([]).next()).rejects.toThrow('at least one address');
      await expect(provider.subscribeTransactions([aliceAddress], { includeMempool: false, includeConfirmed: false }).next())
        .rejects.toThrow('never notify');
    });

    it('should report connected and disconnected blocks', async () => {
      const provider = providerWith({
        async *subscribeBlocks() {
          yield { type: BlockNotification_Type.CONNECTED, block: { case: 'blockInfo', value: { hash: le(TXID), height: 7 } } };
          yield { type: BlockNotification_Type.DISCONNECTED, block: { case: 'blockInfo', value: { hash: le(TXID), height: 7 } } };
        },
      });
      const blocks = [];
      for await (const block of provider.subscribeBlocks()) blocks.push(block);
      expect(blocks).toEqual([
        { hash: TXID, height: 7, connected: true },
        { hash: TXID, height: 7, connected: false },
      ]);
    });

    it('should end quietly when aborted, also while the network check hangs', async () => {
      const provider = providerWith({ getBlockchainInfo: never });
      const controller = new AbortController();
      const next = provider.subscribeBlocks({ signal: controller.signal }).next();
      controller.abort();
      await expect(next).resolves.toEqual({ done: true, value: undefined });
    });

    it('should end quietly when aborted while streaming', async () => {
      const provider = providerWith({
        async *subscribeBlocks() {
          yield { type: BlockNotification_Type.CONNECTED, block: { case: 'blockInfo', value: { hash: le(TXID), height: 7 } } };
          await never();
        },
      });
      const controller = new AbortController();
      const blocks = provider.subscribeBlocks({ signal: controller.signal });
      await expect(blocks.next()).resolves.toMatchObject({ done: false });
      const next = blocks.next();
      controller.abort();
      await expect(next).resolves.toEqual({ done: true, value: undefined });
    });
  });
});
