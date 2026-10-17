const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("WathiqEscrow", function () {
  let escrow, buyer, seller, arbiter, outsider;
  const amount = ethers.parseEther("1");
  beforeEach(async () => {
    [buyer, seller, arbiter, outsider] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("WathiqEscrow");
    escrow = await Factory.deploy();
    await escrow.waitForDeployment();
  });
  async function makeDeal() {
    const tx = await escrow.connect(buyer).createDeal(seller.address, arbiter.address, { value: amount });
    await tx.wait();
    return 1;
  }
  it("escrows BNB and records the participants", async () => {
    await makeDeal();
    const d = await escrow.getDeal(1);
    expect(d.buyer).to.equal(buyer.address);
    expect(d.seller).to.equal(seller.address);
    expect(d.arbiter).to.equal(arbiter.address);
    expect(d.amount).to.equal(amount);
    expect(d.status).to.equal(1);
  });
  it("releases only after two matching votes", async () => {
    await makeDeal();
    await escrow.connect(buyer).voteRelease(1);
    expect((await escrow.getDeal(1)).status).to.equal(1);
    await expect(escrow.connect(arbiter).voteRelease(1)).to.emit(escrow, "DealSettled");
    expect((await escrow.getDeal(1)).status).to.equal(2);
    expect(await escrow.pendingWithdrawals(seller.address)).to.equal(amount);
    await expect(escrow.connect(seller).withdraw()).to.emit(escrow, "Withdrawal").withArgs(seller.address, amount);
    expect(await escrow.pendingWithdrawals(seller.address)).to.equal(0);
  });
  it("refunds only after two matching votes", async () => {
    await makeDeal();
    await escrow.connect(seller).voteRefund(1);
    await escrow.connect(arbiter).voteRefund(1);
    expect((await escrow.getDeal(1)).status).to.equal(3);
    expect(await escrow.pendingWithdrawals(buyer.address)).to.equal(amount);
    await escrow.connect(buyer).withdraw();
    expect(await escrow.pendingWithdrawals(buyer.address)).to.equal(0);
  });
  it("rejects non-participants", async () => {
    await makeDeal();
    await expect(escrow.connect(outsider).voteRelease(1)).to.be.revertedWithCustomError(escrow, "NotParticipant");
  });
  it("prevents one participant from voting twice or changing their vote", async () => {
    await makeDeal();
    await escrow.connect(buyer).voteRelease(1);
    await expect(escrow.connect(buyer).voteRelease(1)).to.be.revertedWithCustomError(escrow, "AlreadyVoted");
    await expect(escrow.connect(buyer).voteRefund(1)).to.be.revertedWithCustomError(escrow, "AlreadyVoted");
  });
  it("does not settle when votes conflict", async () => {
    await makeDeal();
    await escrow.connect(buyer).voteRelease(1);
    await escrow.connect(seller).voteRefund(1);
    expect((await escrow.getDeal(1)).status).to.equal(1);
    expect((await escrow.getDeal(1)).amount).to.equal(amount);
  });
  it("rejects zero amount and invalid participants", async () => {
    await expect(escrow.connect(buyer).createDeal(seller.address, arbiter.address)).to.be.revertedWithCustomError(escrow, "InvalidAmount");
    await expect(escrow.connect(buyer).createDeal(buyer.address, arbiter.address, { value: amount })).to.be.revertedWithCustomError(escrow, "InvalidAddress");
  });
  it("does not allow withdrawal without a credited balance", async () => {
    await expect(escrow.connect(outsider).withdraw()).to.be.revertedWithCustomError(escrow, "NothingToWithdraw");
  });
  it("rejects votes after settlement", async () => {
    await makeDeal();
    await escrow.connect(buyer).voteRelease(1);
    await escrow.connect(seller).voteRelease(1);
    await expect(escrow.connect(arbiter).voteRelease(1)).to.be.revertedWithCustomError(escrow, "DealNotActive");
  });
});
