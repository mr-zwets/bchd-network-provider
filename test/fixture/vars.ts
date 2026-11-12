// Adapted from cashscript/packages/cashscript/test/fixture/vars.ts, with regtest addresses.
import {
  deriveHdPath,
  deriveHdPrivateNodeFromSeed,
  deriveSeedFromBip39Mnemonic,
  encodeCashAddress,
  hash160,
  secp256k1,
} from '@bitauth/libauth';

const seed = deriveSeedFromBip39Mnemonic('CashScript Tests');
const rootNode = deriveHdPrivateNodeFromSeed(seed, { assumeValidity: true, throwErrors: true });
const baseDerivationPath = "m/44'/145'/0'/0";

function deriveKeys(index: number) {
  const node = deriveHdPath(rootNode, `${baseDerivationPath}/${index}`);
  if (typeof node === 'string') throw new Error(node);
  const priv = node.privateKey;
  const pub = secp256k1.derivePublicKeyCompressed(priv) as Uint8Array;
  const pkh = hash160(pub);
  const address = encodeCashAddress({ prefix: 'bchreg', type: 'p2pkh', payload: pkh, throwErrors: true }).address;
  const tokenAddress = encodeCashAddress({ prefix: 'bchreg', type: 'p2pkhWithTokens', payload: pkh, throwErrors: true }).address;
  return { priv, pub, pkh, address, tokenAddress };
}

const alice = deriveKeys(0);
const bob = deriveKeys(1);

export const { priv: alicePriv, pub: alicePub, pkh: alicePkh, address: aliceAddress, tokenAddress: aliceTokenAddress } = alice;
export const { priv: bobPriv, pub: bobPub, pkh: bobPkh, address: bobAddress, tokenAddress: bobTokenAddress } = bob;
