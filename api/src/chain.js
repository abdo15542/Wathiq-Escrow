'use strict';

// Dependency-free verification of WathiqUSDTEscrow funding transactions.
// The API never trusts a client claim that a deal was funded on-chain: the
// buyer links the createDeal transaction hash, and this module re-reads the
// transaction and its receipt from a JSON-RPC endpoint and checks every
// field against the off-chain deal (contract, sender, parties, amount, and
// the DealCreated event). Constants below come from the compiled contracts.

const CREATE_DEAL_SELECTOR = '0xa2cd4158'; // createDeal(address,address,uint256)
const DEAL_CREATED_TOPIC = '0xc0dc858eb5e76db42fc22f698ea72b0028bc33dee3d481e9be61f0103b51bbd4'; // DealCreated(uint256,address,address,address,uint256)

function chainError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// Deals allow at most 10 decimal places, so toFixed(10) is an exact decimal
// rendering; scaling from the string avoids binary floating point error.
function amountToTokenUnits(amount, decimals = 18) {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    throw chainError('bad_amount', 'amount must be a positive finite number');
  }
  const fixed = amount.toFixed(10);
  const [intPart, fracRaw = ''] = fixed.split('.');
  const frac = fracRaw.replace(/0+$/, '');
  const scale = 10n ** BigInt(decimals);
  const fracUnits = frac ? BigInt(frac.padEnd(decimals, '0')) : 0n;
  return BigInt(intPart) * scale + fracUnits;
}

function wordToAddress(word) {
  return '0x' + String(word).slice(-40).toLowerCase();
}

function decodeCreateDealInput(input) {
  if (typeof input !== 'string' || !input.toLowerCase().startsWith(CREATE_DEAL_SELECTOR)) {
    throw chainError('bad_input', 'transaction is not a WathiqUSDTEscrow createDeal call');
  }
  const hex = input.slice(10);
  if (hex.length !== 192) throw chainError('bad_input', 'unexpected createDeal arguments');
  return {
    seller: wordToAddress(hex.slice(0, 64)),
    arbiter: wordToAddress(hex.slice(64, 128)),
    amount: BigInt('0x' + hex.slice(128, 192)),
  };
}

function parseDealCreatedLog(log, escrowAddress) {
  if (!log || typeof log.address !== 'string') return null;
  if (log.address.toLowerCase() !== String(escrowAddress).toLowerCase()) return null;
  if (!Array.isArray(log.topics) || log.topics[0] !== DEAL_CREATED_TOPIC) return null;
  const data = String(log.data || '0x').slice(2);
  if (log.topics.length < 4 || data.length !== 128) return null;
  return {
    dealId: BigInt(log.topics[1]),
    buyer: wordToAddress(log.topics[2]),
    seller: wordToAddress(log.topics[3]),
    arbiter: wordToAddress(data.slice(0, 64)),
    amount: BigInt('0x' + data.slice(64, 128)),
  };
}

async function rpcCall(rpcUrl, method, params, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
  } catch {
    throw chainError('rpc_error', 'chain RPC is unreachable');
  }
  if (!response.ok) throw chainError('rpc_error', 'chain RPC returned HTTP ' + response.status);
  const payload = await response.json().catch(() => null);
  if (!payload || payload.error) {
    throw chainError('rpc_error', 'chain RPC error: ' + ((payload && payload.error && payload.error.message) || 'invalid response'));
  }
  return payload.result;
}

// expected: { buyer, seller, arbiter, amountUnits } — addresses in any case,
// amountUnits a BigInt of token base units. Returns { chainDealId, blockNumber }.
async function verifyFundingTx({ rpcUrl, escrowAddress, txHash, expected, fetchImpl = fetch }) {
  const tx = await rpcCall(rpcUrl, 'eth_getTransactionByHash', [txHash], fetchImpl);
  if (!tx) throw chainError('tx_not_found', 'transaction not found on chain');
  const receipt = await rpcCall(rpcUrl, 'eth_getTransactionReceipt', [txHash], fetchImpl);
  if (!receipt) throw chainError('tx_not_found', 'transaction receipt not available yet');
  if (receipt.status !== '0x1') throw chainError('tx_failed', 'transaction did not succeed on chain');
  if (String(tx.to || '').toLowerCase() !== String(escrowAddress).toLowerCase()) {
    throw chainError('wrong_contract', 'transaction was not sent to the Wathiq USDT escrow contract');
  }
  if (String(tx.from || '').toLowerCase() !== expected.buyer.toLowerCase()) {
    throw chainError('wrong_sender', 'transaction sender is not the buyer wallet');
  }
  const decoded = decodeCreateDealInput(tx.input);
  if (decoded.seller !== expected.seller.toLowerCase() || decoded.arbiter !== expected.arbiter.toLowerCase()) {
    throw chainError('parties_mismatch', 'on-chain seller and arbiter do not match the deal parties');
  }
  if (decoded.amount !== expected.amountUnits) {
    throw chainError('amount_mismatch', 'on-chain amount does not match the deal amount');
  }
  const logs = Array.isArray(receipt.logs) ? receipt.logs : [];
  let created = null;
  for (const log of logs) {
    const parsed = parseDealCreatedLog(log, escrowAddress);
    if (parsed) { created = parsed; break; }
  }
  if (!created) throw chainError('event_missing', 'DealCreated event not found in the transaction receipt');
  if (
    created.buyer !== expected.buyer.toLowerCase() ||
    created.seller !== expected.seller.toLowerCase() ||
    created.arbiter !== expected.arbiter.toLowerCase() ||
    created.amount !== expected.amountUnits
  ) {
    throw chainError('event_mismatch', 'DealCreated event does not match the deal');
  }
  return { chainDealId: Number(created.dealId), blockNumber: parseInt(receipt.blockNumber, 16) };
}

module.exports = {
  CREATE_DEAL_SELECTOR,
  DEAL_CREATED_TOPIC,
  amountToTokenUnits,
  decodeCreateDealInput,
  parseDealCreatedLog,
  verifyFundingTx,
};
