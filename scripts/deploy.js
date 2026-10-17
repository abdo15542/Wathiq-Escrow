const hre = require("hardhat");
async function main() {
  const Factory = await hre.ethers.getContractFactory("WathiqEscrow");
  const escrow = await Factory.deploy();
  await escrow.waitForDeployment();
  console.log("WathiqEscrow deployed to:", await escrow.getAddress());
  console.log("Network:", hre.network.name, "chainId:", (await hre.ethers.provider.getNetwork()).chainId.toString());
}
main().catch((err) => { console.error(err); process.exitCode = 1; });
