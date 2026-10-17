require("dotenv").config();
const hre = require("hardhat");

async function main() {
  const network = await hre.ethers.provider.getNetwork();

  if (network.chainId !== 97n) {
    throw new Error(
      `رفض النشر: المطلوب BSC Testnet (97)، والشبكة الحالية ${network.chainId}`
    );
  }

  if (!process.env.DEPLOYER_PRIVATE_KEY) {
    throw new Error("أضف DEPLOYER_PRIVATE_KEY لمحفظة اختبار إلى ملف .env");
  }

  const moderator = process.env.TRUSTED_MODERATOR_ADDRESS;

  if (!moderator || !hre.ethers.isAddress(moderator)) {
    throw new Error("أضف TRUSTED_MODERATOR_ADDRESS صالحًا إلى ملف .env");
  }

  const [deployer] = await hre.ethers.getSigners();

  if (moderator.toLowerCase() === deployer.address.toLowerCase()) {
    throw new Error("يجب أن يكون عنوان المشرف مختلفًا عن عنوان الناشر");
  }

  console.log("الشبكة: BSC Testnet");
  console.log("الناشر/بائع الاختبار:", deployer.address);
  console.log("المشرف:", moderator);

  const Token = await hre.ethers.getContractFactory("MockUSDT");
  const token = await Token.deploy();
  await token.waitForDeployment();

  const tokenAddress = await token.getAddress();

  const Escrow = await hre.ethers.getContractFactory(
    "WathiqUSDTP2PEscrow"
  );

  const escrow = await Escrow.deploy(tokenAddress, moderator);
  await escrow.waitForDeployment();

  await (
    await token.mint(deployer.address, 1000n * 10n ** 6n)
  ).wait();

  console.log("\nتم نشر نسخة الاختبار بنجاح");
  console.log("رمز mUSDT التجريبي:", tokenAddress);
  console.log("عقد P2P Escrow:", await escrow.getAddress());
  console.log(
    "رصيد البائع التجريبي:",
    (await token.balanceOf(deployer.address)).toString()
  );
  console.log(
    "مستكشف الرمز:",
    `https://testnet.bscscan.com/address/${tokenAddress}`
  );
  console.log(
    "مستكشف العقد:",
    `https://testnet.bscscan.com/address/${await escrow.getAddress()}`
  );

  console.log("\nتحذير: mUSDT رمز تجريبي وليس USDT حقيقيًا.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
