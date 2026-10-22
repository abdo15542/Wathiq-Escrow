const hre = require("hardhat");

async function main() {
  const network = await hre.ethers.provider.getNetwork();
  if (network.chainId !== 97n) {
    throw new Error("Refusing deployment: this script is restricted to BNB Smart Chain Testnet (chainId 97).");
  }
  const tokenAddress = process.env.WATHIQ_TEST_TOKEN_ADDRESS;
  if (!tokenAddress || !hre.ethers.isAddress(tokenAddress) || tokenAddress === hre.ethers.ZeroAddress) {
    throw new Error("Set WATHIQ_TEST_TOKEN_ADDRESS to a verified test ERC-20 token address. Never use a mainnet token here.");
  }
  const code = await hre.ethers.provider.getCode(tokenAddress);
  if (code === "0x") throw new Error("No contract code exists at WATHIQ_TEST_TOKEN_ADDRESS.");

  const Factory = await hre.ethers.getContractFactory("WathiqUSDTEscrow");
  const escrow = await Factory.deploy(tokenAddress);
  await escrow.waitForDeployment();
  console.log("WathiqUSDTEscrow deployed to:", await escrow.getAddress());
  console.log("Test token:", tokenAddress);
  console.log("Network:", hre.network.name, "chainId:", network.chainId.toString());
  console.log("Explorer: https://testnet.bscscan.com/address/" + await escrow.getAddress());
  console.log("WARNING: testnet only; this source is unaudited and must not hold real funds.");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
