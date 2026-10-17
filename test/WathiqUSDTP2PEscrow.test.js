const { expect } = require("chai");
const { ethers, network } = require("hardhat");

describe("WathiqUSDTP2PEscrow", function () {
  let token, escrow, buyer, seller, moderator, outsider;
  const amount = 100_000_000n; // 100 mock tokens with 6 decimals

  async function deadlineIn(seconds = 3600) {
    const block = await ethers.provider.getBlock("latest");
    return BigInt(block.timestamp + seconds);
  }

  async function createDeal() {
    const deadline = await deadlineIn();
    await token.connect(seller).approve(await escrow.getAddress(), amount);
    await escrow.connect(seller).createDeal(buyer.address, amount, deadline);
    return deadline;
  }

  beforeEach(async function () {
    [buyer, seller, moderator, outsider] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("MockUSDT");
    token = await Token.deploy();
    await token.waitForDeployment();
    const Escrow = await ethers.getContractFactory("WathiqUSDTP2PEscrow");
    escrow = await Escrow.deploy(await token.getAddress(), moderator.address);
    await escrow.waitForDeployment();
    await token.mint(seller.address, amount * 3n);
  });

  it("locks the seller's USDT and records correct roles", async function () {
    await createDeal();
    const d = await escrow.getDeal(1);
    expect(d.buyer).to.equal(buyer.address);
    expect(d.seller).to.equal(seller.address);
    expect(d.moderator).to.equal(moderator.address);
    expect(d.amount).to.equal(amount);
    expect(d.status).to.equal(1); // Active
    expect(await token.balanceOf(await escrow.getAddress())).to.equal(amount);
  });

  it("releases USDT to buyer only after seller confirms fiat receipt", async function () {
    await createDeal();
    await expect(escrow.connect(buyer).confirmFiatReceived(1))
      .to.be.revertedWithCustomError(escrow, "NotAuthorized");
    await escrow.connect(buyer).reportFiatPayment(1);
    await escrow.connect(seller).confirmFiatReceived(1);
    expect(await token.balanceOf(buyer.address)).to.equal(amount);
    expect((await escrow.getDeal(1)).status).to.equal(4); // Released
    expect((await escrow.getDeal(1)).amount).to.equal(0);
  });

  it("does not allow an outsider to report payment or raise a dispute", async function () {
    await createDeal();
    await expect(escrow.connect(outsider).reportFiatPayment(1))
      .to.be.revertedWithCustomError(escrow, "NotAuthorized");
    await expect(escrow.connect(outsider).raiseDispute(1))
      .to.be.revertedWithCustomError(escrow, "NotAuthorized");
  });

  it("returns locked USDT to seller after deadline only when payment was not reported", async function () {
    const deadline = await createDeal();
    await expect(escrow.connect(buyer).refundUnpaidAfterDeadline(1))
      .to.be.revertedWithCustomError(escrow, "NotAuthorized");
    await network.provider.send("evm_setNextBlockTimestamp", [Number(deadline + 1n)]);
    await network.provider.send("evm_mine");
    await escrow.connect(seller).refundUnpaidAfterDeadline(1);
    expect(await token.balanceOf(seller.address)).to.equal(amount * 3n);
    expect((await escrow.getDeal(1)).status).to.equal(5); // Refunded
  });

  it("blocks timeout refund after buyer reported payment", async function () {
    const deadline = await createDeal();
    await escrow.connect(buyer).reportFiatPayment(1);
    await network.provider.send("evm_setNextBlockTimestamp", [Number(deadline + 1n)]);
    await network.provider.send("evm_mine");
    await expect(escrow.connect(seller).refundUnpaidAfterDeadline(1))
      .to.be.revertedWithCustomError(escrow, "InvalidStatus");
  });

  it("freezes payment-reported deal during dispute; only assigned moderator resolves", async function () {
    await createDeal();
    await escrow.connect(buyer).reportFiatPayment(1);
    await escrow.connect(seller).raiseDispute(1);
    await expect(escrow.connect(seller).confirmFiatReceived(1))
      .to.be.revertedWithCustomError(escrow, "InvalidStatus");
    await expect(escrow.connect(outsider).resolveDispute(1, true))
      .to.be.revertedWithCustomError(escrow, "NotAuthorized");
    await escrow.connect(moderator).resolveDispute(1, true);
    expect(await token.balanceOf(buyer.address)).to.equal(amount);
    expect((await escrow.getDeal(1)).status).to.equal(4);
  });

  it("moderator can refund seller after a disputed deal", async function () {
    await createDeal();
    await escrow.connect(buyer).raiseDispute(1);
    await escrow.connect(moderator).resolveDispute(1, false);
    expect(await token.balanceOf(seller.address)).to.equal(amount * 3n);
    expect((await escrow.getDeal(1)).status).to.equal(5);
  });

  it("prevents double settlement", async function () {
    await createDeal();
    await escrow.connect(buyer).reportFiatPayment(1);
    await escrow.connect(seller).confirmFiatReceived(1);
    await expect(escrow.connect(seller).confirmFiatReceived(1))
      .to.be.revertedWithCustomError(escrow, "InvalidStatus");
    expect(await token.balanceOf(buyer.address)).to.equal(amount);
  });

  it("rejects invalid identities, zero amount and expired deadline", async function () {
    const deadline = await deadlineIn();
    await expect(escrow.connect(seller).createDeal(seller.address, amount, deadline))
      .to.be.revertedWithCustomError(escrow, "InvalidAddress");
    await expect(escrow.connect(seller).createDeal(moderator.address, amount, deadline))
      .to.be.revertedWithCustomError(escrow, "InvalidAddress");
    await expect(escrow.connect(seller).createDeal(buyer.address, 0, deadline))
      .to.be.revertedWithCustomError(escrow, "InvalidAmount");
    const now = await ethers.provider.getBlock("latest");
    await expect(escrow.connect(seller).createDeal(buyer.address, amount, now.timestamp))
      .to.be.revertedWithCustomError(escrow, "InvalidDeadline");
  });
});
