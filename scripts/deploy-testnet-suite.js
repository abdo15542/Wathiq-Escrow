const fs = require("node:fs");
const path = require("node:path");
const hre = require("hardhat");

async function main() {
  const network = await hre.ethers.provider.getNetwork();
  if (network.chainId !== 97n) {
    throw new Error(`Refusing deployment: expected BNB Smart Chain Testnet chainId 97, received ${network.chainId}.`);
  }
  if (!process.env.DEPLOYER_PRIVATE_KEY) throw new Error("DEPLOYER_PRIVATE_KEY is required as a protected CI secret.");

  const [deployer] = await hre.ethers.getSigners();
  const deployerAddress = await deployer.getAddress();
  const balance = await hre.ethers.provider.getBalance(deployerAddress);
  if (balance === 0n) throw new Error("Deployer has no testnet native token for gas. Fund it with test BNB; never use a mainnet key.");

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
  if (tokenCode === "0x" || escrowCode === "0x") throw new Error("Post-deployment verification failed: contract bytecode missing.");
  if ((await token.symbol()) !== "mUSDT" || (await token.decimals()) !== 6n) throw new Error("Post-deployment verification failed: unexpected test token metadata.");
  if ((await escrow.token()).toLowerCase() !== tokenAddress.toLowerCase()) throw new Error("Post-deployment verification failed: escrow token address mismatch.");

  // Exercise the complete escrow lifecycle on-chain with worthless test tokens.
  // Fresh temporary wallets are used only for this one test and their keys are never persisted.
  const sellerWallet = hre.ethers.Wallet.createRandom().connect(hre.ethers.provider);
  const arbiterWallet = hre.ethers.Wallet.createRandom().connect(hre.ethers.provider);
  const testGas = hre.ethers.parseEther("0.002");
  const gasFunding = await Promise.all([
    deployer.sendTransaction({ to: sellerWallet.address, value: testGas }),
    deployer.sendTransaction({ to: arbiterWallet.address, value: testGas })
  ]);
  await Promise.all(gasFunding.map((tx) => tx.wait()));

  const smokeAmount = hre.ethers.parseUnits("1", 6);
  await (await token.mint(deployerAddress, smokeAmount)).wait();
  await (await token.approve(escrowAddress, smokeAmount)).wait();
  const smokeDealId = await escrow.nextDealId();
  await (await escrow.createDeal(sellerWallet.address, arbiterWallet.address, smokeAmount)).wait();

  const createdDeal = await escrow.getDeal(smokeDealId);
  if (
    createdDeal.buyer.toLowerCase() !== deployerAddress.toLowerCase() ||
    createdDeal.seller.toLowerCase() !== sellerWallet.address.toLowerCase() ||
    createdDeal.arbiter.toLowerCase() !== arbiterWallet.address.toLowerCase() ||
    createdDeal.amount !== smokeAmount ||
    Number(createdDeal.status) !== 1
  ) {
    throw new Error("On-chain smoke test failed: newly created escrow deal does not match expected state.");
  }

  await (await escrow.connect(sellerWallet).voteRelease(smokeDealId)).wait();
  await (await escrow.connect(arbiterWallet).voteRelease(smokeDealId)).wait();
  const settledDeal = await escrow.getDeal(smokeDealId);
  if (Number(settledDeal.status) !== 2 || settledDeal.amount !== 0n) {
    throw new Error("On-chain smoke test failed: two release votes did not settle the deal.");
  }

  const sellerBalanceBefore = await token.balanceOf(sellerWallet.address);
  const sellerPending = await escrow.pendingWithdrawals(sellerWallet.address);
  if (sellerPending !== smokeAmount) {
    throw new Error("On-chain smoke test failed: seller pending withdrawal amount is incorrect.");
  }
  await (await escrow.connect(sellerWallet).withdraw()).wait();
  const sellerBalanceAfter = await token.balanceOf(sellerWallet.address);
  if (sellerBalanceAfter - sellerBalanceBefore !== smokeAmount ||
      (await escrow.pendingWithdrawals(sellerWallet.address)) !== 0n) {
    throw new Error("On-chain smoke test failed: seller withdrawal did not transfer the expected test tokens.");
  }
  console.log("On-chain lifecycle smoke test passed: create -> 2-of-3 release -> seller withdrawal.");

  const deployment = {
    network: "BNB Smart Chain Testnet",
    chainId: 97,
    deployedAt: new Date().toISOString(),
    deployer: deployerAddress,
    token: { name: "Mock USDT", symbol: "mUSDT", decimals: 6, address: tokenAddress },
    escrow: { address: escrowAddress, tokenAddress },
    smokeTest: {
      status: "passed",
      dealId: smokeDealId.toString(),
      amount: "1 mUSDT (worthless test token)",
      flow: ["createDeal", "seller voteRelease", "arbiter voteRelease", "seller withdraw"]
    },
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
