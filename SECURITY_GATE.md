# Wathiq Escrow — Security Gate

Status: unaudited prototype. Testnet only.

## Required before testnet acceptance

- Confirm CI passes for the exact commit being tested.
- Confirm the network chain ID is 97 (BSC Testnet).
- Use only the mock token deployed by the testnet script.
- Test with two separate test wallets.
- Test successful trades, disputes, refunds, and unauthorized calls.
- Test deadline boundaries and duplicate settlement attempts.
- Test tokens that revert, return false, or attempt reentrancy.
- Record contract address, token address, chain ID, and transaction hashes.
- Never commit private keys, seed phrases, or .env files.

## Known limitations

- Reporting fiat payment is a claim, not proof of a bank transfer.
- The moderator is fixed at deployment.
- The API uses in-memory data and is not production persistence.
- The admin interface is a preview, not an authenticated admin console.
- The mobile application is not yet integrated with the deployed contract.

## Before real funds

Require independent smart-contract audit, verified token identity,
secure authentication and authorization, persistent storage, a documented
dispute process, monitoring, key governance, and legal review.

Passing CI is not an audit and does not authorize mainnet use.
