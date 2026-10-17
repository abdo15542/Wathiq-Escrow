const { expect } = require("chai");
const { ethers, network } = require("hardhat");

describe("WathiqUSDTEscrow", function () {
  let token, escrow, buyer, seller, arbiter, outsider;
  const amount = 100_000_000n; // 100 test tokens, 6 decimals

  async function futureDeadline() {
    const block = await ethers.provider.getBlock("latest");
    return BigInt(block.timestamp + 3600);
  }

  async function createDeal() {
    const deadline = await futureDeadline();

    await token.connect(buyer).approve(
      await escrow.getAddress(),
      amount
    );

    await escrow.connect(buyer).createDeal(
      seller.address,
      arbiter.address,
      amount,
      deadline
    );

    return deadline;
  }

  beforeEach(async function () {
    [buyer, seller, arbiter, outsider] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("MockUSDT");
    token = await Token.deploy();
    await token.waitForDeployment();

    const Escrow = await ethers.getContractFactory("WathiqUSDTEscrow");
    escrow = await Escrow.deploy(await token.getAddress());
    await escrow.waitForDeployment();

    await token.mint(buyer.address, amount * 5n);
  });

  it("accepts tokens and records the deal", async function () {
    await createDeal();

    const deal = await escrow.getDeal(1);

    expect(deal.buyer).to.equal(buyer.address);
    expect(deal.seller).to.equal(seller.address);
    expect(deal.arbiter).to.equal(arbiter.address);
    expect(deal.amount).to.equal(amount);
    expect(deal.status).to.equal(1); // Active
    expect(await token.balanceOf(await escrow.getAddress())).to.equal(amount);
  });

  it("releases tokens to the seller when the buyer approves", async function () {
    await createDeal();

    await expect(escrow.connect(buyer).releaseToSeller(1))
      .to.emit(escrow, "DealSettled");

    expect(await token.balanceOf(seller.address)).to.equal(amount);

    const deal = await escrow.getDeal(1);
    expect(deal.status).to.equal(3); // Released
    expect(deal.amount).to.equal(0);
  });

  it("does not allow another account to release the deal", async function () {
    await createDeal();

    await expect(
      escrow.connect(outsider).releaseToSeller(1)
    ).to.be.revertedWithCustomError(escrow, "NotAuthorized");
  });

  it("refunds the buyer after the deadline", async function () {
    const deadline = await createDeal();

    await network.provider.send("evm_setNextBlockTimestamp", [
      Number(deadline + 1n)
    ]);
    await network.provider.send("evm_mine");

    await escrow.connect(buyer).refundAfterDeadline(1);

    expect(await token.balanceOf(buyer.address)).to.equal(amount * 5n);
    expect((await escrow.getDeal(1)).status).to.equal(4); // Refunded
  });

  it("rejects a refund before the deadline", async function () {
    await createDeal();

    await expect(
      escrow.connect(buyer).refundAfterDeadline(1)
    ).to.be.revertedWithCustomError(escrow, "DeadlineNotPassed");
  });

  it("allows the arbiter to refund a disputed deal", async function () {
    await createDeal();

    await escrow.connect(seller).raiseDispute(1);

    await expect(
      escrow.connect(arbiter).resolveDispute(1, false)
    ).to.emit(escrow, "DealSettled");

    expect((await escrow.getDeal(1)).status).to.equal(4);
    expect(await token.balanceOf(buyer.address)).to.equal(amount * 5n);
  });

  it("allows the arbiter to release a disputed deal to the seller", async function () {
    await createDeal();

    await escrow.connect(buyer).raiseDispute(1);
    await escrow.connect(arbiter).resolveDispute(1, true);

    expect((await escrow.getDeal(1)).status).to.equal(3);
    expect(await token.balanceOf(seller.address)).to.equal(amount);
  });

  it("rejects dispute resolution by an unauthorized account", async function () {
    await createDeal();
    await escrow.connect(buyer).raiseDispute(1);

    await expect(
      escrow.connect(outsider).resolveDispute(1, false)
    ).to.be.revertedWithCustomError(escrow, "NotAuthorized");
  });

  it("rejects a zero amount", async function () {
    const deadline = await futureDeadline();

    await expect(
      escrow.connect(buyer).createDeal(
        seller.address,
        arbiter.address,
        0,
        deadline
      )
    ).to.be.revertedWithCustomError(escrow, "InvalidAmount");
  });

  it("rejects a deadline that has already passed", async function () {
    const block = await ethers.provider.getBlock("latest");
    const deadline = BigInt(block.timestamp);

    await expect(
      escrow.connect(buyer).createDeal(
        seller.address,
        arbiter.address,
        amount,
        deadline
      )
    ).to.be.revertedWithCustomError(escrow, "InvalidDeadline");
  });

  it("prevents a disputed deal from being refunded through the timeout path", async function () {
    const deadline = await createDeal();

    await escrow.connect(buyer).raiseDispute(1);

    await network.provider.send("evm_setNextBlockTimestamp", [
      Number(deadline + 1n)
    ]);
    await network.provider.send("evm_mine");

    await expect(
      escrow.connect(buyer).refundAfterDeadline(1)
    ).to.be.revertedWithCustomError(escrow, "DealNotActive");
  });
});
