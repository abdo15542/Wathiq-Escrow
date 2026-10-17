const API = window.WATHIQ_API || 'http://localhost:4000';
const paymentLabels = { bank_transfer: 'تحويل بنكي', cash: 'نقدًا خارج المنصة', crypto: 'عملة رقمية', digital_service: 'خدمة رقمية', gift_card: 'بطاقة هدايا' };
const statusEl = document.getElementById('status');
const offersEl = document.getElementById('offers');
async function loadOffers(){
  try { const r=await fetch(`${API}/api/offers`); if(!r.ok) throw new Error('API unavailable'); const data=await r.json(); offersEl.innerHTML='';
    for(const o of data.items){const el=document.createElement('article');el.className='offer';const h=document.createElement('h3');h.textContent=o.title;const p=document.createElement('p');p.textContent=`${o.price} ${o.asset}`;const small=document.createElement('small');small.textContent=paymentLabels[o.paymentMethod] || o.paymentMethod;el.append(h,p,small);offersEl.append(el);}
    if(!data.items.length) offersEl.textContent='لا توجد عروض بعد.';
  } catch { statusEl.textContent='شغّل API عبر npm run start داخل مجلد api لعرض العروض التجريبية.'; }
}
document.getElementById('offerForm').addEventListener('submit',async e=>{e.preventDefault();const f=new FormData(e.currentTarget);try{const r=await fetch(`${API}/api/offers`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:f.get('title'),asset:'BNB',price:Number(f.get('price')),paymentMethod:f.get('paymentMethod')})});const data=await r.json();if(!r.ok)throw new Error(data.error||'تعذر الحفظ');statusEl.textContent='أُضيف العرض إلى API التطوير.';e.currentTarget.reset();loadOffers();}catch(err){statusEl.textContent=`تعذر الإضافة: ${err.message}. تأكد من تشغيل API.`;}});
document.getElementById('connect').addEventListener('click',async()=>{if(!window.ethereum){statusEl.textContent='لا توجد محفظة متوافقة في هذا المتصفح. ربط المحفظة غير مفعّل في هذه النسخة.';return;}try{const a=await window.ethereum.request({method:'eth_requestAccounts'});statusEl.textContent=`تم رصد المحفظة ${a[0].slice(0,6)}…${a[0].slice(-4)}؛ لم يتم ربطها بعقد منشور.`;}catch{statusEl.textContent='أُلغِي طلب ربط المحفظة.';}});
loadOffers();