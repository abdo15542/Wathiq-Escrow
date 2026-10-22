# BNB Smart Chain Testnet Deployment

This workflow deploys only the test token `MockUSDT` (symbol `mUSDT`) and `WathiqUSDTEscrow` to BNB Smart Chain Testnet (chain ID 97). It refuses other chains and runs the contract test suite first.

## GitHub setup

1. Open repository **Settings → Environments** and create an environment named `testnet`.
2. Add environment secrets:
   - `DEPLOYER_PRIVATE_KEY`: a disposable wallet key that holds testnet tBNB only. Never use a wallet containing real funds.
   - `BSC_TESTNET_RPC_URL`: an HTTPS BSC Testnet RPC endpoint.
3. Fund that disposable address with testnet tBNB from a trusted testnet faucet.
4. Open **Actions → Deploy Wathiq Testnet Contracts → Run workflow** and type exactly `deploy-testnet-only`.

The workflow compiles and tests contracts, deploys the mock token and escrow, verifies bytecode, token metadata, and escrow/token linkage, then uploads a deployment manifest.

## After successful deployment

Copy addresses from the workflow summary into the Render static-site environment variables:
- `WATHIQ_ESCROW_ADDRESS` = escrow address
- `WATHIQ_TOKEN_ADDRESS` = mUSDT token address

Redeploy the static site and test connect, mint test tokens, approve/create, votes, expiry refund, and withdrawal with separate test wallets. This workflow does not configure Render automatically.

## Safety

`mUSDT` is a worthless test token, not real USDT. The escrow contract is unaudited. Do not deploy to mainnet or use for real funds. Never put private keys in repository files or chat; use protected GitHub environment secrets.
