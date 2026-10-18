const hre = require("hardhat");

async function main() {
  const network = await hre.ethers.provider.getNetwork();
  if (network.chainId !== 97n) {
    throw new Error("Refusing deployment: test token can only be deployed to BSC Testnet (chainId 97).");
  }
  const Factory = await hre.ethers.getContractFactory("MockUSDT");
  const token = await Factory.deploy();
  await token.waitForDeployment();
  console.log("TEST-ONLY MockUSDT deployed to:", await token.getAddress());
  console.log("Network: BSC Testnet (chainId 97)");
  console.log("WARNING: this token is worthless test data, NOT real USDT.");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
