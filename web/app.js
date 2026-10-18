const API = window.WATHIQ_API || 'http://localhost:4000';
const TESTNET_CHAIN_ID = '0x61';

const TESTNET_PARAMS = {
  chainId: TESTNET_CHAIN_ID,
  chainName: 'BNB Smart Chain Testnet',
  nativeCurrency: {
    name: 'tBNB',
    symbol: 'tBNB',
    decimals: 18
  },
  rpcUrls: ['https://bsc-testnet-dataseed.bnbchain.org'],
  blockExplorerUrls: ['https://testnet.bscscan.com/']
};

const paymentLabels = {
  bank_transfer: 'تحويل بنكي',
  cash: 'نقدًا خارج المنصة',
  crypto: 'عملة رقمية',
  digital_service: 'خدمة رقمية',
  gift_card: 'بطاقة هدايا'
};

const statusEl = document.getElementById('status');
const offersEl = document.getElementById('offers');
const connectBtn = document.getElementById('connect');

let connectedAccount = null;

async function loadOffers() {
  try {
    const response = await fetch(`${API}/api/offers`);
    if (!response.ok) throw new Error('API unavailable');

    const data = await response.json();
    offersEl.replaceChildren();

    for (const offer of data.items || []) {
      const article = document.createElement('article');
      article.className = 'offer';

      const heading = document.createElement('h3');
      heading.textContent = offer.title;

      const price = document.createElement('p');
      price.textContent = `${offer.price} ${offer.asset}`;

      const payment = document.createElement('small');
      payment.textContent =
        paymentLabels[offer.paymentMethod] || offer.paymentMethod;

      article.append(heading, price, payment);
      offersEl.append(article);
    }

    if (!(data.items || []).length) {
      offersEl.textContent = 'لا توجد عروض بعد.';
    }
  } catch {
    statusEl.textContent =
      'تعذر الاتصال بواجهة API. شغّل خادم التطوير أولًا.';
  }
}

async function ensureTestnet() {
  let chainId = await window.ethereum.request({
    method: 'eth_chainId'
  });

  if (chainId.toLowerCase() === TESTNET_CHAIN_ID) return;

  try {
    await window.ethereum.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: TESTNET_CHAIN_ID }]
    });
  } catch (error) {
    if (error.code !== 4902) throw error;

    await window.ethereum.request({
      method: 'wallet_addEthereumChain',
      params: [TESTNET_PARAMS]
    });

    await window.ethereum.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: TESTNET_CHAIN_ID }]
    });
  }

  chainId = await window.ethereum.request({
    method: 'eth_chainId'
  });

  if (chainId.toLowerCase() !== TESTNET_CHAIN_ID) {
    throw new Error('لم يتم الانتقال إلى شبكة الاختبار.');
  }
}

connectBtn.addEventListener('click', async () => {
  if (!window.ethereum) {
    statusEl.textContent =
      'لم يتم العثور على محفظة متوافقة. افتح الموقع في متصفح يدعم المحفظة.';
    return;
  }

  connectBtn.disabled = true;

  try {
    await ensureTestnet();

    const accounts = await window.ethereum.request({
      method: 'eth_requestAccounts'
    });

    if (!accounts.length) {
      throw new Error('لم يتم اختيار حساب للمحفظة.');
    }

    connectedAccount = accounts[0];

    statusEl.textContent =
      `اتصلت المحفظة على BNB Testnet: ` +
      `${connectedAccount.slice(0, 6)}…${connectedAccount.slice(-4)}. ` +
      'الاتصال بالعقد الذكي لم يُفعّل بعد.';
  } catch (error) {
    if (error.code === 4001) {
      statusEl.textContent = 'ألغيت طلب الاتصال أو تبديل الشبكة.';
    } else {
      statusEl.textContent =
        `تعذر الاتصال: ${error.message || 'خطأ غير معروف'}`;
    }
  } finally {
    connectBtn.disabled = false;
  }
});

if (window.ethereum?.on) {
  window.ethereum.on('accountsChanged', (accounts) => {
    connectedAccount = accounts[0] || null;
    statusEl.textContent = connectedAccount
      ? `تغيّر الحساب المتصل إلى ${connectedAccount.slice(0, 6)}…${connectedAccount.slice(-4)}. لم يتم تنفيذ أي معاملة.`
      : 'تم فصل المحفظة.';
  });

  window.ethereum.on('chainChanged', (chainId) => {
    if (chainId.toLowerCase() !== TESTNET_CHAIN_ID) {
      statusEl.textContent =
        'تنبيه: أنت خارج BNB Testnet. لا تنفّذ أي معاملة من هذه الواجهة.';
    } else if (connectedAccount) {
      statusEl.textContent =
        'المحفظة متصلة بشبكة الاختبار. العقد الذكي غير مربوط بالواجهة بعد.';
    }
  });
}

document.getElementById('offerForm').addEventListener('submit', async (event) => {
  event.preventDefault();

  const form = new FormData(event.currentTarget);

  try {
    const response = await fetch(`${API}/api/offers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: form.get('title'),
        asset: 'BNB',
        price: Number(form.get('price')),
        paymentMethod: form.get('paymentMethod')
      })
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || 'تعذر حفظ العرض');
    }

    statusEl.textContent =
      'أُضيف العرض إلى API التطوير فقط؛ لم تُنشأ صفقة على البلوكشين.';
    event.currentTarget.reset();
    await loadOffers();
  } catch (error) {
    statusEl.textContent =
      `تعذرت إضافة العرض: ${error.message}. تحقق من تشغيل API.`;
  }
});

loadOffers();
