# Wathiq Escrow — BSC Testnet deployment runbook

This runbook deploys **test-only** contracts. It does not make Wathiq production-ready and must not be used with real money.

## 1. Prepare a deployer wallet

1. Create a fresh wallet dedicated to BNB Smart Chain Testnet. Do not use a wallet that holds assets.
2. Obtain test BNB from an official BNB Chain testnet faucet. Test BNB has no monetary value.
3. In a local clone of this repository, create a local `.env` file (it must remain untracked) and set:
   ```dotenv
   BSC_TESTNET_RPC_URL=https://bsc-testnet-dataseed.bnbchain.org
   DEPLOYER_PRIVATE_KEY=0xYOUR_TEST_WALLET_PRIVATE_KEY
   ```
4. Never paste the private key into ChatGPT, issues, commits, screenshots, or Render environment variables. Confirm `.env` is ignored by Git before proceeding.

## 2. Install and deploy

From the repository root:

```bash
npm ci
npm run compile
npm test
npm run deploy:stack:testnet
```

The script refuses to run unless the connected chain ID is 97. It deploys the test-only `MockUSDT` token and `WathiqUSDTEscrow`, waits for confirmations, prints both transaction hashes and explorer links, and writes `deployments/bsc-testnet.json` locally. Verify both transactions and contract addresses on https://testnet.bscscan.com.

`MockUSDT` is an unrestricted-mint test token and has **no monetary value**. It is not official Tether USDT.

## 3. Configure the test website

Only after independently verifying both deployment transactions, set the Render static site's environment variables:

- `WATHIQ_ESCROW_ADDRESS`: the deployed escrow address.
- `WATHIQ_TOKEN_ADDRESS`: the deployed MockUSDT address.
- `WATHIQ_CHAIN_ID`: `97`.
- `WATHIQ_API_BASE_URL`: the verified HTTPS API origin.

Then trigger a new static-site deploy. Do not commit the generated `deployments/bsc-testnet.json` unless you intentionally want to publish those public addresses. Never include secrets in it.

## 4. End-to-end test checklist

Use at least three separate test accounts (buyer, seller, and platform/arbiter). Verify:

- buyer connects to chain ID 97 and receives test tokens;
- allowance is granted only to the verified escrow contract;
- deal creation transfers the exact amount into escrow;
- a single vote does not settle the deal;
- two compatible votes settle the deal only once;
- buyer refund path and 30-day timeout path behave as intended;
- only the rightful recipient can withdraw a settled balance;
- wrong-network, wrong-token, rejected transaction, and RPC failure states are shown clearly.

Record the transaction links and results. A successful deployment or passing local tests is not an audit and does not prove all UI/API flows work.

## Production gate — not complete

Do not accept real funds until the contract receives an independent security audit, a mainnet deployment and verified addresses are reviewed, signing/admin operations are secured, API/database backups and monitoring are configured, the dispute/refund policy is legally reviewed for the jurisdictions served, and a full end-to-end test is documented. This repository's mobile app still does not perform on-chain escrow transactions.
