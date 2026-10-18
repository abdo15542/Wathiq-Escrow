const { expect } = require("chai");
const { ethers, network } = require("hardhat");

describe("WathiqUSDTP2PEscrow security checks", function () {
  let token, escrow, buyer, seller, moderator, outsider;
  const amount = 100_000_000n;

  async function deadlineIn(seconds = 3600) {
    const block = await ethers.provider.getBlock("latest");
    return BigInt(block.timestamp + seconds);
  }

  async function createDeal() {
    const deadline = await deadlineIn();
    await token.connect(seller).approve(
      await escrow.getAddress(), amount
    );
    await escrow.connect(seller).createDeal(
      buyer.address, amount, deadline
    );
    return deadline;
  }

  beforeEach(async function () {
    [buyer, seller, moderator, outsider] =
      await ethers.getSigners();

    const Token = await ethers.getContractFactory("MockUSDT");
    token = await Token.deploy();
    await token.waitForDeployment();

    const Escrow =
      await ethers.getContractFactory("WathiqUSDTP2PEscrow");
    escrow = await Escrow.deploy(
      await token.getAddress(), moderator.address
    );
    await escrow.waitForDeployment();

    await token.mint(seller.address, amount * 3n);
  });

  it("rejects a zero token address", async function () {
    const Escrow =
      await ethers.getContractFactory("WathiqUSDTP2PEscrow");

    await expect(
      Escrow.deploy(ethers.ZeroAddress, moderator.address)
    ).to.be.revertedWithCustomError(Escrow, "InvalidAddress");
  });

  it("rejects a zero moderator address", async function () {
    const Escrow =
      await ethers.getContractFactory("WathiqUSDTP2PEscrow");

    await expect(
      Escrow.deploy(await token.getAddress(), ethers.ZeroAddress)
    ).to.be.revertedWithCustomError(Escrow, "InvalidAddress");
  });

  it("rejects the moderator as seller or buyer", async function () {
    const deadline = await deadlineIn();

    await expect(
      escrow.connect(moderator).createDeal(
        buyer.address, amount, deadline
      )
    ).to.be.revertedWithCustomError(escrow, "InvalidAddress");

    await expect(
      escrow.connect(seller).createDeal(
        moderator.address, amount, deadline
      )
    ).to.be.revertedWithCustomError(escrow, "InvalidAddress");
  });

  it("rejects zero amounts and expired deadlines", async function () {
    const deadline = await deadlineIn();

    await expect(
      escrow.connect(seller).createDeal(
        buyer.address, 0n, deadline
      )
    ).to.be.revertedWithCustomError(escrow, "InvalidAmount");

    const block = await ethers.provider.getBlock("latest");

    await expect(
      escrow.connect(seller).createDeal(
        buyer.address, amount, block.timestamp
      )
    ).to.be.revertedWithCustomError(escrow, "InvalidDeadline");
  });

  it("does not release funds before payment is reported", async function () {
    await createDeal();

    await expect(
      escrow.connect(seller).confirmFiatReceived(1)
    ).to.be.revertedWithCustomError(escrow, "InvalidStatus");

    expect(await token.balanceOf(await escrow.getAddress()))
      .to.equal(amount);
  });

  it("does not let an outsider resolve a dispute", async function () {
    await createDeal();
    await escrow.connect(buyer).raiseDispute(1);

    await expect(
      escrow.connect(outsider).resolveDispute(1, true)
    ).to.be.revertedWithCustomError(escrow, "NotAuthorized");

    expect((await escrow.getDeal(1)).status).to.equal(3);
    expect(await token.balanceOf(await escrow.getAddress()))
      .to.equal(amount);
  });

  it("does not refund after the deadline if payment was reported", async function () {
    const deadline = await createDeal();

    await escrow.connect(buyer).reportFiatPayment(1);

    await network.provider.send("evm_setNextBlockTimestamp", [
      Number(deadline + 1n)
    ]);
    await network.provider.send("evm_mine");

    await expect(
      escrow.connect(seller).refundUnpaidAfterDeadline(1)
    ).to.be.revertedWithCustomError(escrow, "InvalidStatus");

    expect(await token.balanceOf(await escrow.getAddress()))
      .to.equal(amount);
  });

  it("rejects duplicate payment reports", async function () {
    await createDeal();
    await escrow.connect(buyer).reportFiatPayment(1);

    await expect(
      escrow.connect(buyer).reportFiatPayment(1)
    ).to.be.revertedWithCustomError(escrow, "InvalidStatus");
  });

  it("keeps funds locked when a dispute is opened", async function () {
    await createDeal();
    await escrow.connect(buyer).reportFiatPayment(1);
    await escrow.connect(buyer).raiseDispute(1);

    await expect(
      escrow.connect(seller).confirmFiatReceived(1)
    ).to.be.revertedWithCustomError(escrow, "InvalidStatus");

    expect(await token.balanceOf(await escrow.getAddress()))
      .to.equal(amount);
  });

  it("rejects operations on a nonexistent deal", async function () {
    await expect(
      escrow.connect(buyer).reportFiatPayment(999)
    ).to.be.revertedWithCustomError(escrow, "DealNotFound");

    await expect(
      escrow.connect(moderator).resolveDispute(999, false)
    ).to.be.revertedWithCustomError(escrow, "DealNotFound");
  });

  it("rejects a token address that has no contract code", async function () {
    const Escrow =
      await ethers.getContractFactory("WathiqUSDTP2PEscrow");

    await expect(
      Escrow.deploy(outsider.address, moderator.address)
    ).to.be.revertedWithCustomError(Escrow, "InvalidAddress");
  });

  it("allows payment reporting exactly at the deadline", async function () {
    const deadline = await createDeal();

    await network.provider.send("evm_setNextBlockTimestamp", [
      Number(deadline)
    ]);

    await escrow.connect(buyer).reportFiatPayment(1);

    expect((await escrow.getDeal(1)).status).to.equal(2); // PaymentReported
  });

  it("keeps separate deals isolated during disputes and settlement", async function () {
    await createDeal(); // deal 1
    await createDeal(); // deal 2

    await escrow.connect(buyer).reportFiatPayment(1);
    await escrow.connect(seller).raiseDispute(2);
    await escrow.connect(moderator).resolveDispute(2, false);

    const first = await escrow.getDeal(1);
    const second = await escrow.getDeal(2);

    expect(first.status).to.equal(2);  // PaymentReported
    expect(first.amount).to.equal(amount);
    expect(second.status).to.equal(5); // Refunded
    expect(second.amount).to.equal(0n);

    expect(
      await token.balanceOf(await escrow.getAddress())
    ).to.equal(amount);
  });

});
