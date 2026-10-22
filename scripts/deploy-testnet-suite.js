const fs = require("node:fs");
const path = require("node:path");
const hre = require("hardhat");

async function main() {
  const network = await hre.ethers.provider.getNetwork();
  if (network.chainId !== 97n) {
    throw new Error(`Refusing deployment: expected BNB Smart Chain Testnet chainId 97, received ${network.chainId}.`);
  }
  if (!process.env.DEPLOYER_PRIVATE_KEY) {
    throw new Error("DEPLOYER_PRIVATE_KEY is required as a protected CI secret.");
  }

  const [deployer] = await hre.ethers.getSigners();
  const deployerAddress = await deployer.getAddress();
  const balance = await hre.ethers.provider.getBalance(deployerAddress);
  if (balance === 0n) {
    throw new Error("Deployer has no testnet native token for gas. Fund it with test BNB; never use a mainnet key.");
  }

  console.log("Network: BNB Smart Chain Testnet (chainId 97)");
  console.log("Deployer:", deployerAddress);
  console.log("Test BNB balance:", hre.ethers.formatEther(balance));

  const Token = await hre.ethers.getContractFactory("MockUSDT");
  const token = await Token.deploy();
  await token.waitForDeployment();
  const tokenAddress = await token.getAddress();

  const Escrow = await hre.ethers.getContractFactory("WathiqUSDTEscrow");
  const escrow = await Escrow.deploy(tokenAddress);
  await escrow.waitForDeployment();
  const escrowAddress = await escrow.getAddress();

  const tokenCode = await hre.ethers.provider.getCode(tokenAddress);
  const escrowCode = await hre.ethers.provider.getCode(escrowAddress);
  if (tokenCode === "0x" || escrowCode === "0x") {
    throw new Error("Post-deployment verification failed: contract bytecode missing.");
  }
  if ((await token.symbol()) !== "mUSDT" || (await token.decimals()) !== 6n) {
    throw new Error("Post-deployment verification failed: unexpected test token metadata.");
  }
  if ((await escrow.token()).toLowerCase() !== tokenAddress.toLowerCase()) {
    throw new Error("Post-deployment verification failed: escrow token address mismatch.");
  }

  const deployment = {
    network: "BNB Smart Chain Testnet",
    chainId: 97,
    deployedAt: new Date().toISOString(),
    deployer: deployerAddress,
    token: { name: "Mock USDT", symbol: "mUSDT", decimals: 6, address: tokenAddress },
    escrow: { address: escrowAddress, tokenAddress },
    explorer: {
      token: `https://testnet.bscscan.com/address/${tokenAddress}`,
      escrow: `https://testnet.bscscan.com/address/${escrowAddress}`
    },
    warning: "TESTNET ONLY. mUSDT is a worthless test token. Contract is unaudited. Never use for real funds."
  };
  const outputDir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, "bsc-testnet.json");
  fs.writeFileSync(outputPath, JSON.stringify(deployment, null, 2) + "\n");
  console.log("Verified testnet deployment manifest written to:", outputPath);
  console.log(JSON.stringify(deployment, null, 2));
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
