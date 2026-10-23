# BNB Smart Chain Testnet Deployment

The current website integrates with `contracts/WathiqEscrow.sol`, which escrows native testnet BNB (tBNB) on BNB Smart Chain Testnet (chain ID 97). It does not use an ERC-20 token contract.

## GitHub setup

1. Open repository **Settings → Environments** and create an environment named `testnet`.
2. Add environment secrets:
   - `DEPLOYER_PRIVATE_KEY`: a disposable wallet key funded with testnet tBNB only. Never use a wallet containing real funds.
   - `BSC_TESTNET_RPC_URL`: an HTTPS BSC Testnet RPC endpoint.
3. Fund that disposable address with enough testnet tBNB for deployment and automated lifecycle checks; the script requires at least 0.02 tBNB.
4. Open **Actions → Deploy Wathiq Testnet Contracts → Run workflow** and type exactly `deploy-testnet-only`.

The workflow compiles and tests the repository, deploys `WathiqEscrow`, verifies deployed bytecode and chain ID, then executes on-chain release and refund flows with disposable participant wallets. It verifies withdrawals by the seller and buyer and confirms no funds remain in the escrow contract. A deployment manifest is uploaded as an Actions artifact.

## After successful deployment

Copy `escrow.address` from the workflow summary/artifact into the Render static-site environment variable:

- `WATHIQ_ESCROW_ADDRESS` = deployed `WathiqEscrow` address

Keep `WATHIQ_CHAIN_ID=97`. Redeploy the static site and verify the address in the testnet explorer. The workflow does not configure Render automatically. Do not set an ERC-20 token address; the current website uses native tBNB.

## Safety

This deployment is testnet only. tBNB has no mainnet value. The contract has not undergone an independent security audit and must not hold real funds. Never put private keys in repository files or chat; use protected GitHub environment secrets. Do not deploy this workflow to mainnet.
