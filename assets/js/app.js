/* PixelSub — shared UI, pricing and cart logic */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const fmt2 = (n) => Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = (n) => SITE.currency + fmt2(n);
const r2 = (n) => Math.round(n * 100) / 100;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const getProduct = (slug) => PRODUCTS.find((p) => p.slug === slug);

/* ---------- Pricing ---------- */
const hasBulk = (v) => v.bulkPrice != null && v.bulkPrice < v.price;
// Logged-in reseller (null for guests). Only resellers get the 2+ price; the server enforces the same rule.
let USER = null;
// Only approved resellers get the 2+ price and a wallet; a pending/rejected applicant is a normal member
const isRes = () => !!(USER && USER.reseller);
// Where to send someone who wants the reseller price
const resellerCta = (next) => (USER ? `<a href="account.html">${USER.status === "rejected" ? "Fix your reseller application" : "Your reseller application is under review"}</a>` : `<a href="login.html?mode=join&next=${encodeURIComponent(next)}">Apply as reseller</a>`);
const unitPrice = (v, qty) => (isRes() && hasBulk(v) && qty >= SITE.bulkMinQty ? v.bulkPrice : v.price);
const minPrice = (p) => Math.min(...p.variants.map((v) => (hasBulk(v) ? v.bulkPrice : v.price)));
const totalStock = (p) => p.variants.reduce((a, v) => a + v.stock, 0);
const productHasBulk = (p) => p.variants.some(hasBulk);

/* ---------- Cart (localStorage) ---------- */
const CART_KEY = "pixelsub_cart";
const Cart = {
  get() {
    try { return JSON.parse(localStorage.getItem(CART_KEY)) || []; } catch { return []; }
  },
  save(items) {
    localStorage.setItem(CART_KEY, JSON.stringify(items));
    updateCartBadge();
  },
  add(slug, vi, qty) {
    const items = Cart.get();
    const ex = items.find((i) => i.slug === slug && i.vi === vi);
    if (ex) ex.qty += qty; else items.push({ slug, vi, qty });
    Cart.save(items);
  },
  setQty(idx, qty) {
    const items = Cart.get();
    if (qty <= 0) items.splice(idx, 1); else items[idx].qty = qty;
    Cart.save(items);
  },
  clear() { Cart.save([]); },
  lines() {
    return Cart.get()
      .map((i) => {
        const p = getProduct(i.slug);
        const v = p && p.variants[i.vi];
        if (!v) return null;
        const unit = unitPrice(v, i.qty);
        return { ...i, p, v, unit, total: r2(unit * i.qty), saved: r2((v.price - unit) * i.qty) };
      })
      .filter(Boolean);
  },
  count() { return Cart.get().reduce((a, i) => a + i.qty, 0); },
};

/* Per-provider wording for the payment form */
const PROVIDER_TEXT = {
  binance: { name: "Binance", idLabel: "Binance Order ID", idPh: "e.g. 312345678901234567", proof: true,
             how: "Open Binance → Pay → Send, enter the Pay ID and the exact USDT amount. Then paste the Order ID and upload a screenshot of the payment below — it's checked automatically." },
  bybit:   { name: "Bybit", idLabel: "Bybit Transfer ID", idPh: "Transaction ID from Bybit", fromLabel: "Your Bybit UID / email", fromPh: "UID you sent from",
             how: "Open Bybit → Assets → Transfer → Send to Bybit user (UID), coin USDT, exact amount. Then paste the transfer ID below — it's checked automatically." },
};

const copyRow = (label, shown, value) => `
  <button type="button" class="copy-row" data-copy="${esc(value)}" title="Tap to copy">
    <span><small>${esc(label)}</small><b>${esc(shown)}</b></span>
    <span class="copy-tag">${ICON.copy}<em>Copy</em></span>
  </button>`;

async function copyText(text, el) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const t = document.createElement("textarea");
    t.value = text; t.style.position = "fixed"; t.style.opacity = "0";
    document.body.appendChild(t); t.select(); document.execCommand("copy"); t.remove();
  }
  if (el) {
    el.classList.add("copied");
    $("em", el).textContent = "Copied";
    setTimeout(() => { el.classList.remove("copied"); $("em", el).textContent = "Copy"; }, 1500);
  }
}

/* Payment fields shared by checkout and "Add balance".
   allowBalance adds "Balance" as the first option (resellers paying from their wallet). */
function payFields(allowBalance) {
  const opts = (allowBalance ? [`<option value="Balance">My balance (${money(USER.balance)} available)</option>`] : [])
    .concat(SITE.payments.map((p) => `<option>${esc(p)}</option>`));
  return `
    <label>Payment method<select name="pay">${opts.join("")}</select></label>
    <div class="pay-box"></div>
    <label class="ext-field f-sender">Sender number<input name="sender" maxlength="40" placeholder="Number you paid from"></label>
    <label class="ext-field">Transaction ID<input name="trx" required maxlength="60" placeholder="e.g. 8N7A6B5C4D"></label>
    <label class="ext-field f-proof">Payment screenshot<input type="file" name="proof" accept="image/png,image/jpeg,image/webp"></label>`;
}

// Shrinks a screenshot to a JPEG of at most 1600 px so it uploads fast (phone screenshots can be several MB)
function imageToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => {
      const k = Math.min(1, 1600 / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      const g = c.getContext("2d");
      g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
      g.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("That file isn't an image we can read. Use a PNG or JPG screenshot.")); };
    img.src = url;
  });
}

// What the payment form sends to the server (pay, sender, trx and the screenshot if one is needed)
async function payBody(form) {
  const f = new FormData(form);
  const body = { pay: f.get("pay"), sender: f.get("sender"), trx: f.get("trx") };
  const file = form.proof.files[0];
  if (!form.proof.closest("label").hidden && file) body.proof = await imageToDataUrl(file);
  return body;
}

function bindPayForm(form, getAmount, onChange) {
  const box = $(".pay-box", form);
  const show = () => {
    const m = form.pay.value, total = getAmount();
    const bal = m === "Balance";
    const info = (SITE.paymentInfo || {})[m] || {};
    const noTrx = bal || info.redirect;
    const proof = !noTrx && !!(PROVIDER_TEXT[info.provider] || {}).proof;
    $$(".ext-field", form).forEach((l) => (l.hidden = noTrx));
    $(".f-sender", form).hidden = noTrx || proof;
    $(".f-proof", form).hidden = !proof;
    form.trx.required = !noTrx;
    form.proof.required = proof;
    if (bal) {
      const short = USER.balance < total;
      box.innerHTML = `<div class="pay-title">Pay from <b>balance</b></div>
        <div class="copy-row static"><span><small>Available</small><b>${money(USER.balance)}</b></span></div>
        <div class="small ${short ? "bal-short" : "muted"}">${short
          ? `Not enough balance — you need ${money(total - USER.balance)} more. <a href="account.html#add">Add balance</a>`
          : `${money(total)} will be deducted. Your payment is confirmed instantly.`}</div>`;
    } else if (info.redirect) {
      box.innerHTML = `<div class="pay-title">Pay with <b>${esc(m)}</b></div>
        ${total > 0 ? `<div class="copy-row static"><span><small>Amount</small><b>${money(total)}</b></span></div>` : ""}
        <div class="muted small">You'll be taken to a secure Cryptomus page to pay with USDT, BTC, ETH, TRX, LTC and 100+ other coins. Your payment is confirmed automatically.</div>`;
    } else {
      const t = PROVIDER_TEXT[info.provider] || { idLabel: "Transaction ID", idPh: "", fromLabel: "Sender", fromPh: "", how: "Send the exact amount, then enter the Transaction ID below." };
      const usdt = fmt2(total).replace(/,/g, "");
      box.innerHTML = `
        <div class="pay-title">Pay with <b>${esc(m)}</b></div>
        ${info.value ? copyRow(info.label, info.value, info.value) : ""}
        ${total > 0 ? copyRow("Amount", usdt + " USDT", usdt) : ""}
        <div class="muted small">${t.how}</div>`;
      form.trx.previousSibling.textContent = t.idLabel;
      form.trx.placeholder = t.idPh;
      if (t.fromLabel) {
        form.sender.previousSibling.textContent = t.fromLabel;
        form.sender.placeholder = t.fromPh;
      }
    }
    if (onChange) onChange(m);
  };
  form.pay.addEventListener("change", show);
  box.addEventListener("click", (e) => {
    const b = e.target.closest("[data-copy]");
    if (b) copyText(b.dataset.copy, b);
  });
  show();
  return show;
}

/* Orders placed from this browser (id + private token) */
const MyOrders = {
  KEY: "pixelsub_orders",
  get() {
    try { return JSON.parse(localStorage.getItem(MyOrders.KEY)) || []; } catch { return []; }
  },
  add(id, token) {
    const list = MyOrders.get().filter((o) => o.id !== id);
    list.unshift({ id, token, at: Date.now() });
    localStorage.setItem(MyOrders.KEY, JSON.stringify(list.slice(0, 50)));
  },
};

// Customer-facing label: a paid order stuck on a supplier problem reads "Waiting for admin approval"
const statusText = (o) => (o.waitingAdmin ? "Waiting for admin approval" : STATUS_LABEL[o.status]);
const STATUS_LABEL = {
  pending: "Waiting for payment check",
  processing: "Payment verified · preparing",
  delivered: "Delivered",
  cancelled: "Cancelled",
};
const fmtDate = (iso) => new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

function updateCartBadge() {
  const n = Cart.count();
  $$(".cart-count").forEach((b) => { b.textContent = n; b.hidden = n === 0; });
}

/* ---------- Icons ---------- */
const ICON = {
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  cart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3h2l2.4 12.2a2 2 0 0 0 2 1.6h8.2a2 2 0 0 0 2-1.6L21 7H6"/><circle cx="10" cy="20.5" r="1.3"/><circle cx="18" cy="20.5" r="1.3"/></svg>',
  menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 12H5M11 6l-6 6 6 6"/></svg>',
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/><path d="m9 12 2 2 4-4"/></svg>',
  box: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="M3 8l9 5 9-5M12 13v8"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  wallet: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="6" width="18" height="14" rx="2"/><path d="M3 10h18M16 15h2"/></svg>',
  tag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12V3h9l9 9-9 9z"/><circle cx="7.5" cy="7.5" r="1.5"/></svg>',
  users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.5 3.4-5.5 6.5-5.5s5.7 2 6.5 5.5M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5c1.9.6 3.1 2.4 3.5 5.5"/></svg>',
  chart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>',
  chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a8 8 0 0 1-11.8 7L4 20l1.1-4.6A8 8 0 1 1 21 12z"/></svg>',
  wa: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm0 18.2a8.2 8.2 0 0 1-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8s-.4-.1-.6.1-.7.8-.8 1-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.3-.4.3-.4.7-1.4.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.2 5.2 0 0 0 1.1 2.7 11.8 11.8 0 0 0 4.5 4c1.7.7 2.3.8 3.2.6a2.7 2.7 0 0 0 1.8-1.2 2.2 2.2 0 0 0 .1-1.3c0-.1-.2-.2-.5-.3z"/></svg>',
  tg: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M21.9 4.3 18.6 19.8c-.2 1.1-.9 1.4-1.8.9l-5-3.7-2.4 2.3c-.3.3-.5.5-1 .5l.4-5.1 9.2-8.3c.4-.4-.1-.6-.6-.2L6 13.4 1.1 11.9c-1.1-.3-1.1-1.1.2-1.6L20.5 2.9c.9-.3 1.7.2 1.4 1.4z"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>',
  minus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>',
};

const waLink = (text) => `https://wa.me/${SITE.whatsapp}${text ? "?text=" + encodeURIComponent(text) : ""}`;
const tgLink = () => `https://t.me/${SITE.telegram}`;

/* ---------- Layout ---------- */
function renderHeader() {
  const el = $("#site-header");
  if (!el) return;
  const onHome = document.body.dataset.page === "home";
  const h = (hash) => (onHome ? hash : "index.html" + hash);
  el.innerHTML = `
    <div class="container nav">
      <a class="logo" href="index.html" aria-label="${SITE.name} home">
        <img class="logo-mark" src="assets/img/logo.png" alt=""><span class="logo-text">PIXEL<b>SUB</b></span>
      </a>
      <form class="nav-search" role="search" action="index.html#products">
        ${ICON.search}<input type="search" name="q" placeholder="Search a product" autocomplete="off" aria-label="Search a product">
      </form>
      <nav class="nav-links" id="nav-links">
        <a href="${h("#products")}">Products</a>
        <a href="${h("#how-to-order")}">How to Order</a>
        <a href="${h("#faq")}">FAQ</a>
        <a href="reseller.html">Reseller</a>
        <a href="${USER ? "account.html#orders" : "order.html"}">My Orders</a>
        ${USER ? `<a href="account.html" class="nav-login-link">My Profile</a>` : `<a href="login.html" class="nav-login-link">Login / Join</a>`}
      </nav>
      ${USER
        ? `<a class="nav-user" href="account.html" title="My profile">${ICON.users}<span>${esc(USER.username)}</span>${USER.reseller ? `<b>${money(USER.balance)}</b>` : `<b class="pend">${USER.status === "rejected" ? "Not approved" : "Pending"}</b>`}</a>`
        : `<a class="btn btn-outline nav-login" href="login.html">Login</a>`}
      <a class="btn btn-primary nav-cart" href="cart.html">${ICON.cart}<span>Cart</span><span class="cart-count" hidden>0</span></a>
      <button class="nav-toggle" aria-label="Menu" aria-expanded="false">${ICON.menu}</button>
    </div>`;
  const toggle = $(".nav-toggle", el);
  toggle.addEventListener("click", () => {
    const open = el.classList.toggle("open");
    toggle.setAttribute("aria-expanded", open);
  });
  $$(".nav-links a", el).forEach((a) => a.addEventListener("click", () => el.classList.remove("open")));

  const form = $(".nav-search", el);
  const input = $("input", form);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const q = input.value.trim();
    if (onHome) { window.dispatchEvent(new CustomEvent("search", { detail: q })); $("#products").scrollIntoView({ behavior: "smooth" }); }
    else location.href = "index.html?q=" + encodeURIComponent(q) + "#products";
  });
  if (onHome) input.addEventListener("input", () => window.dispatchEvent(new CustomEvent("search", { detail: input.value.trim() })));
}

function renderFooter() {
  const el = $("#site-footer");
  if (!el) return;
  el.innerHTML = `
    <div class="container footer-grid">
      <div>
        <a class="logo" href="index.html"><img class="logo-mark" src="assets/img/logo.png" alt=""><span class="logo-text">PIXEL<b>SUB</b></span></a>
        <p class="muted">Original premium accounts at reseller-friendly prices. Buy 1 for yourself, or buy 2+ and save on every piece.</p>
      </div>
      <div>
        <h4>Shop</h4>
        <a href="index.html#products">All products</a>
        <a href="reseller.html">Become a reseller</a>
        <a href="cart.html">Cart</a>
      </div>
      <div>
        <h4>Help</h4>
        <a href="index.html#how-to-order">How to order</a>
        <a href="index.html#faq">FAQ</a>
        <a href="mailto:${SITE.email}">${SITE.email}</a>
      </div>
      <div>
        <h4>Contact</h4>
        <a href="${waLink()}" target="_blank" rel="noopener">WhatsApp</a>
        <a href="${tgLink()}" target="_blank" rel="noopener">Telegram</a>
        <span class="muted small">Open 24/7</span>
      </div>
    </div>
    <div class="container footer-bottom">
      <span>© ${new Date().getFullYear()} ${SITE.domain}. All rights reserved.</span>
      <span class="pay-mini">${SITE.payments.map((p) => `<span>${esc(p)}</span>`).join("")}</span>
    </div>`;
}

function toast(msg) {
  let t = $(".toast");
  if (!t) { t = document.createElement("div"); t.className = "toast"; document.body.appendChild(t); }
  t.innerHTML = msg;
  t.classList.add("show");
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove("show"), 2600);
}

/* Modal dialog. Resolves with the form values (object) when confirmed, or null when cancelled. */
function modal({ title, body, confirm = "Confirm", cancel = "Cancel", danger = false }) {
  return new Promise((resolve) => {
    const wrap = document.createElement("div");
    wrap.className = "modal-backdrop";
    wrap.innerHTML = `
      <form class="modal card" role="dialog" aria-modal="true">
        <h3>${title}</h3>
        <div class="modal-body">${body}</div>
        <div class="modal-actions">
          <button type="button" class="btn btn-outline" data-cancel>${cancel}</button>
          <button class="btn ${danger ? "btn-danger" : "btn-primary"}">${confirm}</button>
        </div>
      </form>`;
    document.body.appendChild(wrap);
    const form = $("form", wrap);
    const close = (val) => { wrap.remove(); document.removeEventListener("keydown", onKey); resolve(val); };
    const onKey = (e) => { if (e.key === "Escape") close(null); };
    document.addEventListener("keydown", onKey);
    $("[data-cancel]", wrap).addEventListener("click", () => close(null));
    wrap.addEventListener("click", (e) => { if (e.target === wrap) close(null); });
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const vals = {};
      $$("input[type=checkbox]", form).forEach((c) => (vals[c.name] = c.checked));
      close(vals);
    });
    $("[data-cancel]", wrap).focus();
  });
}

/* ---------- Components ---------- */
const productIcon = (p, size = "") =>
  p.image
    ? `<span class="p-icon has-img ${size}"><img src="${esc(p.image)}" alt="" loading="lazy"></span>`
    : `<span class="p-icon ${size}" style="--c:${p.color}">${esc(p.icon)}</span>`;

const priceHtml = (n) => `<span class="cur">${SITE.currency}</span>${fmt2(n)}`;

function productCard(p) {
  const stock = totalStock(p);
  const firstBulk = p.variants.find(hasBulk);
  const v = firstBulk || p.variants[0];
  const media = p.image
    ? `<img src="${esc(p.image)}" alt="${esc(p.name)}" loading="lazy">`
    : `<span class="pc-logo" style="--c:${p.color}">${esc(p.icon)}</span>`;
  return `
    <a class="product-card ${stock === 0 ? "is-out" : ""}" href="product.html?p=${p.slug}">
      <div class="pc-media" style="--c:${p.color}">
        ${p.isNew ? '<span class="pc-new">New</span>' : ""}
        ${firstBulk ? '<span class="pc-deal">2+ Deal</span>' : ""}
        ${media}
      </div>
      <div class="pc-body">
        <span class="pc-cat">${esc(p.category)}</span>
        <h3>${esc(p.name)}</h3>
        <p class="pc-desc">${esc(p.short)}</p>
        <div class="pc-meta">
          <span>${p.sold ? p.sold.toLocaleString("en-US") + " sold" : ""}</span>
          ${stock === 0 ? '<span class="pc-out">Out of stock</span>' : `<span class="pc-left">${stock} left</span>`}
        </div>
        <div class="pc-price">
          <strong>${priceHtml(v.price)}</strong>
          ${firstBulk ? `<span class="pc-bulk" title="Reseller price for 2+ pcs">Reseller 2+: <b>${priceHtml(v.bulkPrice)}</b></span>` : ""}
        </div>
      </div>
    </a>`;
}

/* ---------- Page: Home ---------- */
function initHome() {
  // Hero slider
  const slides = $$(".hero-slide");
  const dots = $(".hero-dots");
  let cur = 0, timer;
  dots.innerHTML = slides.map((_, i) => `<button aria-label="Slide ${i + 1}"></button>`).join("");
  const go = (i) => {
    cur = (i + slides.length) % slides.length;
    slides.forEach((s, j) => s.classList.toggle("active", j === cur));
    $$("button", dots).forEach((d, j) => d.classList.toggle("active", j === cur));
    clearInterval(timer); timer = setInterval(() => go(cur + 1), 6000);
  };
  $$("button", dots).forEach((d, i) => d.addEventListener("click", () => go(i)));
  $(".hero-prev").addEventListener("click", () => go(cur - 1));
  $(".hero-next").addEventListener("click", () => go(cur + 1));
  go(0);

  // Marquee
  const chips = PRODUCTS.map((p) => `<a class="chip" href="product.html?p=${p.slug}">${productIcon(p, "sm")}<b>${esc(p.name)}</b><span>${esc(p.category)}</span></a>`).join("");
  $(".marquee-track").innerHTML = chips + chips;

  // Product grid with tabs + search
  const tabs = ["Popular", ...CATEGORIES, "New"];
  let active = "Popular", query = new URLSearchParams(location.search).get("q") || "";
  const tabsEl = $(".tabs");
  tabsEl.innerHTML = tabs.map((t) => `<button class="tab" data-t="${esc(t)}">${esc(t)}</button>`).join("");
  const grid = $("#product-grid");
  const count = $("#product-count");
  const render = () => {
    $$(".tab", tabsEl).forEach((b) => b.classList.toggle("active", b.dataset.t === active));
    const q = query.toLowerCase();
    const list = PRODUCTS.filter((p) =>
      (active === "Popular" || (active === "New" && p.isNew) || p.category === active) &&
      (!q || (p.name + " " + p.category + " " + p.short).toLowerCase().includes(q))
    );
    if (active === "Popular") list.sort((a, b) => (b.sold || 0) - (a.sold || 0));
    grid.innerHTML = list.length ? list.map(productCard).join("") : `<div class="empty">No product found${q ? ` for “${esc(query)}”` : ""}.</div>`;
    count.textContent = `${list.length} product${list.length === 1 ? "" : "s"}${q ? ` matching “${query}”` : ""}`;
  };
  tabsEl.addEventListener("click", (e) => { const b = e.target.closest(".tab"); if (b) { active = b.dataset.t; render(); } });
  window.addEventListener("search", (e) => { query = e.detail; if (query) active = "Popular"; render(); });
  if (query) { const i = $(".nav-search input"); if (i) i.value = query; }
  render();

  // Payments
  $("#pay-list").innerHTML = SITE.payments.map((p) => `<span class="pay">${esc(p)}</span>`).join("");

  // FAQ
  $$(".faq-item button").forEach((b) => b.addEventListener("click", () => {
    const item = b.parentElement;
    const open = !item.classList.contains("open");
    $$(".faq-item").forEach((i) => i.classList.remove("open"));
    item.classList.toggle("open", open);
    b.setAttribute("aria-expanded", open);
  }));

  $$("[data-wa]").forEach((a) => (a.href = waLink("Hi " + SITE.name + ", I have a question.")));
  $$("[data-tg]").forEach((a) => (a.href = tgLink()));
}

/* ---------- Page: Product ---------- */
function initProduct() {
  const p = getProduct(new URLSearchParams(location.search).get("p"));
  const root = $("#product-root");
  if (!p) {
    root.innerHTML = `<div class="empty"><h2>Product not found</h2><p><a class="btn btn-primary" href="index.html#products">Back to products</a></p></div>`;
    return;
  }
  document.title = `${p.name} | ${SITE.name}`;

  const pkgs = [...new Set(p.variants.map((v) => v.pkg))];
  let pkg = pkgs[0];
  let vi = p.variants.findIndex((v) => v.pkg === pkg && v.stock > 0);
  if (vi < 0) vi = p.variants.findIndex((v) => v.pkg === pkg);
  let qty = 1;

  const related = PRODUCTS.filter((x) => x.category === p.category && x.slug !== p.slug).slice(0, 3);

  root.innerHTML = `
    <a class="back-link" href="index.html#products">${ICON.back} Back to products</a>
    <div class="pd-grid">
      <div class="pd-main">
        <div class="pd-head">
          ${productIcon(p, "lg")}
          <div>
            <span class="eyebrow">${esc(p.category)}</span>
            <h1>${esc(p.name)}</h1>
          </div>
        </div>
        <p class="pd-short">${esc(p.short)}</p>
        ${p.sold ? `<p class="muted small">${p.sold.toLocaleString("en-US")} sold</p>` : ""}

        <h5 class="label">Choose a plan</h5>
        <div class="pd-selects">
          <label>Package<select id="sel-pkg">${pkgs.map((k) => `<option>${esc(k)}</option>`).join("")}</select></label>
          <label>Duration<select id="sel-dur"></select></label>
        </div>
        <div class="pd-badges" id="pd-badges"></div>

        <div class="tier-box" id="tier-box"></div>
      </div>

      <div class="pd-terms">
        <h5 class="label">Read before you buy</h5>
        <div class="terms card">
          <h4>${ICON.shield} Product terms</h4>
          <ol>${p.terms.map((t) => `<li>${esc(t)}</li>`).join("")}</ol>
          <p class="muted small">By buying this product you agree to the terms above. Breaking them voids the warranty.</p>
        </div>
      </div>

      <aside class="pd-side">
        <div class="card order-card">
          <span class="eyebrow">Your plan</span>
          <div class="oc-title" id="oc-title"></div>
          <div class="oc-price"><strong id="oc-unit"></strong><span id="oc-unit-note"></span></div>
          <div class="oc-row">
            <span>Quantity</span>
            <div class="qty">
              <button id="q-minus" aria-label="Decrease">${ICON.minus}</button>
              <input id="q-input" type="number" min="1" value="1" aria-label="Quantity">
              <button id="q-plus" aria-label="Increase">${ICON.plus}</button>
            </div>
          </div>
          <div class="oc-hint" id="oc-hint"></div>
          <div class="oc-total"><span>Total</span><strong id="oc-total"></strong></div>
          <div class="oc-save" id="oc-save"></div>
          <button class="btn btn-primary btn-block" id="btn-add">${ICON.cart} Add to cart</button>
          <button class="btn btn-buy btn-block" id="btn-buy">${ICON.arrow} Buy now</button>
          <p class="muted small">Payments are verified automatically, 24/7. Account details are sent right after.</p>
        </div>
      </aside>
    </div>

    ${related.length ? `
    <section class="section-sm">
      <h2 class="h2-sm">More in ${esc(p.category)}</h2>
      <div class="grid">${related.map(productCard).join("")}</div>
    </section>` : ""}`;

  const selPkg = $("#sel-pkg"), selDur = $("#sel-dur"), qIn = $("#q-input");

  const fillDurations = () => {
    selDur.innerHTML = p.variants
      .map((v, i) => (v.pkg === pkg ? `<option value="${i}" ${v.stock === 0 ? "disabled" : ""}>${esc(v.duration)} · ${money(v.price)}${v.stock === 0 ? " (out)" : ""}</option>` : ""))
      .join("");
    if (p.variants[vi].pkg !== pkg) {
      vi = p.variants.findIndex((v) => v.pkg === pkg && v.stock > 0);
      if (vi < 0) vi = p.variants.findIndex((v) => v.pkg === pkg);
    }
    selDur.value = vi;
  };

  const update = () => {
    const v = p.variants[vi];
    const out = v.stock === 0;
    if (!out && qty > v.stock) qty = v.stock;
    if (qty < 1) qty = 1;
    qIn.value = qty;
    const unit = unitPrice(v, qty);
    const bulk = hasBulk(v);
    const isBulk = isRes() && bulk && qty >= SITE.bulkMinQty;

    $("#oc-title").textContent = `${v.pkg} – ${v.duration}`;
    $("#oc-unit").textContent = money(unit);
    $("#oc-unit-note").textContent = "/ piece";
    $("#oc-total").textContent = money(unit * qty);
    $("#pd-badges").innerHTML = `
      <span class="badge ${out ? "out" : ""}">${ICON.box} ${out ? "Out of stock" : v.stock + " left"}</span>
      <span class="badge">${ICON.shield} Warranty ${esc(v.warranty)}</span>
      ${v.manual ? `<span class="badge muted-badge">${ICON.clock} Delivered by admin</span>` : `<span class="badge instant">⚡ Instant delivery</span>`}`;

    $("#tier-box").innerHTML = bulk ? `
      <div class="tier ${!isBulk ? "on" : ""}"><small>Buy 1</small><strong>${money(v.price)}</strong><span>per piece</span></div>
      <div class="tier ${isBulk ? "on" : ""}"><small>Buy ${SITE.bulkMinQty}+ (reseller)</small><strong>${money(v.bulkPrice)}</strong><span>${isRes()
        ? `per piece · save ${money(v.price - v.bulkPrice)} each`
        : `approved resellers only · ${resellerCta(location.pathname + location.search)}`}</span></div>`
      : `<div class="tier on single"><small>Flat price</small><strong>${money(v.price)}</strong><span>same price for any quantity</span></div>`;

    $("#oc-hint").innerHTML = !bulk ? ""
      : !isRes() ? `${ICON.tag} <span>${resellerCta(location.pathname + location.search)} — approved resellers pay <b>${money(v.bulkPrice)}</b> each for ${SITE.bulkMinQty}+ pcs</span>`
      : !isBulk ? `${ICON.tag} Add 1 more and pay <b>${money(v.bulkPrice)}</b> per piece`
      : `${ICON.tag} Reseller price applied`;
    $("#oc-hint").className = "oc-hint" + (isBulk ? " ok" : "");
    $("#oc-save").innerHTML = isBulk ? `You save <b>${money((v.price - v.bulkPrice) * qty)}</b>` : "";

    $("#btn-add").disabled = out;
    $("#btn-buy").disabled = out;
    $("#q-plus").disabled = out || qty >= v.stock;
    $("#q-minus").disabled = qty <= 1;
  };

  selPkg.addEventListener("change", () => { pkg = selPkg.value; fillDurations(); update(); });
  selDur.addEventListener("change", () => { vi = +selDur.value; update(); });
  $("#q-minus").addEventListener("click", () => { qty--; update(); });
  $("#q-plus").addEventListener("click", () => { qty++; update(); });
  qIn.addEventListener("change", () => { qty = parseInt(qIn.value, 10) || 1; update(); });
  $("#btn-add").addEventListener("click", () => {
    Cart.add(p.slug, vi, qty);
    toast(`Added ${qty} × ${esc(p.name)} to cart · <a href="cart.html">View cart</a>`);
  });
  $("#btn-buy").addEventListener("click", () => {
    Cart.add(p.slug, vi, qty);
    location.href = "cart.html";
  });

  fillDurations();
  update();
}

/* ---------- Page: Cart ---------- */
function initCart() {
  const root = $("#cart-root");
  const render = () => {
    const lines = Cart.lines();
    if (!lines.length) {
      root.innerHTML = `<div class="empty card"><h2>Your cart is empty</h2><p class="muted">Order as a guest, or log in as a reseller to get the 2+ price.</p><a class="btn btn-primary" href="index.html#products">Browse products</a></div>`;
      return;
    }
    const subtotal = lines.reduce((a, l) => a + l.total, 0);
    const saved = lines.reduce((a, l) => a + l.saved, 0);
    // What a guest would save by joining as a reseller
    const couldSave = isRes() ? 0 : lines.reduce((a, l) => a + (hasBulk(l.v) && l.qty >= SITE.bulkMinQty ? (l.v.price - l.v.bulkPrice) * l.qty : 0), 0);
    const next = encodeURIComponent("cart.html");
    root.innerHTML = `
      <div class="cart-grid">
        <div class="card cart-list">
          ${lines.map((l, i) => `
            <div class="cart-line">
              ${productIcon(l.p)}
              <div class="cl-info">
                <a href="product.html?p=${l.p.slug}"><b>${esc(l.p.name)}</b></a>
                <span class="muted small">${esc(l.v.pkg)} – ${esc(l.v.duration)}</span>
                <span class="small">${money(l.unit)} / piece
                  ${l.saved ? `<span class="tag tag-bulk">Reseller price</span>`
                    : hasBulk(l.v) && !isRes() ? `<span class="muted"> · reseller 2+: ${money(l.v.bulkPrice)}</span>`
                    : hasBulk(l.v) ? `<span class="muted"> · add 1 more for ${money(l.v.bulkPrice)}</span>` : ""}
                </span>
              </div>
              <div class="qty">
                <button data-a="minus" data-i="${i}" aria-label="Decrease">${ICON.minus}</button>
                <input value="${l.qty}" data-i="${i}" type="number" min="1" aria-label="Quantity">
                <button data-a="plus" data-i="${i}" aria-label="Increase" ${l.qty >= l.v.stock ? "disabled" : ""}>${ICON.plus}</button>
              </div>
              <strong class="cl-total">${money(l.total)}</strong>
              <button class="icon-btn" data-a="del" data-i="${i}" aria-label="Remove">${ICON.trash}</button>
            </div>`).join("")}
        </div>
        <aside class="card checkout">
          <h3>Order summary</h3>
          <div class="sum-row"><span>Regular price</span><span>${money(subtotal + saved)}</span></div>
          ${saved ? `<div class="sum-row save"><span>Reseller discount</span><span>− ${money(saved)}</span></div>` : ""}
          <div class="sum-row total"><span>Total</span><strong>${money(subtotal)}</strong></div>
          ${isRes()
            ? `<div class="acct-note ok">${ICON.users}<span>Ordering as reseller <b>${esc(USER.username)}</b></span></div>`
            : `<div class="acct-note">${ICON.tag}<span>Ordering as ${USER ? `member <b>${esc(USER.username)}</b>` : "guest"}.${couldSave ? ` Resellers save <b>${money(couldSave)}</b> on this order —` : ""} ${resellerCta("cart.html")} for 2+ prices.</span></div>`}
          <form id="checkout-form">
            ${payFields(isRes())}
            <div class="form-error" id="form-error" hidden></div>
            <button class="btn btn-primary btn-block" type="submit" id="place-btn">Place order · ${money(subtotal)}</button>
          </form>
          <p class="muted small">Your payment is verified automatically, 24/7. Your account details will appear on your order page.</p>
        </aside>
      </div>`;

    $$("[data-a]", root).forEach((b) => b.addEventListener("click", () => {
      const i = +b.dataset.i, items = Cart.get();
      if (b.dataset.a === "del") Cart.setQty(i, 0);
      if (b.dataset.a === "minus") Cart.setQty(i, items[i].qty - 1);
      if (b.dataset.a === "plus") Cart.setQty(i, items[i].qty + 1);
      render();
    }));
    $$(".qty input", root).forEach((inp) => inp.addEventListener("change", () => {
      const i = +inp.dataset.i, l = lines[i];
      Cart.setQty(i, Math.max(1, Math.min(l.v.stock || 1, parseInt(inp.value, 10) || 1)));
      render();
    }));
    const form = $("#checkout-form");
    bindPayForm(form, () => subtotal, (m) => {
      const btn = $("#place-btn");
      const short = m === "Balance" && USER.balance < subtotal;
      btn.disabled = short;
      btn.textContent = m === "Balance" ? `Pay ${money(subtotal)} from balance`
        : ((SITE.paymentInfo || {})[m] || {}).redirect ? `Continue to ${m} · ${money(subtotal)}`
        : `Place order · ${money(subtotal)}`;
    });

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = $("#place-btn"), err = $("#form-error");
      btn.disabled = true; btn.textContent = "Placing order…"; err.hidden = true;
      try {
        const r = await fetch("/api/orders", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ items: Cart.get(), ...(await payBody(form)) }),
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.error || "Could not place the order. Please try again.");
        MyOrders.add(data.id, data.token);
        Cart.clear();
        location.href = data.payUrl || `order.html?id=${encodeURIComponent(data.id)}&t=${encodeURIComponent(data.token)}`;
      } catch (ex) {
        err.textContent = ex.message; err.hidden = false;
        btn.disabled = false; btn.textContent = `Place order · ${money(subtotal)}`;
      }
    });
  };
  render();
}

/* ---------- Page: Reseller ---------- */
function initReseller() {
  const ex = PRODUCTS.filter((p) => productHasBulk(p)).slice(0, 6);
  $("#price-table").innerHTML = `
    <thead><tr><th>Product</th><th>Plan</th><th>1 pc</th><th>2+ pcs (each)</th><th>You save</th></tr></thead>
    <tbody>${ex.map((p) => { const v = p.variants.find(hasBulk); return `
      <tr><td><a href="product.html?p=${p.slug}">${productIcon(p, "sm")} ${esc(p.name)}</a></td>
      <td class="muted">${esc(v.pkg)} – ${esc(v.duration)}</td>
      <td>${money(v.price)}</td><td class="hl">${money(v.bulkPrice)}</td>
      <td class="save">${Math.round((1 - v.bulkPrice / v.price) * 100)}%</td></tr>`; }).join("")}</tbody>`;
}

/* ---------- Page: Order status / My orders ---------- */
function orderItemsHtml(o) {
  const m = money;
  return `
    ${o.items.map((i) => {
      const p = getProduct(i.slug);
      return `<div class="cart-line order-line">
        ${p ? productIcon(p) : ""}
        <div class="cl-info"><b>${esc(i.name)}</b><span class="muted small">${esc(i.plan)} · ${i.qty} × ${m(i.unit)}</span></div>
        <strong class="cl-total">${m(i.total)}</strong>
      </div>`;
    }).join("")}
    ${o.discount ? `<div class="sum-row save"><span>Reseller discount</span><span>− ${m(o.discount)}</span></div>` : ""}
    <div class="sum-row total"><span>Total</span><strong>${m(o.total)}</strong></div>`;
}

async function initOrder() {
  const root = $("#order-root");
  const qs = new URLSearchParams(location.search);
  const id = qs.get("id"), token = qs.get("t");

  if (!id) {
    // Reseller: orders saved on the account. Guest: orders placed from this browser.
    let rows = [];
    if (USER) {
      const r = await fetch("/api/my/orders");
      if (r.ok) rows = await r.json();
    }
    const local = MyOrders.get().filter((x) => !rows.some((o) => o.id === x.id));
    rows = rows.concat((await Promise.all(local.map(async (x) => {
      try {
        const r = await fetch(`/api/orders/${encodeURIComponent(x.id)}?t=${encodeURIComponent(x.token)}`);
        return r.ok ? { ...(await r.json()), token: x.token } : null;
      } catch { return null; }
    }))).filter(Boolean));
    rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (USER) $(".page-title").innerHTML = `My orders <span class="muted small">· ${esc(USER.username)}</span>`;
    if (!rows.length) {
      root.innerHTML = `<div class="empty card"><h2>No orders yet</h2><p class="muted">${USER ? "Orders you place with your reseller account show up here." : "Orders you place from this browser show up here. <a href=\"login.html\">Login</a> to see your reseller orders."}</p><a class="btn btn-primary" href="index.html#products">Browse products</a></div>`;
      return;
    }
    root.innerHTML = `<div class="card cart-list" id="my-orders"></div>`;
    $("#my-orders").innerHTML = rows.map((o) => `
      <a class="cart-line my-order" href="order.html?id=${encodeURIComponent(o.id)}&t=${encodeURIComponent(o.token)}">
        <div class="cl-info"><b>${esc(o.id)}</b><span class="muted small">${fmtDate(o.createdAt)} · ${o.items.map((i) => esc(i.name) + " ×" + i.qty).join(", ")}</span></div>
        <span class="status ${o.waitingAdmin ? "s-pending" : "s-" + o.status}">${statusText(o)}</span>
        <strong class="cl-total">${money(o.total)}</strong>
      </a>`).join("") || `<p class="muted" style="padding:20px 0">Could not load your orders.</p>`;
    return;
  }

  try {
    const r = await fetch(`/api/orders/${encodeURIComponent(id)}?t=${encodeURIComponent(token || "")}`);
    if (!r.ok) throw new Error();
    const o = await r.json();
    if (token) MyOrders.add(o.id, token);
    $(".page-title").textContent = "Order " + o.id;
    root.innerHTML = `
      <div class="cart-grid">
        <div class="order-main">
          <div class="card order-status">
            <div class="order-id-row">
              ${copyRow("Your order ID", o.id, o.id)}
              <span class="status ${o.waitingAdmin ? "s-pending" : "s-" + o.status}">${statusText(o)}</span>
            </div>
            <p class="muted small">Placed ${fmtDate(o.createdAt)} · Share this order ID with support if you need help.</p>
            ${o.status === "pending" && o.payment.provider === "cryptomus" ? `
              <p>Waiting for your payment of <b>${money(o.total)}</b> on Cryptomus.</p>
              <p class="verify-note">${esc(o.payment.verifyNote || "")}</p>
              <div class="hero-actions">
                ${o.payment.payUrl ? `<a class="btn btn-primary" href="${esc(o.payment.payUrl)}">Pay now on Cryptomus</a>` : ""}
                <button class="btn btn-outline" id="verify-btn">I've paid — check now</button>
              </div>` : ""}
            ${o.status === "pending" && o.payment.auto && o.payment.provider !== "cryptomus" ? `
              <p>We couldn't confirm your ${esc(o.payment.method)} payment yet.</p>
              <p class="verify-note">${esc(o.payment.verifyNote || "")}</p>
              <p class="muted small">Make sure you sent <b>${esc(o.payment.amountUsdt)} USDT</b> and entered the correct transaction ID (<b>${esc(o.payment.trx)}</b>).</p>
              <button class="btn btn-primary" id="verify-btn">Check payment again</button>` : ""}
            ${o.status === "pending" && !o.payment.auto ? `<p>Thanks! We received your order. The admin will check your payment (${esc(o.payment.method)}, TrxID <b>${esc(o.payment.trx)}</b>) as soon as possible. Bookmark this page — your account details will appear here.</p>` : ""}
            ${o.status === "delivered" ? `<p>✅ Your order is complete. Your account details are below.</p>` : ""}
            ${o.waitingAdmin ? `<p>✅ Your payment is confirmed.</p>
              <p><b>⏳ Waiting for admin approval.</b> Your order will be delivered here as soon as it is approved — you don't need to do anything. Keep this page or your order link.</p>` : ""}
            ${o.status === "processing" && !o.waitingAdmin ? `<p>${o.payment.method === "Balance" ? "✅ Paid from your balance. " : o.payment.verified ? `✅ Payment confirmed automatically via ${esc(o.payment.method)}. ` : "Your payment is verified. "}Your account is being prepared and will appear here shortly.</p>` : ""}
            ${o.status === "cancelled" ? (o.expired
              ? `<p>⌛ This order expired because the payment was not confirmed within 20 minutes. If you already paid, contact us on <a href="${waLink(`Order ${o.id} expired but I paid`)}" target="_blank" rel="noopener">WhatsApp</a> with your order ID.</p>`
              : o.cancelReason === "Cancelled by the customer." ? `<p>You cancelled this order.</p>`
              : `<p>This order was cancelled. Contact us at <a href="mailto:${SITE.email}">${SITE.email}</a> if you think this is a mistake.</p>`) : ""}
            ${o.expiresAt ? `
              <p class="muted small expire-line">${ICON.clock} Pay within <b id="expire-left">20:00</b> — unpaid orders are cancelled automatically.</p>
              <button class="btn btn-cancel" id="cancel-btn">Cancel order</button>` : ""}
          </div>
          ${!o.customer.username && o.status !== "delivered" ? `<div class="card save-link"><p class="small"><b>Ordered as guest:</b> save this link — it's the only way to see your account details.</p>${copyRow("Your order link", location.href, location.href)}</div>` : ""}
          ${o.delivery ? `<div class="card delivery"><h3>${ICON.box} Your account details</h3><pre>${esc(o.delivery)}</pre>
            ${copyRow("Copy all details", "Tap to copy everything above", o.delivery)}
            ${o.autoDelivered ? `<p class="muted small">⚡ Delivered automatically right after your payment was confirmed.</p>` : ""}</div>` : ""}
          <div class="card cart-list">${orderItemsHtml(o)}</div>
        </div>
        <aside class="card checkout">
          <h3>Details</h3>
          <div class="sum-row"><span>Account</span><span>${o.customer.username ? "Reseller · " + esc(o.customer.username) : "Guest"}</span></div>
          <div class="sum-row"><span>Payment</span><span>${esc(o.payment.method)}</span></div>
          ${o.payment.auto ? `<div class="sum-row"><span>Amount</span><span>${esc(o.payment.amountUsdt)} USDT</span></div>` : ""}
          ${o.payment.sender ? `<div class="sum-row"><span>Sender</span><span>${esc(o.payment.sender)}</span></div>` : ""}
          ${o.payment.trx ? `<div class="sum-row"><span>Transaction ID</span><span>${esc(o.payment.trx)}</span></div>` : ""}
          ${o.payment.proof ? `<div class="sum-row"><span>Screenshot</span><span>Uploaded</span></div>` : ""}
          ${o.refunded ? `<div class="sum-row"><span>Refund</span><span>Returned to balance</span></div>` : ""}
          <div class="sum-row"><span>Paid</span><span>${o.payment.verified || o.status === "processing" || o.status === "delivered" ? '<span class="status s-delivered">Confirmed</span>' : '<span class="status s-pending">Not confirmed</span>'}</span></div>
          <button class="btn btn-outline btn-block" id="refresh-btn" style="margin-top:14px">Refresh status</button>
        </aside>
      </div>`;
    $("#refresh-btn").addEventListener("click", () => location.reload());
    $$("[data-copy]", root).forEach((b) => b.addEventListener("click", () => copyText(b.dataset.copy, b)));
    const vb = $("#verify-btn");
    if (vb) vb.addEventListener("click", async () => {
      vb.disabled = true; vb.textContent = "Checking…";
      const r = await fetch(`/api/orders/${encodeURIComponent(o.id)}/verify?t=${encodeURIComponent(token)}`, { method: "POST" });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.payment && d.payment.verified) return location.reload();
      $(".verify-note").textContent = (r.ok ? d.payment && d.payment.verifyNote : d.error) || "Not found yet.";
      vb.disabled = false; vb.textContent = o.payment.provider === "cryptomus" ? "I've paid — check now" : "Check payment again";
    });
    const cb = $("#cancel-btn");
    if (cb) cb.addEventListener("click", async () => {
      if (!confirm("Cancel this order? Only do this if you have not paid.")) return;
      cb.disabled = true; cb.textContent = "Cancelling…";
      const r = await fetch(`/api/orders/${encodeURIComponent(o.id)}/cancel?t=${encodeURIComponent(token)}`, { method: "POST" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok && d.error) alert(d.error);
      location.reload();
    });
    // Countdown to the 20-minute expiry; reload when it runs out so the server can close the order
    const left = $("#expire-left");
    if (left) {
      const end = Date.parse(o.expiresAt);
      const tick = () => {
        const s = Math.max(0, Math.round((end - Date.now()) / 1000));
        left.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
        if (s === 0) { clearInterval(timer); setTimeout(() => location.reload(), 1500); }
      };
      const timer = setInterval(tick, 1000);
      tick();
    }
    // Coming back from the Cryptomus page: check once automatically
    if (vb && o.payment.provider === "cryptomus" && document.referrer && !document.referrer.startsWith(location.origin)) vb.click();
  } catch {
    root.innerHTML = `<div class="empty card"><h2>Order not found</h2><p class="muted">Check the link, or open it from “My Orders” on the browser you ordered from.</p></div>`;
  }
}

/* ---------- Page: Admin ---------- */
function initAdmin() {
  const outer = $("#admin-root");
  let root = outer; // becomes the main content area once logged in
  const KEY = "pixelsub_admin_key";
  let filter = "all";
  let orderQuery = ""; // search box on the Orders page
  let pendingApps = 0; // reseller applications waiting for approval (sidebar badge)
  let userTab = "pending";
  const aoWarn = {};   // per-order "couldn't deliver" messages from the last save
  const normId = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

  const login = (msg = "") => {
    root = outer;
    outer.innerHTML = `
      <form class="card admin-login" id="admin-login">
        <div class="logo"><img class="logo-mark" src="assets/img/logo.png" alt=""><span class="logo-text">PIXEL<b>SUB</b> <small class="muted">Admin</small></span></div>
        <label>Admin key<input type="password" name="key" required autocomplete="current-password"></label>
        ${msg ? `<div class="form-error">${esc(msg)}</div>` : ""}
        <button class="btn btn-primary btn-block">Log in</button>
      </form>`;
    $("#admin-login").addEventListener("submit", (e) => {
      e.preventDefault();
      sessionStorage.setItem(KEY, e.target.key.value);
      load();
    });
  };

  const api = (path, opts = {}) =>
    fetch(path, { ...opts, headers: { "Content-Type": "application/json", "x-admin-key": sessionStorage.getItem(KEY) || "" } });
  // Payment screenshots are private: fetch with the admin key, then open the image in a new tab
  outer.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-proof]");
    if (!b) return;
    const win = window.open("", "_blank");
    const r = await api(`/api/admin/proofs/${encodeURIComponent(b.dataset.proof)}`);
    if (!r.ok) { if (win) win.close(); return alert("Screenshot not found."); }
    const url = URL.createObjectURL(await r.blob());
    if (win) win.location.href = url; else location.href = url;
  });

  const SECTIONS = [
    ["dashboard", "Dashboard", ICON.chart], ["orders", "Orders", ICON.box], ["products", "Products", ICON.tag],
    ["stock", "Stock", ICON.box], ["supplier", "Supplier", ICON.arrow], ["topups", "Balance requests", ICON.wallet], ["users", "Resellers", ICON.users], ["settings", "Settings", ICON.shield],
  ];
  let section = (location.hash.slice(1) && SECTIONS.some(([k]) => k === location.hash.slice(1))) ? location.hash.slice(1) : "dashboard";

  // Sidebar layout, built once after login
  const shell = () => {
    if ($("#admin-main")) return;
    outer.innerHTML = `
      <div class="admin-layout">
        <aside class="admin-side">
          <a class="logo" href="index.html" target="_blank" rel="noopener"><img class="logo-mark" src="assets/img/logo.png" alt=""><span class="logo-text">PIXEL<b>SUB</b></span></a>
          <nav>${SECTIONS.map(([k, l, ic]) => `<button data-sec="${k}">${ic}<span>${l}</span><em class="badge-n" data-badge="${k}" hidden></em></button>`).join("")}</nav>
          <div class="admin-side-foot">
            <a class="btn btn-outline btn-block" href="index.html" target="_blank" rel="noopener">View site</a>
            <button class="btn btn-outline btn-block" id="logout">Log out</button>
          </div>
        </aside>
        <div class="admin-main" id="admin-main"></div>
      </div>`;
    $$("[data-sec]", outer).forEach((b) => b.addEventListener("click", () => { section = b.dataset.sec; history.replaceState(null, "", "#" + section); load(); }));
    $("#logout").addEventListener("click", () => { sessionStorage.removeItem(KEY); login(); });
  };

  // Page header for the current section (also highlights the menu and updates the badge)
  const sectionBar = (pendingTopups) => {
    $$("[data-sec]", outer).forEach((b) => b.classList.toggle("active", b.dataset.sec === section));
    const badge = $('[data-badge="topups"]', outer);
    if (badge) { badge.textContent = pendingTopups || ""; badge.hidden = !pendingTopups; }
    const ub = $('[data-badge="users"]', outer);
    if (ub) { ub.textContent = pendingApps || ""; ub.hidden = !pendingApps; }
    const title = (SECTIONS.find(([k]) => k === section) || [])[1] || "";
    return `<div class="admin-head"><h1>${title}</h1><button class="btn btn-outline" id="reload">Reload</button></div>`;
  };
  const bindBar = () => { const r = $("#reload", root); if (r) r.addEventListener("click", load); };

  const loadTopupsView = async (topups) => {
    root.innerHTML = sectionBar(topups.filter((t) => t.status === "pending").length) + (topups.length ? `
      <div class="card table-wrap"><table>
        <thead><tr><th>Date</th><th>Reseller</th><th>Amount</th><th>Payment</th><th>Status</th><th></th></tr></thead>
        <tbody>${topups.map((t) => `<tr data-id="${esc(t.id)}">
          <td class="muted">${fmtDate(t.createdAt)}</td>
          <td><b>${esc(t.username)}</b></td>
          <td><b>${money(t.amount)}</b>${t.payment.auto ? `<br><span class="muted small">${esc(t.payment.amountUsdt)} USDT</span>` : ""}</td>
          <td>${esc(t.payment.method)}<br><span class="muted small">TrxID ${esc(t.payment.trx)}${t.payment.sender ? " · from " + esc(t.payment.sender) : ""}</span>${t.payment.proof ? `<br><button type="button" class="link-btn" data-proof="${esc(t.payment.proof)}">View screenshot</button>` : ""}
            ${t.payment.verifyNote ? `<br><span class="muted small">${esc(t.payment.verifyNote)}</span>` : ""}</td>
          <td><span class="status ${t.status === "completed" ? "s-delivered" : t.status === "rejected" ? "s-cancelled" : "s-pending"}">${t.status}</span>${t.completedBy ? `<br><span class="muted small">by ${esc(t.completedBy)}</span>` : ""}</td>
          <td class="tu-actions">${t.status === "pending" ? `
            ${t.payment.auto ? `<button class="btn btn-outline" data-act="verify">Check payment</button>` : ""}
            <button class="btn btn-primary" data-act="approve">Approve</button>
            <button class="btn btn-outline" data-act="reject">Reject</button>` : ""}</td>
        </tr>`).join("")}</tbody></table></div>` : `<div class="empty card">No balance requests yet.</div>`);
    bindBar();
    $$("[data-act]", root).forEach((b) => b.addEventListener("click", async () => {
      const id = b.closest("tr").dataset.id, action = b.dataset.act;
      let note = "";
      if (action === "approve" && !confirm("Add this amount to the reseller's balance?")) return;
      if (action === "reject") { note = prompt("Reason (shown to the reseller):", "Payment not received"); if (note === null) return; }
      b.disabled = true;
      const r = await api(`/api/admin/topups/${encodeURIComponent(id)}`, { method: "POST", body: JSON.stringify({ action, note }) });
      const d = await r.json().catch(() => ({}));
      toast(r.ok ? (d.status === "completed" ? `Added ${money(d.amount)} to ${esc(d.username)}` : esc(d.payment && d.payment.verifyNote || "Updated")) : esc(d.error || "Failed"));
      load();
    }));
  };

  let stockOpen = "";
  const loadStockView = async (pendingTopups) => {
    const { plans, waiting } = await (await api("/api/admin/stock")).json();
    const auto = plans.filter((p) => !p.manual);
    root.innerHTML = sectionBar(pendingTopups) + `
      <div class="stock-grid">
        <form class="card acc-form" id="stock-form">
          <h3>Add stock</h3>
          <label>Product & plan<select name="key">${auto.map((p) => `<option value="${esc(p.key)}" ${p.key === stockOpen ? "selected" : ""}>${esc(p.product)} · ${esc(p.plan)} (${p.items.length})</option>`).join("")}</select></label>
          <label>Accounts — one per line<textarea name="items" rows="8" placeholder="email1@mail.com:password1&#10;email2@mail.com:password2 | Profile 2 | PIN 1234"></textarea></label>
          <button class="btn btn-primary btn-block">Add to stock</button>
          <p class="muted small">Each line is delivered as one piece. Paid orders get their accounts automatically; orders that were waiting for stock are delivered as soon as you add it.</p>
          ${waiting ? `<button type="button" class="btn btn-outline btn-block" id="deliver-now">Deliver waiting orders now (${waiting} paid, not delivered)</button>` : ""}
        </form>
        <div class="card table-wrap">
          <table>
            <thead><tr><th>Product</th><th>Plan</th><th>Delivery</th><th>In stock</th></tr></thead>
            <tbody>${plans.map((p) => `
              <tr class="${p.manual ? "muted" : "stock-row"}" data-key="${esc(p.key)}">
                <td><b>${esc(p.product)}</b></td><td>${esc(p.plan)}</td>
                <td>${p.supplier ? '<span class="status s-processing">🔗 TokoPremium</span>' : p.manual ? "Manual" : '<span class="status s-delivered">⚡ Auto</span>'}</td>
                <td>${p.manual ? "—" : `<b class="${p.items.length ? "" : "bal-short"}">${p.items.length}</b> ${p.items.length ? `<button class="link-btn" data-view>${stockOpen === p.key ? "Hide" : "View"}</button>` : ""}`}</td>
              </tr>
              ${!p.manual && stockOpen === p.key ? `<tr><td colspan="4"><div class="stock-items">${p.items.map((x) => `
                <div class="stock-item"><code>${esc(x.data)}</code><span class="muted small">${fmtDate(x.addedAt)}</span><button class="icon-btn" data-del="${esc(x.id)}" aria-label="Remove">${ICON.trash}</button></div>`).join("")}</div></td></tr>` : ""}`).join("")}
            </tbody>
          </table>
        </div>
      </div>`;
    bindBar();
    $("#stock-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      stockOpen = f.get("key");
      const r = await api("/api/admin/stock", { method: "POST", body: JSON.stringify({ key: f.get("key"), items: f.get("items") }) });
      const d = await r.json().catch(() => ({}));
      toast(r.ok ? `Added ${d.added}${d.skipped ? ` (${d.skipped} duplicate skipped)` : ""} · ${d.inStock} in stock${d.deliveredOrders ? ` · delivered ${d.deliveredOrders} waiting order(s)` : ""}` : esc(d.error || "Failed"));
      load();
    });
    const dn = $("#deliver-now");
    if (dn) dn.addEventListener("click", async () => {
      const d = await (await api("/api/admin/deliver", { method: "POST" })).json();
      toast(d.deliveredOrders ? `Delivered ${d.deliveredOrders} order(s)` : "Nothing to deliver — add stock for those plans first");
      load();
    });
    $$("[data-view]", root).forEach((b) => b.addEventListener("click", () => {
      const k = b.closest("tr").dataset.key;
      stockOpen = stockOpen === k ? "" : k;
      load();
    }));
    $$("[data-del]", root).forEach((b) => b.addEventListener("click", async () => {
      if (!confirm("Remove this account from stock?")) return;
      await api("/api/admin/stock/remove", { method: "POST", body: JSON.stringify({ key: stockOpen, id: b.dataset.del }) });
      load();
    }));
  };

  const TYPE_LABEL = { website: "Website / online store", bot: "Telegram / WhatsApp bot", other: "Facebook page / group / other" };
  const loadUsersView = async (users, pendingTopups) => {
    const groups = {
      pending: users.filter((u) => u.status === "pending"),
      approved: users.filter((u) => u.status === "approved"),
      rejected: users.filter((u) => u.status === "rejected"),
    };
    const list = groups[userTab] || [];
    const tabs = [["pending", "Pending"], ["approved", "Approved"], ["rejected", "Rejected"]];
    const link = (a) => (/^https?:\/\//i.test(a.link) ? `<a href="${esc(a.link)}" target="_blank" rel="noopener nofollow">${esc(a.link)}</a>` : esc(a.link));
    const appCell = (u) => u.application ? `<b>${esc(TYPE_LABEL[u.application.type] || u.application.type)}</b><br>${link(u.application)}${u.application.contact ? `<br><span class="muted small">Contact: ${esc(u.application.contact)}</span>` : ""}${u.application.note ? `<br><span class="muted small">${esc(u.application.note)}</span>` : ""}` : '<span class="muted small">— (older account)</span>';
    root.innerHTML = sectionBar(pendingTopups) + `
      <div class="tabs admin-tabs" style="margin-bottom:14px">${tabs.map(([k, l]) => `<button class="tab ${userTab === k ? "active" : ""}" data-ut="${k}">${l} (${groups[k].length})</button>`).join("")}</div>
      ${list.length ? `<div class="card table-wrap"><table>
        <thead><tr><th>Account</th><th>Where they sell</th><th>Applied</th><th>Orders</th><th>Balance</th><th></th></tr></thead>
        <tbody>${list.map((u) => `<tr data-u="${esc(u.username)}">
          <td><b>${esc(u.username)}</b><br><span class="muted small">joined ${fmtDate(u.createdAt)}</span></td>
          <td>${appCell(u)}${u.application && u.application.rejectNote ? `<br><span class="bal-short small">Rejected: ${esc(u.application.rejectNote)}</span>` : ""}</td>
          <td class="muted">${u.application ? fmtDate(u.application.submittedAt) : "—"}</td>
          <td>${u.orders}</td><td><b class="amt-plus">${money(u.balance)}</b></td>
          <td class="tu-actions">
            ${u.status !== "approved" ? '<button class="btn btn-primary" data-rv="approve">Approve</button>' : ""}
            ${u.status !== "rejected" ? `<button class="btn btn-outline" data-rv="reject">${u.status === "approved" ? "Revoke" : "Reject"}</button>` : ""}
            ${u.status === "approved" ? `<div class="adj"><input type="number" step="0.01" placeholder="+5 or -2"><input type="text" placeholder="Note"><button class="btn btn-outline" data-adj>Balance</button></div>` : ""}
          </td>
        </tr>`).join("")}</tbody></table></div>` : `<div class="empty card">${userTab === "pending" ? "No applications waiting." : `No ${userTab} resellers.`}</div>`}`;
    bindBar();
    $$("[data-ut]", root).forEach((b) => b.addEventListener("click", () => { userTab = b.dataset.ut; load(); }));
    $$("[data-rv]", root).forEach((b) => b.addEventListener("click", async () => {
      const u = b.closest("tr").dataset.u, action = b.dataset.rv;
      let note = "";
      if (action === "approve" && !confirm(`Approve ${u} as a reseller?`)) return;
      if (action === "reject") { note = prompt(`Reason shown to ${u}:`, "Please send a working website or bot link"); if (note === null) return; }
      const r = await api(`/api/admin/users/${encodeURIComponent(u)}/review`, { method: "POST", body: JSON.stringify({ action, note }) });
      const d = await r.json().catch(() => ({}));
      toast(r.ok ? (action === "approve" ? `${esc(u)} is now a reseller` : `${esc(u)} ${userTab === "approved" ? "revoked" : "rejected"}`) : esc(d.error || "Failed"));
      load();
    }));
    $$("[data-adj]", root).forEach((b) => b.addEventListener("click", async () => {
      const tr = b.closest("tr"), [amt, note] = $$("input", tr);
      if (!amt.value || !confirm(`Change ${tr.dataset.u}'s balance by ${amt.value}?`)) return;
      const r = await api(`/api/admin/users/${encodeURIComponent(tr.dataset.u)}/adjust`, { method: "POST", body: JSON.stringify({ amount: Number(amt.value), note: note.value }) });
      const d = await r.json().catch(() => ({}));
      toast(r.ok ? `New balance: ${money(d.balance)}` : esc(d.error || "Failed"));
      load();
    }));
  };
  const load = async () => {
    const tr = await api("/api/admin/topups");
    if (tr.status === 401) { sessionStorage.removeItem(KEY); return login("Wrong admin key."); }
    const topups = await tr.json();
    const pendingTopups = topups.filter((t) => t.status === "pending").length;
    const allUsers = await (await api("/api/admin/users")).json().catch(() => []);
    pendingApps = allUsers.filter((u) => u.status === "pending").length;
    shell();
    root = $("#admin-main");
    // Dashboard, Products and Settings live in admin.js
    const extra = (window.ADMIN_EXTRA || {})[section];
    if (extra) {
      root.innerHTML = sectionBar(pendingTopups) + `<div id="admin-view"><p class="muted">Loading…</p></div>`;
      bindBar();
      return extra({ el: $("#admin-view", root), api, reload: load });
    }
    if (section === "topups") return loadTopupsView(topups);
    if (section === "stock") return loadStockView(pendingTopups);
    if (section === "users") return loadUsersView(allUsers, pendingTopups);
    const r = await api("/api/admin/orders");
    const orders = await r.json();
    const counts = orders.reduce((a, o) => ((a[o.status] = (a[o.status] || 0) + 1), a), {});
    // Search: order ID (with or without the dash), transaction ID, or reseller username
    const q = normId(orderQuery);
    const matches = (o) => !q || normId(o.id).includes(q) || normId(o.payment.trx).includes(q) || normId(o.customer.username).includes(q);
    const shown = orders.filter((o) => (filter === "all" || o.status === filter) && matches(o));
    root.innerHTML = sectionBar(pendingTopups) + `
      <form class="order-search" id="order-search">
        ${ICON.search}<input name="q" value="${esc(orderQuery)}" placeholder="Search order ID (e.g. PS-48291736), transaction ID or username" autocomplete="off">
        ${orderQuery ? `<button type="button" class="btn btn-outline" id="os-clear">Clear</button>` : ""}
        <button class="btn btn-primary">Find</button>
      </form>
      ${orderQuery ? `<p class="muted small search-note">${shown.length} order(s) found for “${esc(orderQuery)}”${filter !== "all" ? ` in “${filter}”` : ""}.</p>` : ""}
      <div class="admin-bar">
        <div class="tabs admin-tabs">
          ${["all", "pending", "processing", "delivered", "cancelled"].map((s) =>
            `<button class="tab ${filter === s ? "active" : ""}" data-f="${s}">${s[0].toUpperCase() + s.slice(1)} (${s === "all" ? orders.length : counts[s] || 0})</button>`).join("")}
        </div>
      </div>
      ${shown.length ? shown.map((o) => `
        <div class="card admin-order" data-id="${esc(o.id)}">
          <div class="ao-head">
            <div><b>${esc(o.id)}</b> <span class="status s-${o.status}">${STATUS_LABEL[o.status]}</span><br><span class="muted small">${fmtDate(o.createdAt)}</span></div>
            <div class="ao-head-right"><strong class="ao-total">${money(o.total)}</strong><button class="icon-btn ao-delete" title="Delete order" aria-label="Delete order">${ICON.trash}</button></div>
          </div>
          <div class="ao-grid">
            <div>
              <h5 class="label">Customer</h5>
              <p>${o.customer.username ? `Reseller · <b>${esc(o.customer.username)}</b>` : "Guest"}${o.customer.name ? "<br>" + esc(o.customer.name) : ""}${o.customer.phone ? "<br>" + esc(o.customer.phone) : ""}</p>
              <h5 class="label">Payment</h5>
              <p>${esc(o.payment.method)}${o.payment.auto ? ` · <b>${esc(o.payment.amountUsdt)} USDT</b>` : ""}${o.payment.trx ? `<br>TrxID: <b>${esc(o.payment.trx)}</b>` : ""}${o.refunded ? '<br><span class="status s-cancelled">Refunded to balance</span>' : ""}${o.payment.sender ? "<br>From: " + esc(o.payment.sender) : ""}${o.payment.proof ? `<br><button type="button" class="link-btn" data-proof="${esc(o.payment.proof)}">View payment screenshot</button>` : ""}</p>
              ${o.cancelReason ? `<p class="muted small">${esc(o.cancelReason)}</p>` : ""}
              ${o.payment.auto ? `
                <p>${o.payment.verified ? '<span class="status s-delivered">Auto-verified</span>' : '<span class="status s-pending">Not verified</span>'}</p>
                ${o.payment.verifyNote ? `<p class="muted small">${esc(o.payment.verifyNote)}</p>` : ""}
                ${o.payment.verified ? "" : '<button class="btn btn-outline ao-verify">Check payment now</button>'}` : ""}
            </div>
            <div>
              <h5 class="label">Items</h5>
              ${o.items.map((i) => `<p>${esc(i.name)} · ${esc(i.plan)}<br><span class="muted small">${i.qty} × ${money(i.unit)} = ${money(i.total)}</span>
                ${i.supplier ? '<br><span class="muted small">🔗 TokoPremium' + (i.supplierOrderId ? ` · ${esc(i.supplierOrderId)}` : "") + "</span>" : ""}
                ${i.supplierError && !i.delivered ? `<br><span class="bal-short small">TokoPremium order failed: ${esc(i.supplierError)}</span>` : ""}
                ${o.status === "cancelled" ? "" : i.delivered ? `<br><span class="status s-delivered">✓ Delivered ${i.supplier ? "from TokoPremium" : "from stock"}</span>`
                  : o.status === "delivered" && (o.delivery || "").trim() ? '<br><span class="status s-delivered">✓ Delivered by you</span>'
                  : '<br><span class="status s-pending">Not delivered yet</span>'}</p>`).join("")}
            </div>
            <div>
              <h5 class="label">Status & delivery</h5>
              ${aoWarn[o.id] ? `<div class="form-error">${esc(aoWarn[o.id])}</div>` : ""}
              ${o.status === "processing" && o.items.some((i) => i.supplier && !i.delivered) ? `<button class="btn btn-outline btn-block ao-supretry">↻ Retry TokoPremium order</button>` : ""}
              ${o.status !== "cancelled" && (o.status !== "delivered" || !(o.delivery || "").trim()) ? `
                <button class="btn btn-primary btn-block ao-approve">✅ Approve & deliver</button>
                <p class="muted small">Marks the order paid and sends the accounts from Stock to the customer right away.</p>` : ""}
              <select class="ao-status">${["pending", "processing", "delivered", "cancelled"].map((s) => `<option value="${s}" ${o.status === s ? "selected" : ""}>${STATUS_LABEL[s]}</option>`).join("")}</select>
              <textarea class="ao-delivery" rows="4" placeholder="Account details shown to the customer (only needed for manual plans or when there's no stock)">${esc(o.delivery || "")}</textarea>
              <button class="btn btn-outline btn-block ao-save">Save</button>
            </div>
          </div>
        </div>`).join("") : `<div class="empty card">${orderQuery ? `No order matches “${esc(orderQuery)}”.` : `No ${filter === "all" ? "" : filter + " "}orders.`}</div>`}`;

    $("#order-search", root).addEventListener("submit", (e) => { e.preventDefault(); orderQuery = e.target.q.value.trim(); filter = "all"; load(); });
    const clr = $("#os-clear", root);
    if (clr) clr.addEventListener("click", () => { orderQuery = ""; load(); });
    $$("[data-f]", root).forEach((b) => b.addEventListener("click", () => { filter = b.dataset.f; load(); }));
    bindBar();
    $$(".admin-order", root).forEach((card) => {
      const v = $(".ao-verify", card);
      if (v) v.addEventListener("click", async () => {
        v.disabled = true; v.textContent = "Checking…";
        const r = await api(`/api/admin/orders/${encodeURIComponent(card.dataset.id)}/verify`, { method: "POST" });
        const d = await r.json().catch(() => ({}));
        toast(r.ok ? esc(d.payment.verifyNote || "Checked") : esc(d.error || "Check failed"));
        load();
      });
      const save = async (status) => {
        const id = card.dataset.id;
        const r = await api(`/api/admin/orders/${encodeURIComponent(id)}`, { method: "POST", body: JSON.stringify({ status, delivery: $(".ao-delivery", card).value }) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) { toast(esc(d.error || "Could not save")); return; }
        aoWarn[id] = d.warning || "";
        toast(d.warning ? "Saved — but not delivered yet (see the message on the order)"
          : d.status === "delivered" ? `Order ${esc(id)} delivered ✓` : `Order ${esc(id)} saved`);
        load();
      };
      $(".ao-save", card).addEventListener("click", () => save($(".ao-status", card).value));

      // Delete: two confirmations
      $(".ao-delete", card).addEventListener("click", async () => {
        const o = orders.find((x) => x.id === card.dataset.id);
        const step1 = await modal({
          title: `Delete order ${esc(o.id)}?`,
          body: `<p>${o.items.map((i) => `${esc(i.name)} · ${esc(i.plan)} ×${i.qty}`).join("<br>")}</p>
                 <p class="muted small">${money(o.total)} · ${o.customer.username ? "Reseller " + esc(o.customer.username) : "Guest"} · ${STATUS_LABEL[o.status]}</p>`,
          confirm: "Yes, continue", danger: true,
        });
        if (!step1) return;
        const fromStock = o.items.reduce((a, i) => a + (Array.isArray(i.delivered) ? i.delivered.length : 0), 0);
        const canRefund = o.payment.method === "Balance" && !o.refunded && o.customer.username;
        const step2 = await modal({
          title: "Are you sure? This can't be undone.",
          body: `<p>Order <b>${esc(o.id)}</b> will be removed from orders and reports. A backup copy is kept on the server.</p>
                 ${fromStock ? `<label class="chk"><input type="checkbox" name="restock" checked> Return the ${fromStock} delivered account(s) to stock</label>` : ""}
                 ${canRefund ? `<label class="chk"><input type="checkbox" name="refund" checked> Refund ${money(o.total)} to ${esc(o.customer.username)}'s balance</label>` : ""}`,
          confirm: "Delete permanently", danger: true,
        });
        if (!step2) return;
        const r = await api(`/api/admin/orders/${encodeURIComponent(o.id)}/delete`, { method: "POST", body: JSON.stringify(step2) });
        const d = await r.json().catch(() => ({}));
        toast(r.ok ? `Deleted ${esc(o.id)}${d.restocked ? ` · ${d.restocked} account(s) back in stock` : ""}${d.refunded ? ` · refunded ${money(d.refunded)}` : ""}` : esc(d.error || "Could not delete"));
        load();
      });
      const sr = $(".ao-supretry", card);
      if (sr) sr.addEventListener("click", async () => {
        sr.disabled = true; sr.textContent = "Ordering from TokoPremium…";
        const id = card.dataset.id;
        const r = await api(`/api/admin/orders/${encodeURIComponent(id)}/supplier-retry`, { method: "POST" });
        const d = await r.json().catch(() => ({}));
        aoWarn[id] = r.ok ? d.warning || "" : d.error || "Retry failed";
        toast(r.ok && !d.warning ? `Order ${esc(id)} delivered ✓` : "TokoPremium order still not delivered (see the message)");
        load();
      });
      const ap = $(".ao-approve", card);
      if (ap) ap.addEventListener("click", () => { ap.disabled = true; ap.textContent = "Delivering…"; save("delivered"); });
    });
  };

  sessionStorage.getItem(KEY) ? load() : login();
}
window.initAdmin = initAdmin;

/* ---------- Page: Reseller profile ---------- */
/* ---------- Page: Profile of a member whose reseller application isn't approved (yet) ---------- */
async function initApplicantAccount() {
  const root = $("#account-root");
  const TABS = [["status", "Application"], ["orders", "My orders"], ["settings", "Settings"]];
  const TYPE_LABEL = { website: "Website / online store", bot: "Telegram / WhatsApp bot", other: "Facebook page / group / other" };
  const PH = { website: "https://yourstore.com", bot: "https://t.me/yourbot  or  @yourbot", other: "https://facebook.com/yourpage" };
  let orders = [];
  const safeHref = (u) => (/^https?:\/\//i.test(u) ? u : "#");

  const statusView = () => {
    const a = USER.application, rej = USER.status === "rejected";
    return `
      <div class="card app-status ${rej ? "rej" : "pend"}">
        <span class="status ${rej ? "s-cancelled" : "s-pending"}">${rej ? "Not approved" : "Under review"}</span>
        <h3>${rej ? "Your application wasn't approved" : "Your reseller application is being reviewed"}</h3>
        <p class="muted">${rej
          ? "You can fix your details below and submit again."
          : "The admin checks your website/bot link, then approves your account. Until then you can order at normal prices. We'll switch on reseller prices and your wallet as soon as you're approved — just come back to this page."}</p>
        ${rej && a && a.rejectNote ? `<div class="form-error"><b>Reason:</b> ${esc(a.rejectNote)}</div>` : ""}
      </div>
      <div class="acc-two">
        <div class="card acc-form">
          <h3>Your application</h3>
          ${a ? `
            <div class="sum-row"><span>Type</span><b>${esc(TYPE_LABEL[a.type] || a.type)}</b></div>
            <div class="sum-row"><span>Link</span><a href="${esc(safeHref(a.link))}" target="_blank" rel="noopener nofollow">${esc(a.link)}</a></div>
            ${a.contact ? `<div class="sum-row"><span>Contact</span><span>${esc(a.contact)}</span></div>` : ""}
            ${a.note ? `<div class="sum-row"><span>About</span><span>${esc(a.note)}</span></div>` : ""}
            <div class="sum-row"><span>Submitted</span><span>${fmtDate(a.submittedAt)}</span></div>` : `<p class="muted">No application on file.</p>`}
        </div>
        <form class="card acc-form" id="apply-form">
          <h3>${rej || !a ? "Submit again" : "Change your link"}</h3>
          <label>Where do you sell?
            <select name="type">${Object.entries(TYPE_LABEL).map(([k, l]) => `<option value="${k}" ${a && a.type === k ? "selected" : ""}>${l}</option>`).join("")}</select></label>
          <label>Website / bot / page link<input name="link" required maxlength="300" value="${esc(a ? a.link : "")}" placeholder="${PH[a ? a.type : "website"]}"></label>
          <label>Telegram / WhatsApp (optional)<input name="contact" maxlength="80" value="${esc(a ? a.contact : "")}"></label>
          <label>About your business (optional)<textarea name="note" rows="2" maxlength="500">${esc(a ? a.note : "")}</textarea></label>
          <div class="form-error" id="apply-error" hidden></div>
          <button class="btn btn-primary btn-block">${rej ? "Submit application again" : "Update application"}</button>
        </form>
      </div>`;
  };

  const ordersView = () => orders.length ? `<div class="card cart-list">${orders.map((o) => `
    <a class="cart-line my-order" href="order.html?id=${encodeURIComponent(o.id)}&t=${encodeURIComponent(o.token)}">
      <div class="cl-info"><b>${esc(o.id)}</b><span class="muted small">${fmtDate(o.createdAt)} · ${o.items.map((i) => esc(i.name) + " ×" + i.qty).join(", ")}</span></div>
      <span class="status ${o.waitingAdmin ? "s-pending" : "s-" + o.status}">${statusText(o)}</span>
      <strong class="cl-total">${money(o.total)}</strong>
    </a>`).join("")}</div>` : `<div class="empty card"><h2>No orders yet</h2><a class="btn btn-primary" href="index.html#products">Browse products</a></div>`;

  const settingsView = () => `
    <div class="acc-two">
      <form class="card acc-form" id="pw-form">
        <h3>Change password</h3>
        <label>Current password<input name="current" type="password" required autocomplete="current-password"></label>
        <label>New password<input name="next" type="password" required minlength="6" autocomplete="new-password"></label>
        <label>Confirm new password<input name="next2" type="password" required minlength="6" autocomplete="new-password"></label>
        <div class="form-error" id="pw-error" hidden></div>
        <button class="btn btn-primary btn-block">Update password</button>
      </form>
      <div class="card acc-form">
        <h3>Account</h3>
        <div class="sum-row"><span>Username</span><b>${esc(USER.username)}</b></div>
        <div class="sum-row"><span>Account type</span><span class="status s-pending">Member</span></div>
        <div class="sum-row"><span>Member since</span><span>${fmtDate(USER.createdAt)}</span></div>
        <button class="btn btn-outline btn-block" id="acc-logout">Log out</button>
      </div>
    </div>`;

  const views = { status: statusView, orders: ordersView, settings: settingsView };
  const render = () => {
    const tab = TABS.some(([k]) => "#" + k === location.hash) ? location.hash.slice(1) : "status";
    root.innerHTML = `
      <div class="acc-head">
        <div><span class="eyebrow">Member profile</span><h1 class="page-title">${esc(USER.username)}</h1></div>
        <div class="acc-bal"><small>Reseller status</small><b class="${USER.status === "rejected" ? "amt-minus" : ""}" style="color:${USER.status === "rejected" ? "var(--red)" : "#b45309"}">${USER.status === "rejected" ? "Not approved" : "Pending"}</b></div>
      </div>
      <div class="tabs acc-tabs">${TABS.map(([k, l]) => `<a class="tab ${k === tab ? "active" : ""}" href="#${k}">${l}</a>`).join("")}</div>
      <div id="acc-view">${views[tab]()}</div>`;
    const af = $("#apply-form");
    if (af) {
      af.type.addEventListener("change", () => (af.link.placeholder = PH[af.type.value]));
      af.addEventListener("submit", async (e) => {
        e.preventDefault();
        const err = $("#apply-error"); err.hidden = true;
        const r = await fetch("/api/auth/apply", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.fromEntries(new FormData(af))) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) { err.textContent = d.error || "Could not submit."; err.hidden = false; return; }
        USER = d; toast("Application submitted"); render();
      });
    }
    const lo = $("#acc-logout");
    if (lo) lo.addEventListener("click", async () => { await fetch("/api/auth/logout", { method: "POST" }); location.href = "index.html"; });
    const pf = $("#pw-form");
    if (pf) pf.addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = new FormData(pf), err = $("#pw-error"); err.hidden = true;
      if (f.get("next") !== f.get("next2")) { err.textContent = "New passwords don't match."; err.hidden = false; return; }
      const r = await fetch("/api/auth/password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ current: f.get("current"), next: f.get("next") }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { err.textContent = d.error || "Could not update."; err.hidden = false; return; }
      pf.reset(); toast("Password updated");
    });
  };

  const r = await fetch("/api/my/orders");
  orders = r.ok ? await r.json() : [];
  render();
  window.addEventListener("hashchange", render);
}
async function initAccount() {
  if (!USER) { location.replace("login.html?next=" + encodeURIComponent("account.html" + location.hash)); return; }
  if (!USER.reseller) return initApplicantAccount();
  const root = $("#account-root");
  const TABS = [["overview", "Overview"], ["add", "Add balance"], ["orders", "My orders"], ["history", "Balance history"], ["settings", "Settings"]];
  let W = null, orders = [];
  const TOPUP_LABEL = { pending: "Waiting for check", completed: "Added", rejected: "Rejected" };
  const TX_LABEL = { topup: "Balance added", order: "Order payment", refund: "Refund", adjust: "Adjustment" };

  const load = async () => {
    const [w, o] = await Promise.all([fetch("/api/wallet").then((r) => r.json()), fetch("/api/my/orders").then((r) => r.json())]);
    W = w; orders = o; USER.balance = w.balance;
    $$(".nav-user b:not(.pend)").forEach((b) => (b.textContent = money(w.balance)));
  };

  const orderRows = (list) => list.length ? list.map((o) => `
    <a class="cart-line my-order" href="order.html?id=${encodeURIComponent(o.id)}&t=${encodeURIComponent(o.token)}">
      <div class="cl-info"><b>${esc(o.id)}</b><span class="muted small">${fmtDate(o.createdAt)} · ${o.items.map((i) => esc(i.name) + " ×" + i.qty).join(", ")}</span></div>
      <span class="status ${o.waitingAdmin ? "s-pending" : "s-" + o.status}">${statusText(o)}</span>
      <strong class="cl-total">${money(o.total)}</strong>
    </a>`).join("") : `<p class="muted" style="padding:18px 0">No orders yet. <a href="index.html#products">Browse products</a></p>`;

  const topupRows = (list) => list.map((t) => `
    <div class="cart-line topup-line">
      <div class="cl-info"><b>${money(t.amount)} via ${esc(t.payment.method)}</b>
        <span class="muted small">${fmtDate(t.createdAt)}${t.payment.trx && t.payment.provider !== "cryptomus" ? ` · ID ${esc(t.payment.trx)}` : ""}</span>
        ${t.status === "pending" && t.payment.verifyNote ? `<span class="small verify-inline">${esc(t.payment.verifyNote)}</span>` : ""}
        ${t.status === "rejected" && t.note ? `<span class="small bal-short">${esc(t.note)}</span>` : ""}
      </div>
      <span class="status ${t.status === "completed" ? "s-delivered" : t.status === "rejected" ? "s-cancelled" : "s-pending"}">${TOPUP_LABEL[t.status]}</span>
      ${t.status === "pending" && t.payment.auto ? `<span class="tu-actions">${t.payment.payUrl ? `<a class="btn btn-primary" href="${esc(t.payment.payUrl)}">Pay now</a> ` : ""}<button class="btn btn-outline" data-recheck="${esc(t.id)}">Check again</button></span>` : "<span></span>"}
    </div>`).join("");

  const views = {
    overview: () => `
      <div class="acc-grid">
        <div class="card balance-card">
          <span>Available balance</span>
          <strong>${money(W.balance)}</strong>
          <a class="btn btn-light" href="#add">${ICON.plus} Add balance</a>
        </div>
        <div class="card stat"><span>Total orders</span><strong>${W.stats.orders}</strong></div>
        <div class="card stat"><span>Total spent</span><strong>${money(W.stats.spent)}</strong></div>
        <div class="card stat g"><span>Saved with reseller price</span><strong>${money(W.stats.saved)}</strong></div>
      </div>
      <div class="acc-section-head"><h3>Recent orders</h3><a href="#orders">View all</a></div>
      <div class="card cart-list">${orderRows(orders.slice(0, 5))}</div>`,

    add: () => `
      <div class="acc-two">
        <form class="card acc-form" id="topup-form">
          <h3>Add balance</h3>
          <label>Amount (${SITE.currency})<input name="amount" type="number" min="${SITE.topupMin}" max="${SITE.topupMax}" step="0.01" required placeholder="${SITE.topupMin} – ${SITE.topupMax}"></label>
          <div class="chips">${[5, 10, 25, 50].map((a) => `<button type="button" class="tab" data-amt="${a}">${money(a)}</button>`).join("")}</div>
          ${payFields(false)}
          <div class="form-error" id="topup-error" hidden></div>
          <button class="btn btn-primary btn-block" id="topup-btn">Submit</button>
          <p class="muted small">Balance is added automatically as soon as your payment is confirmed by ${SITE.payments.map(esc).join(", ")}.</p>
        </form>
        <div>
          <div class="acc-section-head"><h3>Your requests</h3></div>
          <div class="card cart-list">${W.topups.length ? topupRows(W.topups) : `<p class="muted" style="padding:18px 0">No balance requests yet.</p>`}</div>
        </div>
      </div>`,

    orders: () => `<div class="card cart-list">${orderRows(orders)}</div>`,

    history: () => `
      <div class="card table-wrap">
        ${W.ledger.length ? `<table>
          <thead><tr><th>Date</th><th>Type</th><th>Details</th><th>Amount</th><th>Balance</th></tr></thead>
          <tbody>${W.ledger.map((x) => `<tr>
            <td class="muted">${fmtDate(x.createdAt)}</td><td>${TX_LABEL[x.type] || esc(x.type)}</td><td class="muted">${esc(x.note || "")}</td>
            <td class="${x.amount >= 0 ? "amt-plus" : "amt-minus"}">${x.amount >= 0 ? "+" : "−"}${money(Math.abs(x.amount))}</td><td>${money(x.balanceAfter)}</td></tr>`).join("")}</tbody>
        </table>` : `<p class="muted" style="padding:20px">No balance activity yet.</p>`}
      </div>`,

    settings: () => `
      <div class="acc-two">
        <form class="card acc-form" id="pw-form">
          <h3>Change password</h3>
          <label>Current password<input name="current" type="password" required autocomplete="current-password"></label>
          <label>New password<input name="next" type="password" required minlength="6" autocomplete="new-password"></label>
          <label>Confirm new password<input name="next2" type="password" required minlength="6" autocomplete="new-password"></label>
          <div class="form-error" id="pw-error" hidden></div>
          <button class="btn btn-primary btn-block">Update password</button>
        </form>
        <div class="card acc-form">
          <h3>Account</h3>
          <div class="sum-row"><span>Username</span><b>${esc(USER.username)}</b></div>
          <div class="sum-row"><span>Account type</span><span class="status s-delivered">Reseller</span></div>
          <div class="sum-row"><span>Member since</span><span>${fmtDate(USER.createdAt)}</span></div>
          <button class="btn btn-outline btn-block" id="acc-logout">Log out</button>
        </div>
      </div>`,
  };

  const render = () => {
    const tab = TABS.some(([k]) => "#" + k === location.hash) ? location.hash.slice(1) : "overview";
    root.innerHTML = `
      <div class="acc-head">
        <div><span class="eyebrow">Reseller profile</span><h1 class="page-title">${esc(USER.username)}</h1></div>
        <div class="acc-bal"><small>Balance</small><b>${money(W.balance)}</b></div>
      </div>
      <div class="tabs acc-tabs">${TABS.map(([k, l]) => `<a class="tab ${k === tab ? "active" : ""}" href="#${k}">${l}</a>`).join("")}</div>
      <div id="acc-view">${views[tab]()}</div>`;
    bindView(tab);
  };

  const bindView = (tab) => {
    if (tab === "add") {
      const form = $("#topup-form");
      const amt = () => Math.max(0, r2(Number(form.amount.value) || 0));
      const refresh = bindPayForm(form, amt);
      form.amount.addEventListener("input", refresh);
      $$("[data-amt]", form).forEach((b) => b.addEventListener("click", () => { form.amount.value = b.dataset.amt; refresh(); }));
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const err = $("#topup-error"), btn = $("#topup-btn");
        err.hidden = true; btn.disabled = true; btn.textContent = "Submitting…";
        let pay;
        try { pay = await payBody(form); } catch (ex) { err.textContent = ex.message; err.hidden = false; btn.disabled = false; btn.textContent = "Submit"; return; }
        const r = await fetch("/api/wallet/topup", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ amount: amt(), ...pay }) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) { err.textContent = d.error || "Could not submit."; err.hidden = false; btn.disabled = false; btn.textContent = "Submit"; return; }
        if (d.payment && d.payment.payUrl && d.status === "pending") { location.href = d.payment.payUrl; return; }
        toast(d.status === "completed" ? `${money(d.amount)} added to your balance` : "Request submitted — we'll add it after checking");
        await load(); render();
      });
      $$("[data-recheck]").forEach((b) => b.addEventListener("click", async () => {
        b.disabled = true; b.textContent = "Checking…";
        const r = await fetch(`/api/wallet/topup/${encodeURIComponent(b.dataset.recheck)}/verify`, { method: "POST" });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) toast(esc(d.error || "Check failed"));
        else if (d.status === "completed") toast(`${money(d.amount)} added to your balance`);
        await load(); render();
      }));
    }
    if (tab === "settings") {
      $("#acc-logout").addEventListener("click", async () => { await fetch("/api/auth/logout", { method: "POST" }); location.href = "index.html"; });
      $("#pw-form").addEventListener("submit", async (e) => {
        e.preventDefault();
        const f = new FormData(e.target), err = $("#pw-error");
        err.hidden = true;
        if (f.get("next") !== f.get("next2")) { err.textContent = "New passwords don't match."; err.hidden = false; return; }
        const r = await fetch("/api/auth/password", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ current: f.get("current"), next: f.get("next") }) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) { err.textContent = d.error || "Could not update."; err.hidden = false; return; }
        e.target.reset(); toast("Password updated");
      });
    }
  };

  await load();
  render();
  window.addEventListener("hashchange", render);
}

/* ---------- Page: Login / Join ---------- */
function initLogin() {
  const qs = new URLSearchParams(location.search);
  const next = /^[a-z]+\.html([?#].*)?$|^\/[a-z]+\.html([?#].*)?$/i.test(qs.get("next") || "") ? qs.get("next") : "index.html";
  if (USER) { location.replace(next); return; }
  let mode = qs.get("mode") === "join" ? "join" : "login";
  let storeType = "website";
  const root = $("#login-root");

  const typeHelp = {
    website: { label: "Your website / store link", ph: "https://yourstore.com", hint: "A page where you sell (or will sell) these products." },
    bot: { label: "Your bot link", ph: "https://t.me/yourbot  or  @yourbot", hint: "The Telegram or WhatsApp bot your customers buy from." },
    other: { label: "Your page / group link", ph: "https://facebook.com/yourpage", hint: "Facebook page, group, marketplace shop or channel where you sell." },
  };

  const render = () => {
    const h = typeHelp[storeType];
    root.innerHTML = `
      <div class="auth-grid">
        <div class="card auth-card">
          <div class="tabs auth-tabs">
            <button class="tab ${mode === "login" ? "active" : ""}" data-m="login">Login</button>
            <button class="tab ${mode === "join" ? "active" : ""}" data-m="join">Apply as reseller</button>
          </div>
          <form id="auth-form">
            <label>Username<input name="username" required minlength="3" maxlength="30" pattern="[A-Za-z0-9_.]{3,30}" autocomplete="username" placeholder="e.g. rahim_store"></label>
            <label>Password<input name="password" type="password" required minlength="6" autocomplete="${mode === "join" ? "new-password" : "current-password"}" placeholder="${mode === "join" ? "At least 6 characters" : ""}"></label>
            ${mode === "join" ? `
              <label>Confirm password<input name="password2" type="password" required minlength="6" autocomplete="new-password"></label>
              <label>Where do you sell?
                <select name="type" id="store-type">${Object.entries({ website: "Website / online store", bot: "Telegram / WhatsApp bot", other: "Facebook page / group / other" }).map(([k, l]) => `<option value="${k}" ${k === storeType ? "selected" : ""}>${l}</option>`).join("")}</select>
              </label>
              <label>${h.label}<input name="link" required maxlength="300" placeholder="${h.ph}" autocomplete="off"><small class="muted">${h.hint} Required — we check it before approving.</small></label>
              <label>Telegram / WhatsApp to reach you (optional)<input name="contact" maxlength="80" placeholder="@yourname or +8801…"></label>
              <label>About your business (optional)<textarea name="note" rows="2" maxlength="500" placeholder="How many customers, what you sell…"></textarea></label>` : ""}
            <div class="form-error" id="auth-error" hidden></div>
            <button class="btn btn-primary btn-block" id="auth-btn">${mode === "join" ? "Submit application" : "Login"}</button>
          </form>
          <p class="muted small">${mode === "join" ? "Free. The admin reviews your application; you get the reseller price and wallet once approved." : `New here? <a href="#" data-m="join">Apply as reseller</a>.`}</p>
        </div>
        <div class="auth-side">
          <span class="eyebrow">Reseller program</span>
          <h2>Reseller price from ${SITE.bulkMinQty} pcs</h2>
          <ul class="auth-perks">
            <li>${ICON.tag} Pay the lower reseller price on every product when you buy ${SITE.bulkMinQty}+</li>
            <li>${ICON.wallet} Reseller wallet: top up and pay instantly</li>
            <li>${ICON.shield} Same warranty for your customers</li>
          </ul>
          <p class="muted small"><b>How it works:</b> 1) apply with your website or bot link, 2) the admin checks it, 3) you're approved and can start buying at reseller prices. Just buying for yourself? <a href="cart.html">Order as a guest</a> — no account needed.</p>
        </div>
      </div>`;
    $$("[data-m]", root).forEach((b) => b.addEventListener("click", (e) => { e.preventDefault(); mode = b.dataset.m; render(); }));
    const sel = $("#store-type");
    if (sel) sel.addEventListener("change", () => {
      // keep what was typed while switching the wording
      const keep = Object.fromEntries(new FormData($("#auth-form")));
      storeType = sel.value; render();
      const f = $("#auth-form");
      for (const k of ["username", "password", "password2", "link", "contact", "note"]) if (f[k] && keep[k] !== undefined) f[k].value = keep[k];
    });
    $("#auth-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = new FormData(e.target), err = $("#auth-error"), btn = $("#auth-btn");
      err.hidden = true;
      if (mode === "join" && f.get("password") !== f.get("password2")) { err.textContent = "Passwords don't match."; err.hidden = false; return; }
      btn.disabled = true;
      const r = await fetch(`/api/auth/${mode === "join" ? "signup" : "login"}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(Object.fromEntries(f)),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok) return location.replace(mode === "join" ? "account.html#status" : (d.reseller ? next : "account.html#status"));
      err.textContent = d.error || "Something went wrong."; err.hidden = false; btn.disabled = false;
    });
  };
  render();
}
/* ---------- Boot ---------- */
document.addEventListener("DOMContentLoaded", async () => {
  try {
    const [me, st] = await Promise.all([fetch("/api/auth/me", { cache: "no-store" }), fetch("/api/stock", { cache: "no-store" })]);
    if (me.ok) USER = await me.json();
    // Automatic-delivery plans show the real number of accounts in stock
    if (st.ok) {
      const counts = await st.json();
      for (const p of PRODUCTS) for (const v of p.variants) if (!v.manual) v.stock = counts[`${p.slug}|${v.pkg}|${v.duration}`] || 0;
    }
  } catch { /* offline or static hosting: continue as guest */ }
  renderHeader();
  renderFooter();
  updateCartBadge();
  const page = document.body.dataset.page;
  ({ home: initHome, product: initProduct, cart: initCart, reseller: initReseller, order: initOrder, admin: initAdmin, login: initLogin, account: initAccount })[page]?.();
});
window.addEventListener("storage", updateCartBadge);
