(() => {
  const cfg = window.WATHIQ_CONFIG || {};
  const statusEl = document.getElementById('escrowStatus');
  const outputEl = document.getElementById('escrowDetails');
  const escrowAbi = [
    'function createDeal(address payable seller,address arbiter) payable returns (uint256 dealId)',
    'function voteRelease(uint256 dealId)',
    'function voteRefund(uint256 dealId)',
    'function withdraw()',
    'function getDeal(uint256 dealId) view returns (tuple(address buyer,address seller,address arbiter,uint256 amount,uint64 createdAt,uint8 status,uint8 releaseVotes,uint8 refundVotes))',
    'function pendingWithdrawals(address account) view returns (uint256)',
    'event DealCreated(uint256 indexed dealId,address indexed buyer,address indexed seller,address arbiter,uint256 amount)',
    'event DealSettled(uint256 indexed dealId,uint8 status,address indexed recipient,uint256 amount)'
  ];

  let provider;
  let signer;
  let account;
  let escrow;
  let walletListenersAttached = false;

  function status(message, isError = false) {
    statusEl.textContent = message;
    statusEl.style.color = isError ? '#ff9d9d' : '';
  }

  function invalidateWallet(message) {
    provider = null;
    signer = null;
    account = null;
    escrow = null;
    status(message, true);
  }

  function requireConfig() {
    if (!window.ethers) throw new Error('تعذر تحميل مكتبة المحفظة. تحقق من الاتصال ثم أعد المحاولة.');
    if (Number(cfg.chainId || 97) !== 97) {
      throw new Error('قفل أمان: هذا الإصدار مخصص لشبكة BNB Smart Chain Testnet فقط.');
    }
    if (!cfg.escrowAddress || !ethers.isAddress(cfg.escrowAddress)) {
      throw new Error('عنوان عقد الضمان غير مضبوط. انشر عقد WathiqEscrow على شبكة الاختبار ثم اضبط WATHIQ_ESCROW_ADDRESS.');
    }
  }

  async function connect() {
    requireConfig();
    if (!window.ethereum) throw new Error('يلزم متصفح يدعم محفظة EVM مثل MetaMask.');
    provider = new ethers.BrowserProvider(window.ethereum);
    await provider.send('eth_requestAccounts', []);
    let network = await provider.getNetwork();
    if (Number(network.chainId) !== 97) {
      try {
        await provider.send('wallet_switchEthereumChain', [{ chainId: '0x61' }]);
      } catch (error) {
        if (error.code !== 4902) throw error;
        await provider.send('wallet_addEthereumChain', [{
          chainId: '0x61',
          chainName: 'BNB Smart Chain Testnet',
          nativeCurrency: { name: 'Test BNB', symbol: 'tBNB', decimals: 18 },
          rpcUrls: [cfg.rpcUrl || 'https://bsc-testnet-dataseed.bnbchain.org'],
          blockExplorerUrls: [cfg.explorerUrl || 'https://testnet.bscscan.com']
        }]);
      }
      provider = new ethers.BrowserProvider(window.ethereum);
      network = await provider.getNetwork();
      if (Number(network.chainId) !== 97) throw new Error('اختر BNB Smart Chain Testnet في المحفظة أولًا.');
    }
    signer = await provider.getSigner();
    account = await signer.getAddress();
    escrow = new ethers.Contract(cfg.escrowAddress, escrowAbi, signer);
    // Verify the configured address contains contract code before enabling transactions.
    const code = await provider.getCode(cfg.escrowAddress);
    if (!code || code === '0x') throw new Error('لا يوجد عقد منشور في العنوان المضبوط على شبكة الاختبار.');
    attachWalletListeners();
    status('تم ربط المحفظة ' + account.slice(0, 6) + '…' + account.slice(-4) + ' على شبكة الاختبار. الضمان يستخدم BNB الاختباري الأصلي، لا رمز ERC-20.');
    await refreshBalance();
  }

  function attachWalletListeners() {
    if (walletListenersAttached || !window.ethereum || typeof window.ethereum.on !== 'function') return;
    window.ethereum.on('accountsChanged', accounts => invalidateWallet(
      Array.isArray(accounts) && accounts.length ? 'تغيّر حساب المحفظة. أعد ربطها قبل المتابعة.' : 'تم فصل المحفظة. أعد ربطها قبل المتابعة.'
    ));
    window.ethereum.on('chainChanged', chainId => invalidateWallet(
      Number.parseInt(chainId, 16) === 97 ? 'تغيّرت الشبكة؛ أعد ربط المحفظة للتحقق من الإعدادات.' : 'قفل أمان: اختر BNB Smart Chain Testnet ثم أعد ربط المحفظة.'
    ));
    window.ethereum.on('disconnect', () => invalidateWallet('انقطع اتصال المحفظة. أعد ربطها قبل المتابعة.'));
    walletListenersAttached = true;
  }

  async function ensureConnected() {
    if (!signer) {
      await connect();
      return;
    }
    const network = await provider.getNetwork();
    if (Number(network.chainId) !== 97) {
      invalidateWallet('قفل أمان: تغيّرت الشبكة. أعد ربط المحفظة على شبكة الاختبار.');
      throw new Error('المعاملات مسموحة على شبكة الاختبار فقط.');
    }
    const currentAccount = await signer.getAddress();
    if (!account || currentAccount.toLowerCase() !== account.toLowerCase()) {
      invalidateWallet('تغيّر حساب المحفظة. أعد ربط المحفظة.');
      throw new Error('تغيّر حساب المحفظة.');
    }
    const code = await provider.getCode(cfg.escrowAddress);
    if (!code || code === '0x') throw new Error('لم يعد عنوان عقد الضمان يحتوي على عقد على الشبكة الحالية.');
  }

  async function refreshBalance() {
    if (!provider || !account || !escrow) return;
    const balance = await provider.getBalance(account);
    const pending = await escrow.pendingWithdrawals(account);
    outputEl.textContent = 'المحفظة: ' + account +
      '\nرصيد BNB الاختباري: ' + ethers.formatEther(balance) +
      '\nالمبلغ المستحق للسحب: ' + ethers.formatEther(pending) + ' BNB' +
      '\nعقد الضمان: ' + cfg.escrowAddress;
  }

  async function createDeal() {
    await ensureConnected();
    const seller = document.getElementById('sellerAddress').value.trim();
    const arbiter = document.getElementById('arbiterAddress').value.trim();
    const amountText = document.getElementById('escrowAmount').value.trim();
    if (!ethers.isAddress(seller) || !ethers.isAddress(arbiter)) throw new Error('أدخل عنواني محفظة صحيحين للبائع والمحكّم.');
    if (seller.toLowerCase() === account.toLowerCase() || arbiter.toLowerCase() === account.toLowerCase() || seller.toLowerCase() === arbiter.toLowerCase()) {
      throw new Error('يجب أن تكون محافظ المشتري والبائع والمحكّم ثلاث محافظ مختلفة.');
    }
    if (!amountText || !Number.isFinite(Number(amountText)) || Number(amountText) <= 0) throw new Error('أدخل مبلغ BNB اختباري موجبًا.');
    const amount = ethers.parseEther(amountText);
    status('أكّد إيداع BNB الاختباري وإنشاء الصفقة في المحفظة…');
    const tx = await escrow.createDeal(seller, arbiter, { value: amount });
    const receipt = await tx.wait();
    let dealId = '';
    for (const log of receipt.logs) {
      try {
        const parsed = escrow.interface.parseLog(log);
        if (parsed && parsed.name === 'DealCreated') dealId = parsed.args.dealId.toString();
      } catch (_) {}
    }
    status('تم إنشاء صفقة الضمان على شبكة الاختبار. رقم الصفقة: ' + (dealId || 'راجع مستكشف الكتل') + ' — المعاملة: ' + tx.hash);
    if (dealId) document.getElementById('dealId').value = dealId;
    await refreshBalance();
    if (dealId) await readDeal();
  }

  async function readDeal() {
    await ensureConnected();
    const id = document.getElementById('dealId').value.trim();
    if (!/^[1-9]\d*$/.test(id)) throw new Error('أدخل رقم صفقة صحيحًا.');
    const d = await escrow.getDeal(BigInt(id));
    const states = ['غير موجودة', 'مموّلة', 'محررة للبائع', 'مستردة للمشتري'];
    outputEl.textContent = 'رقم الصفقة: ' + id +
      '\nالمشتري: ' + d.buyer + '\nالبائع: ' + d.seller + '\nالمحكّم: ' + d.arbiter +
      '\nالمبلغ: ' + ethers.formatEther(d.amount) + ' BNB' +
      '\nالحالة: ' + (states[Number(d.status)] || 'غير معروفة') +
      '\nأصوات التحرير: ' + d.releaseVotes + '\nأصوات الاسترداد: ' + d.refundVotes +
      '\nتاريخ الإنشاء: ' + new Date(Number(d.createdAt) * 1000).toLocaleString();
    status('تم جلب حالة الصفقة مباشرة من عقد الضمان.');
  }

  async function loadMyEscrowDeals() {
    await ensureConnected();
    status('جارٍ البحث عن صفقات المحفظة في آخر 10000 كتلة…');
    const latestBlock = await provider.getBlockNumber();
    const fromBlock = Math.max(0, latestBlock - 10000);
    const chunkSize = 2000;
    const filter = escrow.filters.DealCreated();
    const unique = new Map();
    for (let start = fromBlock; start <= latestBlock; start += chunkSize) {
      const end = Math.min(start + chunkSize - 1, latestBlock);
      const events = await escrow.queryFilter(filter, start, end);
      for (const event of events) {
        if (!event.args) continue;
        const args = event.args;
        if ([args.buyer, args.seller, args.arbiter].some(address =>
          typeof address === 'string' && address.toLowerCase() === account.toLowerCase())) {
          unique.set(args.dealId.toString(), args);
        }
      }
    }
    const ids = [...unique.keys()].sort((a, b) => BigInt(a) > BigInt(b) ? -1 : BigInt(a) < BigInt(b) ? 1 : 0).slice(0, 50);
    if (!ids.length) {
      outputEl.textContent = 'لم تُعثر على صفقات لهذه المحفظة في آخر 10000 كتلة. قد تكون الصفقة أقدم من نطاق البحث.';
      status('اكتمل البحث؛ لم تُعثر على صفقات ضمن نطاق البحث.');
      return;
    }
    const states = ['غير موجودة', 'مموّلة', 'محررة للبائع', 'مستردة للمشتري'];
    const rows = await Promise.all(ids.map(async id => {
      const d = await escrow.getDeal(BigInt(id));
      const role = d.buyer.toLowerCase() === account.toLowerCase()
        ? 'مشتري'
        : d.seller.toLowerCase() === account.toLowerCase() ? 'بائع' : 'محكّم';
      return 'الصفقة #' + id + ' · ' + (states[Number(d.status)] || 'غير معروفة') +
        ' · المبلغ: ' + ethers.formatEther(d.amount) + ' BNB · الدور: ' + role;
    }));
    outputEl.textContent = 'صفقات المحفظة (آخر 10000 كتلة، بحد أقصى 50 صفقة):\n' + rows.join('\n') +
      '\n\nانسخ رقم الصفقة إلى الحقل المخصص لقراءة تفاصيلها أو التصويت.';
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
    else tx = await escrow.withdraw();
    await tx.wait();
    status('نجحت العملية على شبكة الاختبار. المعاملة: ' + tx.hash);
    await refreshBalance();
    if (action !== 'withdraw') await readDeal();
  }

  function bind(id, fn, label) {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('click', async () => {
      try { await fn(); } catch (error) { status(error.shortMessage || error.message || label, true); }
    });
  }

  bind('connectWallet', connect, 'تعذر ربط المحفظة');
  bind('loadMyEscrowDeals', loadMyEscrowDeals, 'تعذر تحميل صفقات المحفظة');
  bind('createEscrowDeal', createDeal, 'تعذر إنشاء الصفقة');
  bind('readEscrowDeal', readDeal, 'تعذر قراءة الصفقة');
  bind('voteRelease', () => transact('release', 'التصويت لتحرير المبلغ'), 'تعذر التصويت');
  bind('voteRefund', () => transact('refund', 'التصويت لاسترداد المبلغ'), 'تعذر التصويت');
  bind('withdrawEscrow', () => transact('withdraw', 'سحب الرصيد المستحق'), 'تعذر السحب');

  // Remove controls for features that the deployed native-BNB contract does not implement.
  for (const id of ['mintTestTokens', 'refundExpired']) {
    const el = document.getElementById(id);
    if (el) el.hidden = true;
  }
})();