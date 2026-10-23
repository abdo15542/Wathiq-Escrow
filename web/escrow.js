(() => {
  const cfg = window.WATHIQ_CONFIG || {};
  const statusEl = document.getElementById('escrowStatus');
  const outputEl = document.getElementById('escrowDetails');
  const tokenAbi = [
    'function decimals() view returns (uint8)',
    'function symbol() view returns (string)',
    'function mint(address to,uint256 amount)',
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
  let walletListenersAttached = false;

  function status(message, isError = false) {
    statusEl.textContent = message;
    statusEl.style.color = isError ? '#ff9d9d' : '';
  }
  function invalidateWallet(message) {
    signer = null;
    account = null;
    token = null;
    escrow = null;
    status(message, true);
  }
  function onAccountsChanged(accounts) {
    invalidateWallet(Array.isArray(accounts) && accounts.length
      ? 'تغيّر حساب المحفظة. أعد ربط المحفظة قبل أي عملية.'
      : 'تم فصل المحفظة. أعد ربطها للمتابعة.');
  }
  function onChainChanged(chainId) {
    const nextChainId = typeof chainId === 'string' ? Number.parseInt(chainId, 16) : Number(chainId);
    invalidateWallet(nextChainId === 97
      ? 'تغيّرت الشبكة. أعد ربط المحفظة للتحقق من العقد والشبكة.'
      : 'قفل أمان: تغيّرت الشبكة عن BNB Smart Chain Testnet. أعد ربط المحفظة.');
  }
  function onWalletDisconnected() {
    invalidateWallet('انقطع اتصال المحفظة. أعد ربطها قبل المتابعة.');
  }
  function attachWalletListeners() {
    if (walletListenersAttached || !window.ethereum || typeof window.ethereum.on !== 'function') return;
    window.ethereum.on('accountsChanged', onAccountsChanged);
    window.ethereum.on('chainChanged', onChainChanged);
    window.ethereum.on('disconnect', onWalletDisconnected);
    walletListenersAttached = true;
  }
  function requireConfig() {
    if (!window.ethers) throw new Error('تعذر تحميل مكتبة المحفظة. تحقق من اتصال الإنترنت ثم أعد المحاولة.');
    // Hard safety lock: this UI is not approved for mainnet or real-value tokens.
    // Even if deployment variables are misconfigured, never initiate a mainnet transaction.
    if (Number(cfg.chainId || 97) !== 97) throw new Error('قفل أمان: هذا الإصدار يعمل على BNB Smart Chain Testnet فقط، والمعاملات على الشبكة الرئيسية معطلة.');
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
    const tokenSymbol = await token.symbol();
    if (tokenSymbol !== 'mUSDT') throw new Error('قفل أمان: الرمز المتصل ليس mUSDT التجريبي؛ لن تُنفّذ أي معاملة.');
    attachWalletListeners();
    status('تم ربط المحفظة ' + account.slice(0, 6) + '…' + account.slice(-4) + ' على شبكة الاختبار باستخدام mUSDT التجريبي.');
    await refreshBalance();
  }
  async function ensureConnected() {
    if (!signer) {
      await connect();
      return;
    }
    // Wallets can switch networks after connection. Re-check before every read/write action.
    const network = await provider.getNetwork();
    if (Number(network.chainId) !== 97) {
      signer = null; account = null; token = null; escrow = null;
      throw new Error('قفل أمان: تغيّرت الشبكة. أعد ربط المحفظة على BNB Smart Chain Testnet قبل المتابعة.');
    }
    const currentAccount = await signer.getAddress();
    if (!account || currentAccount.toLowerCase() !== account.toLowerCase()) {
      signer = null; account = null; token = null; escrow = null;
      throw new Error('تغيّر حساب المحفظة. أعد ربط المحفظة قبل المتابعة.');
    }
  }
  async function mintTestTokens() {
    await ensureConnected();
    if (Number(cfg.chainId || 97) !== 97) throw new Error('إنشاء رموز الاختبار مسموح فقط على BSC Testnet.');
    const symbol = await token.symbol();
    if (symbol !== 'mUSDT') throw new Error('هذا العنوان ليس رمز MockUSDT التجريبي؛ لن يتم إنشاء أي رموز.');
    const decimals = await token.decimals();
    status('أكّد إنشاء 1000 رمز اختبار مجاني في المحفظة…');
    const tx = await token.mint(account, ethers.parseUnits('1000', decimals));
    await tx.wait();
    status('تم إصدار 1000 mUSDT تجريبية على شبكة الاختبار. هذه الرموز لا قيمة مالية لها. المعاملة: ' + tx.hash);
    await refreshBalance();
  }
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
  async function loadMyEscrowDeals() {
    await ensureConnected();
    status('جارٍ البحث عن صفقات هذه المحفظة في آخر 10000 كتلة…');
    const latestBlock = await provider.getBlockNumber();
    const fromBlock = Math.max(0, latestBlock - 10000);
    const [asBuyer, asSeller] = await Promise.all([
      escrow.queryFilter(escrow.filters.DealCreated(null, account, null), fromBlock, latestBlock),
      escrow.queryFilter(escrow.filters.DealCreated(null, null, account), fromBlock, latestBlock)
    ]);
    const unique = new Map();
    for (const event of [...asBuyer, ...asSeller]) {
      if (event.args) unique.set(event.args.dealId.toString(), event.args);
    }
    const ids = [...unique.keys()].sort((a, b) => BigInt(a) > BigInt(b) ? -1 : BigInt(a) < BigInt(b) ? 1 : 0).slice(0, 50);
    if (!ids.length) {
      outputEl.textContent = 'لم تُعثر على صفقات مشتري/بائع لهذه المحفظة في آخر 10000 كتلة. قد تكون الصفقة أقدم من نطاق البحث.';
      status('اكتمل البحث؛ لم تُعثر على صفقات ضمن نطاق البحث.');
      return;
    }
    const decimals = await token.decimals();
    const states = ['غير موجودة', 'مموّلة', 'محررة للبائع', 'مستردة للمشتري'];
    const rows = await Promise.all(ids.map(async id => {
      const deal = await escrow.getDeal(BigInt(id));
      return 'الصفقة #' + id + ' · ' + states[Number(deal.status)] +
        ' · المبلغ: ' + ethers.formatUnits(deal.amount, decimals) +
        ' mUSDT · الدور: ' + (deal.buyer.toLowerCase() === account.toLowerCase() ? 'مشتري' : 'بائع');
    }));
    outputEl.textContent = 'صفقات المحفظة (آخر 10000 كتلة، بحد أقصى 50 صفقة):\n' + rows.join('\n') +
      '\n\nللتصويت أو قراءة التفاصيل، انسخ رقم الصفقة إلى حقل «رقم الصفقة» ثم اختر الإجراء.';
    status('تم تحميل ' + rows.length + ' صفقة من عقد الاختبار.');
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
  bind('loadMyEscrowDeals', loadMyEscrowDeals, 'تعذر تحميل صفقات المحفظة');
  bind('mintTestTokens', mintTestTokens, 'تعذر إصدار رموز الاختبار');
  bind('createEscrowDeal', createDeal, 'تعذر إنشاء الصفقة');
  bind('readEscrowDeal', readDeal, 'تعذر قراءة الصفقة');
  bind('voteRelease', () => transact('release', 'التصويت لتحرير المبلغ'), 'تعذر التصويت');
  bind('voteRefund', () => transact('refund', 'التصويت لاسترداد المبلغ'), 'تعذر التصويت');
  bind('refundExpired', () => transact('expire', 'استرداد الصفقة المنتهية'), 'تعذر الاسترداد');
  bind('withdrawEscrow', () => transact('withdraw', 'سحب الرصيد المستحق'), 'تعذر السحب');

  if (window.ethereum && typeof window.ethereum.on === 'function') {
    const resetWallet = message => {
      provider = null; signer = null; account = null; token = null; escrow = null;
      status(message, true);
    };
    window.ethereum.on('chainChanged', () => resetWallet('تغيّرت الشبكة؛ أعد ربط المحفظة على شبكة الاختبار.'));
    window.ethereum.on('accountsChanged', () => resetWallet('تغيّر حساب المحفظة؛ أعد ربط المحفظة.'));
  }
})();
