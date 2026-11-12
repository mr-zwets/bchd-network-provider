import { Code, ConnectError } from '@connectrpc/connect';
import {
  NetworkProviderMissingInputsError,
  NetworkProviderMempoolConflictError,
  NetworkProviderTransactionAlreadySubmittedError,
  NetworkProviderAbsoluteTimelockError,
  NetworkProviderRelativeTimelockError,
} from 'cashscript';

/**
 * bchd answers a rejected SubmitTransaction with `InvalidArgument: tx rejected: <description>`.
 * The description is bchd's own text, which only sometimes contains the BCHN reject reason
 * (e.g. `bad-txns-nonfinal`), so both the bchd wording and the BCHN reasons are matched.
 * See mempool/mempool.go in bchd.
 */
const PATTERNS: [RegExp, new (message: string) => Error][] = [
  [/references outputs of unknown or fully-spent|missing-inputs|bad-txns-inputs-missingorspent/i,
    NetworkProviderMissingInputsError],
  [/already spent by transaction .* in the memory pool|txn-mempool-conflict/i,
    NetworkProviderMempoolConflictError],
  [/already have transaction|transaction already exists|txn-already-in-mempool|txn-already-known/i,
    NetworkProviderTransactionAlreadySubmittedError],
  [/bad-txns-nonfinal|is not finalized/i,
    NetworkProviderAbsoluteTimelockError],
  [/sequence locks on inputs not met|non-BIP68-final/i,
    NetworkProviderRelativeTimelockError],
];

export function classifyBroadcastError(error: unknown): Error {
  if (!(error instanceof ConnectError) || error.code !== Code.InvalidArgument) {
    return toError(error);
  }

  const message = error.rawMessage;
  for (const [pattern, ErrorClass] of PATTERNS) {
    if (pattern.test(message)) return new ErrorClass(message);
  }
  return new Error(message);
}

/**
 * Turn the errors that point at a misconfigured node into actionable messages.
 */
export function toError(error: unknown): Error {
  if (error instanceof ConnectError && error.code === Code.Unavailable && /index required/.test(error.rawMessage)) {
    return new Error(`bchd node is missing a required index (${error.rawMessage}). `
      + 'BchdNetworkProvider needs a node run with --addrindex and --txindex.');
  }
  return error instanceof Error ? error : new Error(String(error));
}
