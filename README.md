# Wathiq Escrow — واثق

A development monorepo for a BNB Smart Chain P2P escrow product. **This repository is an MVP foundation, not a production-ready financial service.** Do not use mainnet funds until independent security and legal reviews, complete integration tests, and an operational dispute process are in place.

## Components

- `contracts/WathiqEscrow.sol`: native-BNB escrow with one vote per participant and 2-of-3 matching decisions (buyer, seller, arbiter). Settled funds are credited to `pendingWithdrawals` and claimed separately.
- `api/`: Express API for offer drafts. When `DATABASE_URL` is configured it persists offers in PostgreSQL; without it, the API uses in-memory data for local tests only. `/health` reports the persistence mode and returns HTTP 503 if configured database connectivity/schema initialization fails.
- `web/`: responsive Arabic-first public site. The admin page remains a visual preview, not a secured admin console; wallet detection is not smart-contract integration.
- `mobile/`: Flutter Android starter app; mobile API and deployed-contract integration still require end-to-end verification.
- `.github/workflows/ci.yml`: contract, API, web build and Android APK CI. APK is only available as an artifact after a successful workflow.

## API deployment on Render

The Blueprint expects an existing Render PostgreSQL database named `wathiq-escrow-db` and injects its internal connection string as `DATABASE_URL`. If your database has a different Render resource name, update `render.yaml` to match it before applying the Blueprint. Set `CORS_ORIGIN` to the exact public website origin. Do not put passwords, wallet keys or connection strings in source control.

API endpoints currently implemented:
- `GET /health`
- `GET /api/offers?asset=BNB&limit=20&offset=0`
- `GET /api/offers/:id`
- `POST /api/offers`

Offer creation currently has basic validation and an in-process per-IP rate limit. **There is not yet user authentication, authorization, verified payment, KYC/AML, or a real admin workflow.** Do not present draft offers as completed or verified trades.

## Networks and development

- BNB Smart Chain Testnet: chain ID `97`; RPC default `https://bsc-testnet-dataseed.bnbchain.org`; explorer `https://testnet.bscscan.com/`.
- Mainnet deployment is intentionally not included in CI.

Requirements: Node.js 20+ and npm. For Android, install Flutter and Android SDK.

```bash
npm install
npm install --prefix api
npm test
npm run test:api
npm run build:web
npm --prefix api start
```

Contract tests use Hardhat's local EVM; passing tests do not prove a live BSC deployment or audit.

## Android APK

From `mobile/` run `flutter pub get`, `flutter analyze`, `flutter test`, and `flutter build apk --release`. GitHub Actions publishes the APK only after a successful build.

## Contract limitations and launch gate

A deal accepts native BNB only. Each participant casts one vote: release to seller or refund to buyer. Two matching votes settle the deal and credit the recipient's withdrawable balance. Split votes leave funds escrowed until the third participant votes; there is no automatic timeout/recovery. This is not proof that a bank transfer occurred and does not establish a fair arbiter.

Before handling real money: independent smart-contract audit; threat model; BSC testnet integration tests; timeout/recovery and arbiter governance; authenticated accounts and role-based access; payment verification; secure dispute evidence; database migrations/backups; abuse prevention; monitoring/incident response; privacy/legal review; and tested operational support.
