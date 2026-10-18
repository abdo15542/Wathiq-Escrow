(() => {
  const cfg = window.WATHIQ_CONFIG || {};
  const statusEl = document.getElementById('escrowStatus');
  const outputEl = document.getElementById('escrowDetails');
  const tokenAbi = [
    'function decimals() view returns (uint8)',
    'function approve(address spender,uint256 amount) returns (bool)',
    'function balanceOf(address account) view returns (uint256)',
    'function allowance(address owner,address spender) view returns (uint256)'
  ];
  const escrowAbi = [
    'function token() view returns (address)',
    'function createDeal(address seller,address arbiter,uint256 amount) returns (uint256)',
    'function voteRelease(uint256 dealId)',
    'function voteRefund(uint256 dealId)',
    'function withdraw()',
    'function refundExpired(uint256 dealId)',
    'function getDeal(uint256 dealId) view returns (tuple(address buyer,address seller,address arbiter,uint256 amount,uint64 createdAt,uint8 status,uint8 releaseVotes,uint8 refundVotes))',
    'function pendingWithdrawals(address account) view returns (uint256)',
    'event DealCreated(uint256 indexed dealId,address indexed buyer,address indexed seller,address arbiter,uint256 amount)',
    'event DealSettled(uint256 indexed dealId,uint8 status,address indexed recipient,uint256 amount)'
  ];
  let provider;
  let signer;
  let account;
  let token;
  let escrow;

  function status(message, isError = false) {
    statusEl.textContent = message;
    statusEl.style.color = isError ? '#ff9d9d' : '';
  }
  function requireConfig() {
    if (!window.ethers) throw new Error('تعذر تحميل مكتبة المحفظة. تحقق من اتصال الإنترنت ثم أعد المحاولة.');
    if (!cfg.escrowAddress || !cfg.tokenAddress || !window.ethers.isAddress(cfg.escrowAddress) || !window.ethers.isAddress(cfg.tokenAddress)) {
      throw new Error('لم تُضبط عناوين عقد الضمان ورمز ERC-20 بعد. انشر نسخة الاختبار واضبط WATHIQ_ESCROW_ADDRESS وWATHIQ_TOKEN_ADDRESS.');
    }
  }
  async function connect() {
    requireConfig();
    if (!window.ethereum) throw new Error('يلزم متصفح يدعم محفظة EVM مثل MetaMask.');
    provider = new ethers.BrowserProvider(window.ethereum);
    await provider.send('eth_requestAccounts', []);
    let network = await provider.getNetwork();
    if (Number(network.chainId) !== Number(cfg.chainId || 97)) {
      try {
        await provider.send('wallet_switchEthereumChain', [{ chainId: '0x' + Number(cfg.chainId || 97).toString(16) }]);
      } catch (error) {
        if (error.code !== 4902) throw error;
        await provider.send('wallet_addEthereumChain', [{
          chainId: '0x' + Number(cfg.chainId || 97).toString(16),
          chainName: cfg.chainName || 'BNB Smart Chain Testnet',
          nativeCurrency: { name: 'tBNB', symbol: 'tBNB', decimals: 18 },
          rpcUrls: [cfg.rpcUrl || 'https://bsc-testnet-dataseed.bnbchain.org'],
          blockExplorerUrls: [cfg.explorerUrl || 'https://testnet.bscscan.com']
        }]);
      }
      provider = new ethers.BrowserProvider(window.ethereum);
      network = await provider.getNetwork();
      if (Number(network.chainId) !== Number(cfg.chainId || 97)) throw new Error('اختر الشبكة الصحيحة أولًا.');
    }
    signer = await provider.getSigner();
    account = await signer.getAddress();
    token = new ethers.Contract(cfg.tokenAddress, tokenAbi, signer);
    escrow = new ethers.Contract(cfg.escrowAddress, escrowAbi, signer);
    const contractToken = await escrow.token();
    if (contractToken.toLowerCase() !== cfg.tokenAddress.toLowerCase()) throw new Error('عنوان الرمز لا يطابق الرمز المثبت داخل عقد الضمان.');
    status('تم ربط المحفظة ' + account.slice(0, 6) + '…' + account.slice(-4) + ' على شبكة الاختبار.');
    await refreshBalance();
  }
  async function ensureConnected() { if (!signer) await connect(); }
  async function refreshBalance() {
    if (!token || !account) return;
    const decimals = await token.decimals();
    const balance = await token.balanceOf(account);
    const pending = await escrow.pendingWithdrawals(account);
    outputEl.textContent = 'المحفظة: ' + account + '\nرصيد رمز الاختبار: ' + ethers.formatUnits(balance, decimals) +
      '\nالمبلغ القابل للسحب من الضمان: ' + ethers.formatUnits(pending, decimals) +
      '\nعقد الضمان: ' + cfg.escrowAddress;
  }
  async function createDeal() {
    await ensureConnected();
    const seller = document.getElementById('sellerAddress').value.trim();
    const arbiter = document.getElementById('arbiterAddress').value.trim();
    const amountText = document.getElementById('escrowAmount').value.trim();
    if (!ethers.isAddress(seller) || !ethers.isAddress(arbiter)) throw new Error('أدخل عنواني محفظة صحيحين للبائع والمحكّم.');
    if (seller.toLowerCase() === account.toLowerCase() || arbiter.toLowerCase() === account.toLowerCase() || seller.toLowerCase() === arbiter.toLowerCase()) throw new Error('يجب أن تكون المحافظ الثلاث مختلفة.');
    const decimals = await token.decimals();
    const amount = ethers.parseUnits(amountText, decimals);
    if (amount <= 0n) throw new Error('أدخل مبلغًا موجبًا.');
    status('يرجى تأكيد موافقة الرمز في المحفظة…');
    const approval = await token.approve(cfg.escrowAddress, amount);
    await approval.wait();
    status('تمت الموافقة. أكّد إنشاء صفقة الضمان في المحفظة…');
    const tx = await escrow.createDeal(seller, arbiter, amount);
    const receipt = await tx.wait();
    let dealId = '';
    for (const log of receipt.logs) {
      try {
        const parsed = escrow.interface.parseLog(log);
        if (parsed && parsed.name === 'DealCreated') dealId = parsed.args.dealId.toString();
      } catch (_) {}
    }
    status('تم إنشاء صفقة على الشبكة. رقم الصفقة: ' + (dealId || 'راجع مستكشف الكتل') + ' — المعاملة: ' + tx.hash);
    document.getElementById('dealId').value = dealId;
    await refreshBalance();
    if (dealId) await readDeal();
  }
  async function readDeal() {
    await ensureConnected();
    const id = document.getElementById('dealId').value.trim();
    if (!/^[1-9]\d*$/.test(id)) throw new Error('أدخل رقم صفقة صحيحًا.');
    const d = await escrow.getDeal(BigInt(id));
    const decimals = await token.decimals();
    const states = ['غير موجودة', 'مموّلة', 'محررة للبائع', 'مستردة للمشتري'];
    const created = new Date(Number(d.createdAt) * 1000).toLocaleString();
    outputEl.textContent = 'رقم الصفقة: ' + id +
      '\nالمشتري: ' + d.buyer + '\nالبائع: ' + d.seller + '\nالمحكّم: ' + d.arbiter +
      '\nالمبلغ: ' + ethers.formatUnits(d.amount, decimals) + '\nالحالة: ' + (states[Number(d.status)] || 'غير معروفة') +
      '\nأصوات التحرير: ' + d.releaseVotes + '\nأصوات الاسترداد: ' + d.refundVotes + '\nتاريخ الإنشاء: ' + created;
    status('تم جلب حالة الصفقة مباشرة من العقد.');
  }
  async function transact(action, label) {
    await ensureConnected();
    const id = document.getElementById('dealId').value.trim();
    if (action !== 'withdraw' && !/^[1-9]\d*$/.test(id)) throw new Error('أدخل رقم صفقة صحيحًا.');
    status('أكّد العملية في المحفظة: ' + label);
    let tx;
    if (action === 'release') tx = await escrow.voteRelease(BigInt(id));
    else if (action === 'refund') tx = await escrow.voteRefund(BigInt(id));
    else if (action === 'expire') tx = await escrow.refundExpired(BigInt(id));
    else tx = await escrow.withdraw();
    await tx.wait();
    status('نجحت العملية على الشبكة. المعاملة: ' + tx.hash);
    await refreshBalance();
    if (action !== 'withdraw') await readDeal();
  }
  function bind(id, fn, label) {
    document.getElementById(id).addEventListener('click', async () => {
      try { await fn(); } catch (error) { status(error.shortMessage || error.message || label, true); }
    });
  }
  bind('connectWallet', connect, 'تعذر ربط المحفظة');
  bind('createEscrowDeal', createDeal, 'تعذر إنشاء الصفقة');
  bind('readEscrowDeal', readDeal, 'تعذر قراءة الصفقة');
  bind('voteRelease', () => transact('release', 'التصويت لتحرير المبلغ'), 'تعذر التصويت');
  bind('voteRefund', () => transact('refund', 'التصويت لاسترداد المبلغ'), 'تعذر التصويت');
  bind('refundExpired', () => transact('expire', 'استرداد الصفقة المنتهية'), 'تعذر الاسترداد');
  bind('withdrawEscrow', () => transact('withdraw', 'سحب الرصيد المستحق'), 'تعذر السحب');
})();
