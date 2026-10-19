# Wathiq Escrow — واثق

A development monorepo for Wathiq Escrow. **This repository is still under development and is not a production-ready financial service.** Do not use mainnet funds until independent security and legal reviews, complete integration tests, and an operational dispute process are in place.

## Components

- `contracts/WathiqEscrow.sol`: native-BNB escrow with 2-of-3 decisions and pull withdrawals.
- `contracts/WathiqUSDTEscrow.sol`: new ERC-20 escrow primitive with exact-received-amount checking, 2-of-3 decisions, pull withdrawals, and a 30-day unresolved-deal refund to the buyer. It is unaudited and only suitable for local/testnet validation. The timeout is a product-policy choice and must be reviewed.
- `test/`: Hardhat tests for BNB escrow and ERC-20 escrow flows, including participant validation, conflicting votes, settlement, pull withdrawals and timeout refunds. `contracts/test/MockUSDT.sol` is a worthless test token only.
- `api/`: Express API with email/password registration and login, scrypt password hashing, signed bearer tokens, owner-protected offer closure, input validation, basic per-IP throttles, and PostgreSQL persistence when `DATABASE_URL` is configured. In development without a database it uses in-memory data only. Production startup refuses to run without PostgreSQL and a `JWT_SECRET` of at least 32 characters. This is not yet a complete escrow backend.
- `web/`: responsive Arabic-first public site plus an admin dashboard at `/admin.html`. The dashboard signs in through the API, checks the database-backed administrator role, and can inspect users/offers and close offers. Wallet detection does not imply contract integration.
- `mobile/`: Flutter Android client with account registration/login, encrypted platform secure storage for the session token, public offer browsing, and authenticated offer creation. It still does not create or settle blockchain escrow deals.
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

## API accounts and persistence

- `POST /api/auth/register` accepts `{ "email", "displayName", "password" }`; passwords must be at least 10 characters.
- `POST /api/auth/login` returns a signed bearer token; send it as `Authorization: Bearer <token>`.
- `GET /api/auth/me` returns the current account; `POST /api/offers` requires authentication; `GET /api/my/offers` lists only the signed-in account's offers (including closed offers); `PATCH /api/offers/:id/close` only permits the offer owner to close it.
- Admin API: `/api/admin/overview`, `/api/admin/users`, `/api/admin/offers`, and `PATCH /api/admin/offers/:id/close` require a database-backed `admin` role. The dashboard is at `/admin.html`.
- To grant admin rights to an already registered account, run `DATABASE_URL=... npm --prefix api run admin:promote -- admin@example.com` from a trusted one-off shell with the production database URL provided securely. Never paste the database URL into chat or commit it. This command updates only an existing account; no public endpoint can grant admin rights.
- Configure `DATABASE_URL` to a managed PostgreSQL database and `JWT_SECRET` to a random secret of at least 32 characters in the deployment environment. Do not commit either secret. PostgreSQL connections verify TLS certificates by default; production startup refuses `PGSSLMODE=disable`. Pool size is bounded to 1–100 connections (default 10). Production API startup intentionally fails if either database or signing secret is missing.
- The current rate limits are per-process memory limits, not distributed limits; add a gateway or shared limiter before a public production launch.


### Render deployment

`render.yaml` defines both the API and the static web app. In the Render Blueprint setup, provide a persistent PostgreSQL `DATABASE_URL` for the API and the actual web origin for API `CORS_ORIGIN`. The static site build accepts `WATHIQ_API_BASE_URL`, `WATHIQ_ESCROW_ADDRESS`, and `WATHIQ_TOKEN_ADDRESS`; keep chain ID at `97` for testnet. The Render Blueprint now provisions `wathiq-escrow-api`, associates the `wathiq-escrow-db` database, and deploys `wathiq-escrow-web`. Confirm `/health` and exercise registration, login, and offer creation after every deployment. The free Render database is temporary and expires unless upgraded; do not treat this configuration as durable production infrastructure.

## Android APK

From `mobile/` run:

```bash
flutter pub get
flutter analyze
flutter test
export WATHIQ_API_BASE_URL='https://YOUR-DEPLOYED-API-ORIGIN'
flutter build apk --release --dart-define=WATHIQ_API_BASE_URL="$WATHIQ_API_BASE_URL"
```

The GitHub Actions workflow runs Flutter analysis and tests on each change. Before building a release APK, it requires the repository Actions variable `WATHIQ_API_BASE_URL` to be set to the HTTPS origin of the actually deployed API (for example, `https://wathiq-escrow-api.onrender.com` only after `/health` has been verified). If the variable is missing or not HTTPS, the release build intentionally fails rather than embedding an unverified endpoint. Add it under **Settings → Secrets and variables → Actions → Variables**. The APK is published as the `wathiq-android-apk` workflow artifact when the build passes; a successful build does not by itself prove that the app's live API calls or blockchain escrow flows work end to end.

## Deploy to BSC testnet (manual only)

For the ERC-20 escrow test flow, deploy a test-only token and then the escrow contract. After the token and escrow addresses are configured in the static site's environment, connect a wallet on BSC Testnet and use **الحصول على 1000 رمز اختبار** to mint worthless `mUSDT` for that wallet. The faucet refuses to run on other chain IDs or when the configured token symbol is not `mUSDT`.

```bash
npm run deploy:mock-usdt:testnet
# Copy the printed test token address into WATHIQ_TEST_TOKEN_ADDRESS in .env
npm run deploy:usdt:testnet
```

These commands refuse to run unless the selected network reports chain ID 97. `MockUSDT` is not real USDT and has no monetary value. This deployment is not a production release.

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
