const { expect } = require("chai");
const { ethers, network } = require("hardhat");

describe("WathiqUSDTEscrow security regressions", function () {
  let token, escrow, buyer, seller, arbiter, outsider;
  const amount = 1_000_000n;

  async function deadlineIn(seconds = 3600) {
    const block = await ethers.provider.getBlock("latest");
    return BigInt(block.timestamp + seconds);
  }

  async function openDeal() {
    const deadline = await deadlineIn();

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
    [buyer, seller, arbiter, outsider] =
      await ethers.getSigners();

    const Token = await ethers.getContractFactory("MockUSDT");
    token = await Token.deploy();
    await token.waitForDeployment();

    const Escrow =
      await ethers.getContractFactory("WathiqUSDTEscrow");
    escrow = await Escrow.deploy(await token.getAddress());
    await escrow.waitForDeployment();

    await token.mint(buyer.address, amount * 3n);
  });

  it("rejects zero seller and zero arbiter addresses", async function () {
    const deadline = await deadlineIn();

    await expect(
      escrow.connect(buyer).createDeal(
        ethers.ZeroAddress, arbiter.address, amount, deadline
      )
    ).to.be.revertedWithCustomError(escrow, "InvalidAddress");

    await expect(
      escrow.connect(buyer).createDeal(
        seller.address, ethers.ZeroAddress, amount, deadline
      )
    ).to.be.revertedWithCustomError(escrow, "InvalidAddress");
  });

  it("rejects conflicting buyer, seller, and arbiter addresses", async function () {
    const deadline = await deadlineIn();

    await expect(
      escrow.connect(buyer).createDeal(
        buyer.address, arbiter.address, amount, deadline
      )
    ).to.be.revertedWithCustomError(escrow, "InvalidAddress");

    await expect(
      escrow.connect(buyer).createDeal(
        seller.address, buyer.address, amount, deadline
      )
    ).to.be.revertedWithCustomError(escrow, "InvalidAddress");

    await expect(
      escrow.connect(buyer).createDeal(
        seller.address, seller.address, amount, deadline
      )
    ).to.be.revertedWithCustomError(escrow, "InvalidAddress");
  });

  it("rejects disputes raised by unrelated accounts", async function () {
    await openDeal();

    await expect(
      escrow.connect(outsider).raiseDispute(1)
    ).to.be.revertedWithCustomError(escrow, "NotAuthorized");
  });

  it("allows only the buyer to claim a deadline refund", async function () {
    const deadline = await openDeal();

    await network.provider.send("evm_setNextBlockTimestamp", [
      Number(deadline + 1n)
    ]);
    await network.provider.send("evm_mine");

    await expect(
      escrow.connect(seller).refundAfterDeadline(1)
    ).to.be.revertedWithCustomError(escrow, "NotAuthorized");

    await expect(
      escrow.connect(outsider).refundAfterDeadline(1)
    ).to.be.revertedWithCustomError(escrow, "NotAuthorized");
  });

  it("prevents a second release after settlement", async function () {
    await openDeal();
    await escrow.connect(buyer).releaseToSeller(1);

    await expect(
      escrow.connect(buyer).releaseToSeller(1)
    ).to.be.revertedWithCustomError(escrow, "DealNotActive");

    expect(await token.balanceOf(seller.address)).to.equal(amount);
    expect(
      await token.balanceOf(await escrow.getAddress())
    ).to.equal(0n);
  });

  it("prevents normal release after a dispute is raised", async function () {
    await openDeal();
    await escrow.connect(seller).raiseDispute(1);

    await expect(
      escrow.connect(buyer).releaseToSeller(1)
    ).to.be.revertedWithCustomError(escrow, "DealNotActive");
  });

  it("does not create a deal when token approval is missing", async function () {
    await expect(
      escrow.connect(buyer).createDeal(
        seller.address,
        arbiter.address,
        amount,
        await deadlineIn()
      )
    ).to.be.revertedWithCustomError(escrow, "TokenTransferFailed");

    expect(await escrow.nextDealId()).to.equal(1n);
    expect(
      await token.balanceOf(await escrow.getAddress())
    ).to.equal(0n);
  });
});
