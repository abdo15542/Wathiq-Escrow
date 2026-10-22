const hre = require("hardhat");
const fs = require("node:fs");
const path = require("node:path");

async function main() {
  const network = await hre.ethers.provider.getNetwork();
  if (network.chainId !== 97n) {
    throw new Error("Refusing deployment: this stack script is BNB Smart Chain Testnet only (chainId 97).");
  }

  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) throw new Error("No deployer configured. Set DEPLOYER_PRIVATE_KEY in your local .env; never commit it.");
  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log("Network: BSC Testnet (97)");
  console.log("Deployer:", deployer.address);
  console.log("Test BNB balance:", hre.ethers.formatEther(balance));

  const Token = await hre.ethers.getContractFactory("MockUSDT", deployer);
  const token = await Token.deploy();
  await token.waitForDeployment();
  const tokenAddress = await token.getAddress();
  const tokenTx = token.deploymentTransaction();
  if (tokenTx) await tokenTx.wait(2);

  const Escrow = await hre.ethers.getContractFactory("WathiqUSDTEscrow", deployer);
  const escrow = await Escrow.deploy(tokenAddress);
  await escrow.waitForDeployment();
  const escrowAddress = await escrow.getAddress();
  const escrowTx = escrow.deploymentTransaction();
  if (escrowTx) await escrowTx.wait(2);

  const result = {
    network: "BNB Smart Chain Testnet",
    chainId: 97,
    deployer: deployer.address,
    tokenName: "Mock USDT (test only; no value)",
    tokenAddress,
    tokenTransaction: tokenTx ? tokenTx.hash : null,
    escrowAddress,
    escrowTransaction: escrowTx ? escrowTx.hash : null,
    deployedAt: new Date().toISOString(),
    explorer: {
      token: "https://testnet.bscscan.com/address/" + tokenAddress,
      escrow: "https://testnet.bscscan.com/address/" + escrowAddress
    },
    warning: "TESTNET ONLY. MockUSDT has no monetary value. The escrow contract is unaudited. Do not use real funds."
  };

  const outDir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, "bsc-testnet.json");
  fs.writeFileSync(outFile, JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
  console.log("Deployment record written to:", outFile);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
