const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("WathiqUSDTEscrow", function () {
  let token, escrow, buyer, seller, arbiter, outsider;
  const amount = 125_000_000n; // 125.000000 units for a 6-decimal test token

  beforeEach(async () => {
    [buyer, seller, arbiter, outsider] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("MockUSDT");
    token = await Token.deploy();
    await token.waitForDeployment();
    const Escrow = await ethers.getContractFactory("WathiqUSDTEscrow");
    escrow = await Escrow.deploy(await token.getAddress());
    await escrow.waitForDeployment();
    await token.mint(buyer.address, amount * 4n);
    await token.connect(buyer).approve(await escrow.getAddress(), amount * 4n);
  });

  async function makeDeal() {
    await expect(escrow.connect(buyer).createDeal(seller.address, arbiter.address, amount))
      .to.emit(escrow, "DealCreated").withArgs(1, buyer.address, seller.address, arbiter.address, amount);
    return 1;
  }

  it("takes ERC-20 tokens into escrow and records the participants", async () => {
    await makeDeal();
    const d = await escrow.getDeal(1);
    expect(d.buyer).to.equal(buyer.address);
    expect(d.seller).to.equal(seller.address);
    expect(d.arbiter).to.equal(arbiter.address);
    expect(d.amount).to.equal(amount);
    expect(d.status).to.equal(1);
    expect(await token.balanceOf(await escrow.getAddress())).to.equal(amount);
  });

  it("releases tokens after two matching votes and uses pull withdrawal", async () => {
    await makeDeal();
    await escrow.connect(buyer).voteRelease(1);
    await expect(escrow.connect(arbiter).voteRelease(1)).to.emit(escrow, "DealSettled");
    expect(await escrow.pendingWithdrawals(seller.address)).to.equal(amount);
    await expect(escrow.connect(seller).withdraw()).to.emit(escrow, "Withdrawal").withArgs(seller.address, amount);
    expect(await token.balanceOf(seller.address)).to.equal(amount);
    expect(await token.balanceOf(await escrow.getAddress())).to.equal(0);
  });

  it("refunds buyer after two matching refund votes", async () => {
    await makeDeal();
    await escrow.connect(seller).voteRefund(1);
    await escrow.connect(arbiter).voteRefund(1);
    expect((await escrow.getDeal(1)).status).to.equal(3);
    await escrow.connect(buyer).withdraw();
    expect(await token.balanceOf(buyer.address)).to.equal(amount * 4n);
  });

  it("rejects nonparticipants and duplicate votes", async () => {
    await makeDeal();
    await expect(escrow.connect(outsider).voteRelease(1)).to.be.revertedWithCustomError(escrow, "NotParticipant");
    await escrow.connect(buyer).voteRelease(1);
    await expect(escrow.connect(buyer).voteRefund(1)).to.be.revertedWithCustomError(escrow, "AlreadyVoted");
  });

  it("does not settle conflicting votes and refunds after timeout", async () => {
    await makeDeal();
    await escrow.connect(buyer).voteRelease(1);
    await escrow.connect(seller).voteRefund(1);
    expect((await escrow.getDeal(1)).status).to.equal(1);
    await expect(escrow.connect(outsider).refundExpired(1)).to.be.revertedWithCustomError(escrow, "DealNotExpired");
    await ethers.provider.send("evm_increaseTime", [30 * 24 * 60 * 60 + 1]);
    await ethers.provider.send("evm_mine", []);
    await expect(escrow.connect(outsider).refundExpired(1)).to.emit(escrow, "ExpiredDealRefunded");
    await escrow.connect(buyer).withdraw();
    expect(await token.balanceOf(buyer.address)).to.equal(amount * 4n);
  });

  it("rejects zero amounts and invalid participants", async () => {
    await expect(escrow.connect(buyer).createDeal(seller.address, arbiter.address, 0)).to.be.revertedWithCustomError(escrow, "InvalidAmount");
    await expect(escrow.connect(buyer).createDeal(buyer.address, arbiter.address, amount)).to.be.revertedWithCustomError(escrow, "InvalidAddress");
  });

  it("rejects withdrawal without a credited balance", async () => {
    await expect(escrow.connect(outsider).withdraw()).to.be.revertedWithCustomError(escrow, "NothingToWithdraw");
  });

  it("rejects zero and non-contract token addresses", async () => {
    const Escrow = await ethers.getContractFactory("WathiqUSDTEscrow");
    await expect(Escrow.deploy(ethers.ZeroAddress)).to.be.revertedWithCustomError(Escrow, "InvalidAddress");
    await expect(Escrow.deploy(outsider.address)).to.be.revertedWithCustomError(Escrow, "InvalidAddress");
  });

  it("does not permit any further votes after a deal is settled", async () => {
    await makeDeal();
    await escrow.connect(buyer).voteRelease(1);
    await escrow.connect(arbiter).voteRelease(1);
    await expect(escrow.connect(seller).voteRelease(1)).to.be.revertedWithCustomError(escrow, "DealNotActive");
    await expect(escrow.connect(seller).voteRefund(1)).to.be.revertedWithCustomError(escrow, "DealNotActive");
    expect(await escrow.pendingWithdrawals(seller.address)).to.equal(amount);
    expect(await escrow.pendingWithdrawals(buyer.address)).to.equal(0);
  });

  it("cannot settle or withdraw the same escrow amount twice", async () => {
    await makeDeal();
    await escrow.connect(buyer).voteRefund(1);
    await escrow.connect(arbiter).voteRefund(1);
    await escrow.connect(buyer).withdraw();
    await expect(escrow.connect(buyer).withdraw()).to.be.revertedWithCustomError(escrow, "NothingToWithdraw");
    await expect(escrow.connect(outsider).refundExpired(1)).to.be.revertedWithCustomError(escrow, "DealNotActive");
    expect(await token.balanceOf(await escrow.getAddress())).to.equal(0);
  });


  it("rejects fee-on-transfer tokens and reverts the token transfer atomically", async () => {
    const FeeToken = await ethers.getContractFactory("FeeOnTransferToken");
    const feeToken = await FeeToken.deploy();
    await feeToken.waitForDeployment();

    const Escrow = await ethers.getContractFactory("WathiqUSDTEscrow");
    const feeEscrow = await Escrow.deploy(await feeToken.getAddress());
    await feeEscrow.waitForDeployment();

    await feeToken.mint(buyer.address, amount * 2n);
    await feeToken.connect(buyer).approve(await feeEscrow.getAddress(), amount);

    await expect(
      feeEscrow.connect(buyer).createDeal(seller.address, arbiter.address, amount)
    ).to.be.revertedWithCustomError(feeEscrow, "UnsupportedTokenBehavior");

    expect(await feeToken.balanceOf(buyer.address)).to.equal(amount * 2n);
    expect(await feeToken.balanceOf(await feeEscrow.getAddress())).to.equal(0);
    expect(await feeEscrow.nextDealId()).to.equal(1);
  });
});
