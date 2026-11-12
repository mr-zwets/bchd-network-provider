import { binToHex, cashAddressToLockingBytecode, hexToBin } from '@bitauth/libauth';
import { Code, ConnectError, createRouterTransport, type ServiceImpl } from '@connectrpc/connect';
import {
  Network,
  NetworkProviderAbsoluteTimelockError,
  NetworkProviderMempoolConflictError,
  NetworkProviderMissingInputsError,
  NetworkProviderRelativeTimelockError,
  NetworkProviderTransactionAlreadySubmittedError,
} from 'cashscript';
import { BchdNetworkProvider } from '../../src/index.js';
import { bchrpc, GetBlockchainInfoResponse_BitcoinNet as BitcoinNet } from '../../src/generated/bchrpc_pb.js';
import { aliceAddress, bobAddress } from '../fixture/vars.js';

const TXID = '3062a3271883951558c9d861ed5a7b747537ba56de68206aa89cdb51f216a9aa';
const CATEGORY = '54e797c69abddb0103582be1715c761eafc0facfc3b7e4e01132ffdcabe3d7b8';
const le = (hex: string) => hexToBin(hex).reverse();
const lockingBytecodeOf = (address: string) => {
  const decoded = cashAddressToLockingBytecode(address);
  if (typeof decoded === 'string') throw new Error(decoded);
  return decoded.bytecode;
};

function providerWith(impl: Partial<ServiceImpl<typeof bchrpc>>, network: Network = Network.REGTEST) {
  const transport = createRouterTransport(({ service }) => {
    service(bchrpc, {
      getBlockchainInfo: () => ({ bitcoinNet: BitcoinNet.REGTEST, bestHeight: 123 }),
      ...impl,
    });
  });
  return new BchdNetworkProvider(network, { transport });
}

describe('BchdNetworkProvider (in-memory transport)', () => {
  it('should refuse unsupported networks and a missing url', () => {
    expect(() => new BchdNetworkProvider(Network.MOCKNET, { url: 'https://localhost' })).toThrow('Unsupported network');
    expect(() => new BchdNetworkProvider(Network.REGTEST, {})).toThrow('needs a url or a transport');
  });

  it('should return the block height', async () => {
    await expect(providerWith({}).getBlockHeight()).resolves.toBe(123);
  });

  it('should refuse to talk to a node on another network', async () => {
    const provider = providerWith({}, Network.MAINNET);
    await expect(provider.getBlockHeight()).rejects.toThrow('bchd node runs on regtest, but the provider was created for mainnet');
  });

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
            // an output with other locking bytecode is left out
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

  it('should refuse locking bytecode without a CashAddress', async () => {
    const provider = providerWith({});
    await expect(provider.getUtxosForLockingBytecode('6a')).rejects.toThrow('can only look up UTXOs');
    await expect(provider.getUtxosForLockingBytecode('xyz')).rejects.toThrow('not a valid hex string');
  });

  it('should explain a missing index', async () => {
    const provider = providerWith({
      getAddressUnspentOutputs: () => { throw new ConnectError('addrindex required', Code.Unavailable); },
    });
    await expect(provider.getUtxos(aliceAddress)).rejects.toThrow('--addrindex and --txindex');
  });

  it('should send transactions in little-endian and return the txid', async () => {
    const provider = providerWith({ submitTransaction: () => ({ hash: le(TXID) }) });
    await expect(provider.sendRawTransaction('00')).resolves.toBe(TXID);
  });

  it.each([
    ['tx rejected: orphan transaction aa references outputs of unknown or fully-spent transaction bb', NetworkProviderMissingInputsError],
    ['tx rejected: output aa:0 already spent by transaction bb in the memory pool', NetworkProviderMempoolConflictError],
    ['tx rejected: already have transaction aa', NetworkProviderTransactionAlreadySubmittedError],
    ['tx rejected: transaction already exists', NetworkProviderTransactionAlreadySubmittedError],
    ['tx rejected: transaction aa is not finalized in the next block (bad-txns-nonfinal)', NetworkProviderAbsoluteTimelockError],
    ['tx rejected: transaction\'s sequence locks on inputs not met', NetworkProviderRelativeTimelockError],
  ])('should classify "%s"', async (message, ErrorClass) => {
    const provider = providerWith({
      submitTransaction: () => { throw new ConnectError(message, Code.InvalidArgument); },
    });
    await expect(provider.sendRawTransaction('00')).rejects.toThrow(ErrorClass);
  });
});
