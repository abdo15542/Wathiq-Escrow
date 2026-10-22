# BNB Smart Chain Testnet Deployment

This workflow deploys **only** the project's test token `MockUSDT` (symbol `mUSDT`) and `WathiqUSDTEscrow` to BNB Smart Chain Testnet (chain ID 97). It refuses to run on any other chain and runs the contract test suite first.

## One-time GitHub setup

1. Open **Settings → Environments** in the repository and create an environment named `testnet`.
2. Add environment secrets:
   - `DEPLOYER_PRIVATE_KEY`: a disposable wallet key that holds **testnet tBNB only**. Never use a wallet containing real funds.
   - `BSC_TESTNET_RPC_URL`: an HTTPS BSC Testnet RPC endpoint.
3. Fund that disposable address with testnet tBNB from a trusted testnet faucet.
4. Open **Actions → Deploy Wathiq Testnet Contracts → Run workflow**. Type exactly `deploy-testnet-only` and run it.

The workflow compiles and tests the contracts before deploying, then checks that bytecode exists, that the token is `mUSDT` with 6 decimals, and that the escrow contract points to that token. The resulting addresses are published in the workflow summary and the `wathiq-bsc-testnet-deployment` artifact.

## After a successful run

Copy the escrow and token addresses from the workflow summary into the Render static-site environment variables:
- `WATHIQ_ESCROW_ADDRESS` = escrow address
- `WATHIQ_TOKEN_ADDRESS` = mUSDT token address

Then redeploy the static site and verify the wallet connection, token minting, approve/create, voting, expiry refund, and withdrawal using separate test wallets. This workflow does **not** configure Render automatically.

## Safety boundary

- This deploys testnet contracts only. `mUSDT` is a mock token with no monetary value, not USDT.
- The escrow source is unaudited. Do not deploy it to mainnet or use it to hold real funds.
- Never store a private key in repository files, commit messages, logs, or chat. Use GitHub environment secrets and a disposable test wallet.
- A successful deployment is not a security audit and does not make the product production-ready.
