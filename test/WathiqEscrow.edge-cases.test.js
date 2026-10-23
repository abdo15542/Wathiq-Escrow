const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("WathiqEscrow settlement edge cases", function () {
  let escrow, buyer, seller, arbiter, outsider;
  const amount = ethers.parseEther("0.25");

  beforeEach(async function () {
    [buyer, seller, arbiter, outsider] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("WathiqEscrow");
    escrow = await Factory.deploy();
    await escrow.waitForDeployment();
  });

  async function createDeal(value = amount) {
    const tx = await escrow.connect(buyer).createDeal(seller.address, arbiter.address, { value });
    await tx.wait();
  }

  it("rejects a zero seller, zero arbiter, and identical seller/arbiter", async function () {
    await expect(
      escrow.connect(buyer).createDeal(ethers.ZeroAddress, arbiter.address, { value: amount })
    ).to.be.revertedWithCustomError(escrow, "InvalidAddress");
    await expect(
      escrow.connect(buyer).createDeal(seller.address, ethers.ZeroAddress, { value: amount })
    ).to.be.revertedWithCustomError(escrow, "InvalidAddress");
    await expect(
      escrow.connect(buyer).createDeal(seller.address, seller.address, { value: amount })
    ).to.be.revertedWithCustomError(escrow, "InvalidAddress");
  });

  it("rejects reads and votes for an unknown deal", async function () {
    await expect(escrow.getDeal(999)).to.be.revertedWithCustomError(escrow, "DealNotFound");
    await expect(escrow.connect(buyer).voteRelease(999)).to.be.revertedWithCustomError(escrow, "DealNotFound");
    await expect(escrow.connect(buyer).voteRefund(999)).to.be.revertedWithCustomError(escrow, "DealNotFound");
  });

  it("allows the arbiter to resolve split buyer/seller votes with the third vote", async function () {
    await createDeal();
    await escrow.connect(buyer).voteRelease(1);
    await escrow.connect(seller).voteRefund(1);

    await expect(escrow.connect(arbiter).voteRelease(1))
      .to.emit(escrow, "DealSettled")
      .withArgs(1, 2, seller.address, amount);

    const deal = await escrow.getDeal(1);
    expect(deal.status).to.equal(2);
    expect(deal.amount).to.equal(amount);
    expect(await escrow.pendingWithdrawals(seller.address)).to.equal(amount);
    // Settlement credits a pull-payment balance; funds remain in the contract until withdrawn.
    expect(await ethers.provider.getBalance(escrow.target)).to.equal(amount);
    await escrow.connect(seller).withdraw();
    expect(await ethers.provider.getBalance(escrow.target)).to.equal(0);
    expect(await escrow.pendingWithdrawals(seller.address)).to.equal(0);
  });

  it("keeps balances isolated across deals and credits the correct recipient", async function () {
    await createDeal();
    await escrow.connect(buyer).createDeal(outsider.address, arbiter.address, { value: amount * 2n });

    await escrow.connect(buyer).voteRefund(1);
    await escrow.connect(arbiter).voteRefund(1);
    await escrow.connect(buyer).voteRelease(2);
    await escrow.connect(outsider).voteRelease(2);

    expect((await escrow.getDeal(1)).status).to.equal(3);
    expect((await escrow.getDeal(2)).status).to.equal(2);
    expect(await escrow.pendingWithdrawals(buyer.address)).to.equal(amount);
    expect(await escrow.pendingWithdrawals(outsider.address)).to.equal(amount * 2n);
    expect(await ethers.provider.getBalance(escrow.target)).to.equal(amount * 3n);

    await escrow.connect(buyer).withdraw();
    await escrow.connect(outsider).withdraw();
    expect(await escrow.pendingWithdrawals(buyer.address)).to.equal(0);
    expect(await escrow.pendingWithdrawals(outsider.address)).to.equal(0);
    expect(await ethers.provider.getBalance(escrow.target)).to.equal(0);
  });

  it("does not let a non-participant settle or withdraw another account's credit", async function () {
    await createDeal();
    await escrow.connect(buyer).voteRelease(1);
    await expect(escrow.connect(outsider).voteRelease(1))
      .to.be.revertedWithCustomError(escrow, "NotParticipant");
    await expect(escrow.connect(outsider).withdraw())
      .to.be.revertedWithCustomError(escrow, "NothingToWithdraw");
    expect((await escrow.getDeal(1)).status).to.equal(1);
  });

  it("blocks re-entrant withdrawals from a malicious recipient", async function () {
    const Receiver = await ethers.getContractFactory("ReentrantWithdrawer");
    const receiver = await Receiver.deploy(escrow.target);
    await receiver.waitForDeployment();

    await escrow.connect(buyer).createDeal(await receiver.getAddress(), arbiter.address, { value: amount });
    await escrow.connect(buyer).voteRelease(1);
    await escrow.connect(arbiter).voteRelease(1);
    expect(await escrow.pendingWithdrawals(await receiver.getAddress())).to.equal(amount);

    await receiver.attack();

    expect(await receiver.reentryBlocked()).to.equal(true);
    expect(await receiver.reentrySucceeded()).to.equal(false);
    expect(await receiver.receiveCount()).to.equal(1);
    expect(await ethers.provider.getBalance(await receiver.getAddress())).to.equal(amount);
    expect(await escrow.pendingWithdrawals(await receiver.getAddress())).to.equal(0);
    expect(await ethers.provider.getBalance(escrow.target)).to.equal(0);
  });
});
