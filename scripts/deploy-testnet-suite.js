const fs = require("node:fs");
const path = require("node:path");
const hre = require("hardhat");

async function send(txPromise) {
  const tx = await txPromise;
  return tx.wait();
}

async function main() {
  const network = await hre.ethers.provider.getNetwork();
  if (network.chainId !== 97n) throw new Error("Refusing deployment: BNB Smart Chain Testnet chainId 97 is required.");
  if (!process.env.DEPLOYER_PRIVATE_KEY) throw new Error("DEPLOYER_PRIVATE_KEY is required as a protected CI secret.");
  const [deployer] = await hre.ethers.getSigners();
  const deployerAddress = await deployer.getAddress();
  const balance = await hre.ethers.provider.getBalance(deployerAddress);
  if (balance < hre.ethers.parseEther("0.02")) throw new Error("At least 0.02 test BNB is required. Never use a mainnet key.");

  const Escrow = await hre.ethers.getContractFactory("WathiqEscrow");
  const escrow = await Escrow.deploy();
  await escrow.waitForDeployment();
  const escrowAddress = await escrow.getAddress();
  if ((await hre.ethers.provider.getCode(escrowAddress)) === "0x") throw new Error("Deployment verification failed: escrow bytecode missing.");

  // Disposable participants are used only during this CI job; private keys are never persisted.
  const seller = hre.ethers.Wallet.createRandom().connect(hre.ethers.provider);
  const arbiter = hre.ethers.Wallet.createRandom().connect(hre.ethers.provider);
  const participantGas = hre.ethers.parseEther("0.002");
  await send(deployer.sendTransaction({ to: seller.address, value: participantGas }));
  await send(deployer.sendTransaction({ to: arbiter.address, value: participantGas }));
  const amount = hre.ethers.parseEther("0.001");

  const releaseDealId = await escrow.nextDealId();
  await send(escrow.createDeal(seller.address, arbiter.address, { value: amount }));
  const created = await escrow.getDeal(releaseDealId);
  if (created.buyer.toLowerCase() !== deployerAddress.toLowerCase() || created.seller.toLowerCase() !== seller.address.toLowerCase() || created.arbiter.toLowerCase() !== arbiter.address.toLowerCase() || created.amount !== amount || Number(created.status) !== 1) throw new Error("Release smoke test failed: created deal state mismatch.");
  await send(escrow.connect(seller).voteRelease(releaseDealId));
  await send(escrow.connect(arbiter).voteRelease(releaseDealId));
  const released = await escrow.getDeal(releaseDealId);
  if (Number(released.status) !== 2 || released.amount !== amount) throw new Error("Release smoke test failed: status or historical amount mismatch.");
  if ((await escrow.pendingWithdrawals(seller.address)) !== amount) throw new Error("Release smoke test failed: seller credit mismatch.");
  await send(escrow.connect(seller).withdraw());
  if ((await escrow.pendingWithdrawals(seller.address)) !== 0n) throw new Error("Release smoke test failed: seller credit not cleared.");

  const refundDealId = await escrow.nextDealId();
  await send(escrow.createDeal(seller.address, arbiter.address, { value: amount }));
  await send(escrow.voteRefund(refundDealId));
  await send(escrow.connect(arbiter).voteRefund(refundDealId));
  const refunded = await escrow.getDeal(refundDealId);
  if (Number(refunded.status) !== 3 || refunded.amount !== amount) throw new Error("Refund smoke test failed: status or historical amount mismatch.");
  if ((await escrow.pendingWithdrawals(deployerAddress)) !== amount) throw new Error("Refund smoke test failed: buyer credit mismatch.");
  await send(escrow.withdraw());
  if ((await escrow.pendingWithdrawals(deployerAddress)) !== 0n) throw new Error("Refund smoke test failed: buyer credit not cleared.");
  if ((await hre.ethers.provider.getBalance(escrowAddress)) !== 0n) throw new Error("Lifecycle smoke test failed: unexpected balance remains in escrow.");
  console.log("On-chain lifecycle checks passed: create, 2-of-3 release, seller withdrawal, 2-of-3 refund, buyer withdrawal.");

  const deployment = {
    network: "BNB Smart Chain Testnet", chainId: 97, deployedAt: new Date().toISOString(), deployer: deployerAddress,
    escrow: { address: escrowAddress },
    smokeTest: { status: "passed", releaseDealId: releaseDealId.toString(), refundDealId: refundDealId.toString(), amount: "0.001 tBNB per deal", flows: [["createDeal", "seller voteRelease", "arbiter voteRelease", "seller withdraw"], ["createDeal", "buyer voteRefund", "arbiter voteRefund", "buyer withdraw"]] },
    explorer: { escrow: "https://testnet.bscscan.com/address/" + escrowAddress },
    warning: "TESTNET ONLY. tBNB has no mainnet value. Contract is unaudited. Never use for real funds."
  };
  const outputDir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, "bsc-testnet.json");
  fs.writeFileSync(outputPath, JSON.stringify(deployment, null, 2) + "\n");
  console.log("Verified testnet deployment manifest written to:", outputPath);
  console.log(JSON.stringify(deployment, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
