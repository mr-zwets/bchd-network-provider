#!/usr/bin/env bash
# Start a throwaway regtest bchd for the regtest tests.
#   BCHD_BIN=/path/to/bchd scripts/regtest.sh
# Mines to the address in MINING_ADDRESS (the tests' alice by default), serves gRPC(-Web) on
# 127.0.0.1:18335 and JSON-RPC on 127.0.0.1:18334, with its data in .regtest/ (wiped on start).
set -euo pipefail
cd "$(dirname "$0")/.."

BCHD_BIN="${BCHD_BIN:-bchd}"
DIR="$PWD/.regtest"
MINING_ADDRESS="${MINING_ADDRESS:-bchreg:qpgjmwev3spwlwkgmyjrr2s2cvlkkzlewqqkdrtps8}"

rm -rf "$DIR" && mkdir -p "$DIR" && touch "$DIR/bchd.conf"
exec "$BCHD_BIN" --regtest --configfile="$DIR/bchd.conf" --rpccert="$DIR/rpc.cert" --rpckey="$DIR/rpc.key" --datadir="$DIR/data" --logdir="$DIR/logs" \
  --rpcuser=regtest --rpcpass=regtest --rpclisten=127.0.0.1:18334 \
  --grpclisten=127.0.0.1:18335 --txindex --addrindex \
  --listen=127.0.0.1:18444 --nodnsseed --connect=127.0.0.1:1 \
  --miningaddr="$MINING_ADDRESS" --debuglevel=info
