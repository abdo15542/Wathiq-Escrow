# Wathiq Escrow — واثق

A development monorepo for a BNB Smart Chain P2P escrow product. **This repository is an MVP foundation, not a production-ready financial service.** Do not use mainnet funds until independent security and legal reviews, complete integration tests, and an operational dispute process are in place.

## Components

- `contracts/WathiqEscrow.sol`: native-BNB escrow with one vote per participant and 2-of-3 matching decisions (buyer, seller, arbiter). Settled funds are credited to `pendingWithdrawals` and claimed separately (pull payments), so a recipient contract cannot block the vote/settlement transaction by rejecting BNB.
- `test/`: Hardhat tests for participant validation, conflicting votes, settlement, pull withdrawals and inactive deals.
- `api/`: Express development API for offer drafts, pagination, filtering, retrieval, validation, security headers, configurable CORS and a basic in-memory create rate limit. **Data is in memory and disappears on restart. This is not production persistence or identity/authentication.**
- `web/`: responsive Arabic-first public site and admin-preview page. The admin page is a visual preview only, not an authenticated admin console. Wallet detection does not imply contract integration.
- `mobile/`: Flutter Android starter app. It is not yet connected to the API or deployed contract.
- `.github/workflows/ci.yml`: CI checks for the contract, API, static web bundle, and Flutter Android build; the APK is uploaded as a workflow artifact only when the build succeeds.

## Networks

- BNB Smart Chain Testnet: chain ID `97`; RPC default `https://bsc-testnet-dataseed.bnbchain.org`; explorer `https://testnet.bscscan.com/`.
- BNB Smart Chain Mainnet: chain ID `56`. Mainnet deployment is intentionally not included in CI.

## Local development

Requirements: Node.js 20+ and npm. For Android, install Flutter 3.24+ and Android SDK.

```bash
npm install
npm --prefix api install
npm test
npm run test:api
npm run build:web
npm --prefix api start
```

The web preview expects the API at `http://localhost:4000` and can be served from `web/dist` on port `4173` (or another static server). Set `window.WATHIQ_API` before `app.js` if the API URL differs. Set `CORS_ORIGIN` to the exact deployed site origin for a deployment.

Contract tests use Hardhat's local EVM. A passing local test suite does **not** prove a live BSC deployment or audit has passed.

## Android APK

From `mobile/` run:

```bash
flutter pub get
flutter analyze
flutter test
flutter build apk --release
```

The GitHub Actions workflow builds `mobile/build/app/outputs/flutter-apk/app-release.apk` and publishes it as a workflow artifact only after all relevant steps succeed. No APK is claimed to exist until that workflow actually passes.

## Deploy to BSC testnet (manual only)

1. Copy `.env.example` to `.env`.
2. Set `BSC_TESTNET_RPC_URL` and `DEPLOYER_PRIVATE_KEY` using a wallet that contains **test BNB only**.
3. Run `npm run deploy:testnet`.
4. Record the deployed address and verify the source on the testnet explorer.
5. Never commit `.env`, seed phrases, private keys, or service credentials.

## Contract behavior and limitations

A deal accepts native BNB only. Each participant can cast exactly one vote: release to seller or refund to buyer. Two matching votes settle the deal and credit the recipient's withdrawable balance. If the votes split, funds remain escrowed until the third participant votes. This is a simple on-chain voting primitive; it does not establish that the arbiter is fair or that a bank transfer occurred, and it has no automatic timeout/recovery path. Choose the arbiter carefully and never use real funds with this version.

Not implemented for production: ERC-20 stablecoins, bank/payment verification, authenticated user accounts, KYC/AML, encrypted chat, dispute evidence workflow, real admin authorization, persistent database, production monitoring, wallet-to-contract integration, mobile API integration, notifications, audited key governance, and legal terms. The API's rate limit is in-memory and is not a substitute for a production gateway or distributed limiter.

## Required before launch

Independent smart-contract audit; formal threat model; tests on BSC testnet; key/arbiter governance; timeout and recovery policy; database migrations and backups; authentication/authorization; abuse prevention; privacy/security review; monitoring and incident response; user-facing terms; and legal/regulatory review for Libya and every target market.
