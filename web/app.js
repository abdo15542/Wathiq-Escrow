const API = (window.WATHIQ_CONFIG && window.WATHIQ_CONFIG.apiBaseUrl) || window.WATHIQ_API || '';
const paymentLabels = { bank_transfer: 'تحويل بنكي', cash: 'نقدًا خارج المنصة', crypto: 'عملة رقمية', digital_service: 'خدمة رقمية', gift_card: 'بطاقة هدايا' };
const statusEl = document.getElementById('status');
const offersEl = document.getElementById('offers');
const accountStatus = document.getElementById('accountStatus');
const authForm = document.getElementById('authForm');
const displayName = document.getElementById('displayName');
const offerForm = document.getElementById('offerForm');
let authToken = sessionStorage.getItem('wathiq_token') || '';
let accountEmail = sessionStorage.getItem('wathiq_email') || '';

function setAccountStatus(message) {
  accountStatus.textContent = message;
  offerForm.querySelector('button[type="submit"]').disabled = !authToken;
  offerForm.querySelector('button[type="submit"]').textContent = authToken ? 'إضافة عرض للسوق' : 'سجّل الدخول أولًا';
}
function apiUrl(path) {
  if (!API) throw new Error('لم يتم ضبط عنوان API الإنتاجي. أضف WATHIQ_API_BASE_URL إلى إعدادات نشر الموقع.');
  return API.replace(/\/+$/, '') + path;
}
async function request(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (authToken) headers.authorization = 'Bearer ' + authToken;
  if (options.body) headers['content-type'] = 'application/json';
  const response = await fetch(apiUrl(path), { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'فشل الطلب: HTTP ' + response.status);
  return data;
}

async function loadMyOffers() {
  const mineEl = document.getElementById('myOffers');
  if (!authToken) {
    mineEl.textContent = 'سجّل الدخول لعرض عروضك.';
    return;
  }
  mineEl.textContent = 'جارٍ تحميل عروضك...';
  try {
    const data = await request('/api/my/offers?limit=50');
    mineEl.replaceChildren();
    for (const offer of data.items) {
      const el = document.createElement('article');
      el.className = 'offer';
      const title = document.createElement('h3');
      title.textContent = offer.title;
      const details = document.createElement('p');
      details.textContent = offer.price + ' ' + offer.asset + ' · ' + (paymentLabels[offer.paymentMethod] || offer.paymentMethod);
      const state = document.createElement('small');
      state.textContent = 'الحالة: ' + offer.status;
      el.append(title, details, state);
      mineEl.append(el);
    }
    if (!data.items.length) mineEl.textContent = 'ليس لديك عروض حتى الآن.';
  } catch (error) {
    mineEl.textContent = error.message || 'تعذر تحميل عروضك.';
  }
}

async function loadOffers() {
  try {
    const data = await request('/api/offers');
    offersEl.replaceChildren();
    for (const offer of data.items) {
      const el = document.createElement('article'); el.className = 'offer';
      const h = document.createElement('h3'); h.textContent = offer.title;
      const p = document.createElement('p'); p.textContent = offer.price + ' ' + offer.asset;
      const small = document.createElement('small'); small.textContent = paymentLabels[offer.paymentMethod] || offer.paymentMethod;
      const state = document.createElement('small'); state.textContent = 'الحالة: ' + offer.status;
      el.append(h, p, small, document.createElement('br'), state);
      offersEl.append(el);
    }
    if (!data.items.length) offersEl.textContent = 'لا توجد عروض منشورة بعد.';
    statusEl.textContent = 'اتصل الموقع بالخادم. عدد العروض المفتوحة: ' + data.total;
  } catch (error) {
    statusEl.textContent = error.message || 'تعذر تحميل السوق. تأكد من نشر API وضبط عنوانه.';
  }
}
authForm.addEventListener('submit', async event => {
  event.preventDefault();
  const form = new FormData(authForm);
  const mode = document.getElementById('authMode').value;
  const body = { email: form.get('email'), password: form.get('password') };
  if (mode === 'register') body.displayName = form.get('displayName');
  const button = authForm.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const data = await request(mode === 'register' ? '/api/auth/register' : '/api/auth/login', {
      method: 'POST', body: JSON.stringify(body), headers: {},
    });
    authToken = data.token;
    accountEmail = data.user.email;
    sessionStorage.setItem('wathiq_token', authToken);
    sessionStorage.setItem('wathiq_email', accountEmail);
    setAccountStatus('تم تسجيل الدخول: ' + accountEmail);
    statusEl.textContent = 'أصبح بإمكانك إنشاء عروض مرتبطة بحسابك.';
    await loadMyOffers();
  } catch (error) {
    setAccountStatus(error.message || 'تعذر تسجيل الدخول.');
  } finally {
    button.disabled = false;
  }
});
document.getElementById('authMode').addEventListener('change', event => {
  displayName.hidden = event.target.value !== 'register';
  displayName.required = event.target.value === 'register';
});
displayName.hidden = document.getElementById('authMode').value !== 'register';
displayName.required = !displayName.hidden;
document.getElementById('refreshMyOffers').addEventListener('click', loadMyOffers);
document.getElementById('logoutWeb').addEventListener('click', () => {
  authToken = ''; accountEmail = '';
  sessionStorage.removeItem('wathiq_token'); sessionStorage.removeItem('wathiq_email');
  setAccountStatus('تم تسجيل الخروج.');
  document.getElementById('myOffers').textContent = 'سجّل الدخول لعرض عروضك.';
});
offerForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (!authToken) { statusEl.textContent = 'سجّل الدخول أولًا لإنشاء عرض.'; return; }
  const form = new FormData(offerForm);
  try {
    await request('/api/offers', {
      method: 'POST',
      body: JSON.stringify({ title: form.get('title'), asset: 'BNB', price: Number(form.get('price')), paymentMethod: form.get('paymentMethod') }),
    });
    statusEl.textContent = 'تم إنشاء العرض في الخادم.';
    offerForm.reset();
    await loadOffers();
    await loadMyOffers();
  } catch (error) {
    statusEl.textContent = error.message || 'تعذر إنشاء العرض.';
  }
});
document.getElementById('connect').addEventListener('click', () => {
  document.getElementById('onchain').scrollIntoView({ behavior: 'smooth' });
});
if (authToken && accountEmail) setAccountStatus('الجلسة الحالية: ' + accountEmail + ' — جارٍ التحقق عند أول طلب.');
else setAccountStatus('لم تسجّل الدخول.');
loadOffers();
loadMyOffers();
