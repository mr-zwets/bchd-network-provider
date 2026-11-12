import { binToHex, hexToBin, isHex } from '@bitauth/libauth';
import type { TokenDetails } from 'cashscript';
import type { CashToken } from './generated/bchrpc_pb.js';

/**
 * bchd sends and expects 32-byte hashes (txids, block hashes, token categories) in the
 * little-endian order used on the wire; wallets and CashScript use the reversed display order.
 * These helpers copy before reversing so response buffers are never mutated in place.
 */
export const hashToHex = (hash: Uint8Array): string => binToHex(hash.slice().reverse());

export const hexToHash = (hex: string): Uint8Array => {
  if (hex.length !== 64 || !isHex(hex)) {
    throw new Error(`Invalid hash: expected 64 hex characters, got "${hex}"`);
  }
  return hexToBin(hex).reverse();
};

// The CashTokens token prefix bitfield (https://cashtokens.org/docs/spec/chip#token-bitfield)
const HAS_AMOUNT = 0x10;
const HAS_NFT = 0x20;
const CAPABILITY_MASK = 0x0f;
const CAPABILITIES = ['none', 'mutable', 'minting'] as const;

type NftCapability = (typeof CAPABILITIES)[number];

/**
 * Convert bchd's CashToken message to CashScript's TokenDetails.
 *
 * NFT-ness is read from the bitfield, not from whether a commitment is present: an NFT with an
 * empty commitment is still an NFT.
 */
export function parseCashToken(cashToken: CashToken | undefined): TokenDetails | undefined {
  if (!cashToken || cashToken.categoryId.length === 0) return undefined;

  if (cashToken.bitfield.length !== 1) {
    throw new Error(`Invalid CashToken bitfield: expected 1 byte, got ${cashToken.bitfield.length}`);
  }
  const bitfield = cashToken.bitfield[0];

  const token: TokenDetails = {
    category: hashToHex(cashToken.categoryId),
    amount: bitfield & HAS_AMOUNT ? BigInt(cashToken.amount) : 0n,
  };

  if (bitfield & HAS_NFT) {
    token.nft = {
      capability: parseCapability(bitfield & CAPABILITY_MASK),
      commitment: binToHex(cashToken.commitment),
    };
  }

  return token;
}

function parseCapability(capability: number): NftCapability {
  const parsed = CAPABILITIES[capability];
  if (parsed === undefined) throw new Error(`Invalid NFT capability: ${capability}`);
  return parsed;
}
