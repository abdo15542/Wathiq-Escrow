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
});
