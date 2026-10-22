const hre = require("hardhat");

async function main() {
  const network = await hre.ethers.provider.getNetwork();
  if (network.chainId !== 97n) {
    throw new Error(
      "Refusing deployment: WathiqEscrow is configured for BSC Testnet only (chainId 97)."
    );
  }

  const signers = await hre.ethers.getSigners();
  if (signers.length === 0) {
    throw new Error(
      "No deployer configured. Set DEPLOYER_PRIVATE_KEY in the environment; never commit private keys."
    );
  }

  const Factory = await hre.ethers.getContractFactory("WathiqEscrow");
  const escrow = await Factory.deploy();
  await escrow.waitForDeployment();

  console.log("WathiqEscrow deployed to:", await escrow.getAddress());
  console.log("Network: BSC Testnet (chainId 97)");
  console.log("WARNING: Testnet deployment only; do not use for real funds.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
