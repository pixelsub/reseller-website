// PixelSub server: static site + order API.
//   node server.js   ->  http://localhost:5173
// Env (put them in a .env file, see .env.example):
//   PORT (default 5173), ADMIN_KEY (admin panel password, default "change-me")
//   BINANCE_API_KEY, BINANCE_API_SECRET  -> read-only Binance API key used to auto-verify Binance Pay payments
//   BYBIT_API_KEY, BYBIT_API_SECRET      -> read-only Bybit API key used to auto-verify Bybit UID transfers
//   CRYPTOMUS_MERCHANT_ID, CRYPTOMUS_PAYMENT_API_KEY (or CRYPTOMUS_API_KEY) -> Cryptomus payment API key (invoices + webhooks)
//   TOKOPREMIUM_API_KEY                  -> TokoPremium reseller API key (live price/stock + automatic supplier orders)
//   PUBLIC_URL                           -> e.g. https://pixelsub.shop (used for Cryptomus return/webhook links)
const http = require("http");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const crypto = require("crypto");

const root = __dirname;
const port = process.env.PORT || 5173;
const ADMIN_KEY = process.env.ADMIN_KEY || "change-me";
// All shop data (orders, accounts, stock, catalogue, uploads) lives here. On Railway set DATA_DIR to the Volume mount path.
// DATA_DIR wins; otherwise a Railway Volume (Railway sets RAILWAY_VOLUME_MOUNT_PATH by itself); otherwise ./storage
const defaultStoreDir = path.join(root, "storage");
const storeDir = path.resolve(process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || defaultStoreDir);
// On Railway without a volume the disk is wiped on every deploy
const dataAtRisk = !!(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID) && storeDir === path.resolve(defaultStoreDir);
const ordersFile = path.join(storeDir, "orders.json");
const types = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon" };
const STATUSES = ["pending", "processing", "delivered", "cancelled"];
const BINANCE_BASE = process.env.BINANCE_API_BASE || "https://api.binance.com";

/* ---------- Binance Pay verification ---------- */
// Uses GET /sapi/v1/pay/transactions (Binance Pay trade history, signed USER_DATA endpoint).
let payCache = { at: 0, data: null };

async function binancePayHistory() {
  const key = process.env.BINANCE_API_KEY, secret = process.env.BINANCE_API_SECRET;
  if (!key || !secret) throw new Error("Binance API is not configured on the server.");
  if (payCache.data && Date.now() - payCache.at < 10_000) return payCache.data;

  const params = new URLSearchParams({
    startTime: String(Date.now() - 7 * 24 * 3600_000),
    limit: "100",
    recvWindow: "10000",
    timestamp: String(Date.now()),
  });
  params.append("signature", crypto.createHmac("sha256", secret).update(params.toString()).digest("hex"));
  const r = await fetch(`${BINANCE_BASE}/sapi/v1/pay/transactions?${params}`, {
    headers: { "X-MBX-APIKEY": key },
    signal: AbortSignal.timeout(10_000),
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok || (json.code && json.code !== "000000")) {
    throw new Error(`Binance API error: ${json.msg || json.message || r.status}`);
  }
  payCache = { at: Date.now(), data: Array.isArray(json.data) ? json.data : [] };
  return payCache.data;
}

const norm = (s) => String(s ?? "").trim().toUpperCase();

function usdtReceived(tx) {
  if (norm(tx.currency) === "USDT") return Number(tx.amount);
  const f = (tx.fundsDetail || []).find((d) => norm(d.currency) === "USDT");
  return f ? Number(f.amount) : NaN;
}

// True if another order or balance top-up already used this transaction ID
function trxUsed(trx, exceptId, onlyVerified = false) {
  const t = norm(trx);
  const hit = (x) => x.id !== exceptId && x.status !== "cancelled" && x.status !== "rejected" &&
    (!onlyVerified || x.payment.verified) && x.payment && norm(x.payment.trx) === t;
  return loadOrders().some(hit) || loadTopups().some(hit);
}

/* ---------- Bybit internal transfer verification ---------- */
// Customer sends USDT to your Bybit UID (internal transfer, no fee). We read
// GET /v5/asset/deposit/query-internal-record (signed, read-only key) and match the transfer ID.
const BYBIT_BASE = process.env.BYBIT_API_BASE || "https://api.bybit.com";
let bybitCache = { at: 0, data: null };

async function bybitDeposits() {
  const key = process.env.BYBIT_API_KEY, secret = process.env.BYBIT_API_SECRET;
  if (!key || !secret) throw new Error("Bybit API is not configured on the server.");
  if (bybitCache.data && Date.now() - bybitCache.at < 10_000) return bybitCache.data;
  const now = Date.now();
  const query = `startTime=${now - 7 * 24 * 3600_000}&endTime=${now}&limit=50`;
  const ts = String(now), recv = "10000";
  const sign = crypto.createHmac("sha256", secret).update(ts + key + recv + query).digest("hex");
  const r = await fetch(`${BYBIT_BASE}/v5/asset/deposit/query-internal-record?${query}`, {
    headers: { "X-BAPI-API-KEY": key, "X-BAPI-TIMESTAMP": ts, "X-BAPI-RECV-WINDOW": recv, "X-BAPI-SIGN": sign },
    signal: AbortSignal.timeout(10_000),
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok || json.retCode !== 0) throw new Error(`Bybit API error: ${json.retMsg || r.status}`);
  bybitCache = { at: Date.now(), data: (json.result && json.result.rows) || [] };
  return bybitCache.data;
}

/* ---------- Cryptomus invoices ---------- */
// Customer is redirected to a Cryptomus invoice and can pay with any crypto.
// Cryptomus calls /api/cryptomus/webhook when the status changes; we also double-check with /v1/payment/info.
const CM_BASE = process.env.CRYPTOMUS_API_BASE || "https://api.cryptomus.com";
// Payment API key (Cryptomus calls it the "Payment" key; the Payout key is not used here)
const cmKey = () => process.env.CRYPTOMUS_PAYMENT_API_KEY || process.env.CRYPTOMUS_API_KEY || "";
const cmSign = (bodyStr) => crypto.createHash("md5").update(Buffer.from(bodyStr).toString("base64") + cmKey()).digest("hex");

async function cryptomus(pathname, data) {
  if (!process.env.CRYPTOMUS_MERCHANT_ID || !cmKey()) throw new Error("Cryptomus is not configured on the server.");
  const body = JSON.stringify(data);
  const r = await fetch(CM_BASE + pathname, {
    method: "POST",
    headers: { "Content-Type": "application/json", merchant: process.env.CRYPTOMUS_MERCHANT_ID, sign: cmSign(body) },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok || json.state !== 0) throw new Error(`Cryptomus error: ${json.message || r.status}`);
  return json.result;
}

const publicBase = (req) => (process.env.PUBLIC_URL || `${req.headers["x-forwarded-proto"] || "http"}://${req.headers.host}`).replace(/\/$/, "");

// Creates the invoice and stores its link on the order/top-up payment
async function createInvoice(entity, req, returnPath, lifetimeSec = 7200) {
  const base = publicBase(req);
  const res = await cryptomus("/v1/payment", {
    amount: Number(entity.payment.amountUsdt).toFixed(2),
    currency: "USD",
    order_id: entity.id,
    url_callback: `${base}/api/cryptomus/webhook`,
    url_return: base + returnPath,
    url_success: base + returnPath,
    lifetime: lifetimeSec,
  });
  entity.payment.invoice = { uuid: res.uuid, url: res.url };
  entity.payment.payUrl = res.url;
}

// Webhook signature: md5(base64(JSON without "sign", slashes escaped like PHP) + API key)
function cryptomusWebhookValid(data) {
  const { sign, ...rest } = data;
  if (!sign || !cmKey()) return false;
  const expected = cmSign(JSON.stringify(rest).replace(/\//g, "\\/"));
  const a = Buffer.from(String(sign)), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ---------- Payment verification (all providers) ---------- */
const PROVIDER_NAME = { binance: "Binance", bybit: "Bybit", cryptomus: "Cryptomus" };
const clearPayCaches = () => { payCache.at = 0; bybitCache.at = 0; };

// Returns { ok, note }. Marks the payment verified when the provider confirms an incoming payment
// of at least the expected USD/USDT amount that no other order/top-up already used.
// Works for orders and balance top-ups (anything with a .payment and .id).
async function verifyPayment(e) {
  const p = e.payment, name = PROVIDER_NAME[p.provider] || "the provider";
  const need = Number(p.amountUsdt);
  let got;

  if (p.provider === "cryptomus") {
    const info = await cryptomus("/v1/payment/info", { order_id: e.id });
    const status = info.payment_status || info.status;
    // Paid but still confirming on the blockchain: don't let the order expire meanwhile
    p.inProgress = ["confirm_check", "process", "check"].includes(status);
    if (!["paid", "paid_over"].includes(status)) {
      if (p.inProgress) return { ok: false, note: "Payment received — waiting for blockchain confirmation." };
      return { ok: false, note: ["cancel", "fail", "system_fail", "refund_paid"].includes(status)
        ? "The Cryptomus payment failed or expired. Please place a new one."
        : "Waiting for your payment on Cryptomus." };
    }
    got = Number(info.amount);
    p.trx = info.uuid || p.trx;
  } else {
    const trx = norm(p.trx);
    if (trxUsed(trx, e.id, true)) return { ok: false, note: `This ${name} transaction ID was already used.` };
    if (p.provider === "bybit") {
      const rows = await bybitDeposits();
      const row = rows.find((x) => norm(x.txID) === trx || norm(x.id) === trx);
      if (!row) return { ok: false, note: "Transfer not found yet. It can take a minute to appear — try again shortly." };
      if (norm(row.coin) !== "USDT") return { ok: false, note: "This transfer is not in USDT." };
      if (Number(row.status) !== 2) return { ok: false, note: "This transfer hasn't completed on Bybit yet." };
      got = Number(row.amount);
    } else {
      const txs = await binancePayHistory();
      const tx = txs.find((t) => norm(t.transactionId) === trx || norm(t.orderId) === trx);
      if (!tx) return { ok: false, note: "Payment not found yet. It can take a minute to appear — try again shortly." };
      got = usdtReceived(tx);
    }
  }

  if (!(got > 0)) return { ok: false, note: "This transaction is not an incoming payment." };
  if (got + 0.0001 < need) return { ok: false, note: `Amount too low: received ${got}, expected ${need}.` };

  p.verified = true;
  p.verifiedAt = new Date().toISOString();
  p.receivedUsdt = got;
  if (e.items && e.status === "pending") e.status = "processing";
  return { ok: true, note: `Verified via ${name}: ${got} ${p.provider === "cryptomus" ? "USD" : "USDT"} received.` };
}

async function tryVerify(order) {
  try {
    const res = await verifyPayment(order);
    order.payment.verifyNote = res.note;
    return res;
  } catch (e) {
    console.error("Payment verify:", e.message);
    order.payment.verifyNote = "Automatic check unavailable right now — the admin will verify manually.";
    return { ok: false, note: order.payment.verifyNote };
  } finally {
    order.payment.lastCheck = Date.now();
  }
}

/* ---------- Catalogue ---------- */
// The admin panel edits storage/catalog.json ({ SITE, CATEGORIES, PRODUCTS }).
// Until the first edit, assets/js/data.js is used as the starting catalogue.
// The browser always loads /assets/js/data.js, which the server generates from the catalogue
// with private fields (cost prices) removed.
const catalogFile = path.join(storeDir, "catalog.json");
let catCache = { mtime: -1, data: null };

function seedCatalog() {
  const code = fs.readFileSync(path.join(root, "assets/js/data.js"), "utf8") + "\n;globalThis.__cat = { SITE, CATEGORIES, PRODUCTS };";
  const ctx = {};
  vm.runInNewContext(code, ctx);
  return JSON.parse(JSON.stringify(ctx.__cat));
}

// A saved catalogue made before the real contact / payment IDs were in data.js still holds the
// placeholders; take those from data.js. Anything set in admin Settings is kept as is.
const PLACEHOLDERS = { whatsapp: "8801700000000", telegram: "pixelsub", payId: "000000000" };
function fillPlaceholders(data) {
  const S = data.SITE || {}, D = seedCatalog().SITE;
  for (const k of ["whatsapp", "telegram", "bot"]) if (!S[k] || S[k] === PLACEHOLDERS[k]) S[k] = D[k];
  for (const [m, info] of Object.entries(S.paymentInfo || {})) {
    const def = (D.paymentInfo || {})[m];
    if (def && "value" in info && (!info.value || info.value === PLACEHOLDERS.payId)) info.value = def.value;
  }
  return data;
}

function catalog() {
  let mtime = 0;
  try { mtime = fs.statSync(catalogFile).mtimeMs; } catch { mtime = 0; }
  if (catCache.data && catCache.mtime === mtime) return catCache.data;
  const data = mtime ? fillPlaceholders(JSON.parse(fs.readFileSync(catalogFile, "utf8"))) : seedCatalog();
  catCache = { mtime, data };
  return data;
}

function saveCatalog(data) {
  fs.mkdirSync(path.dirname(catalogFile), { recursive: true });
  fs.writeFileSync(catalogFile + ".tmp", JSON.stringify(data, null, 2));
  fs.renameSync(catalogFile + ".tmp", catalogFile);
  catCache = { mtime: -1, data: null };
}

/* ---------- Supplier: TokoPremium reseller API ---------- */
// Plans linked to a TokoPremium variant (variant.source = { type: "tokopremium", variantId, markup, resellerMarkup })
// take their price and stock live from the supplier:
//   cost  = supplier price (IDR) ÷ SITE.supplierRate (IDR per 1 USD)
//   price = cost × (1 + markup%)          reseller 2+ price = cost × (1 + resellerMarkup%)
// so when the supplier changes its price, ours moves with it. Paid orders are bought from the supplier
// automatically and the returned accounts are delivered to the customer.
const SUP_BASE = (process.env.TOKOPREMIUM_API_BASE || "https://api.tokopremium.digital/api/v1").replace(/\/$/, "");
const supKey = () => process.env.TOKOPREMIUM_API_KEY || "";
let rateCache = { at: 0, rate: null }; // TokoPremium's own USD rate (declared before the startup refresh below)
let supCache = { at: 0, byId: {}, list: [], currency: "IDR", error: "", balance: null, mode: "" };

async function supRequest(method, pathname, body, extraHeaders = {}) {
  if (!supKey()) throw new Error("TokoPremium API key is not set on the server (TOKOPREMIUM_API_KEY).");
  const r = await fetch(SUP_BASE + pathname, {
    method,
    headers: { Authorization: `Bearer ${supKey()}`, ...(body ? { "Content-Type": "application/json" } : {}), ...extraHeaders },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = json.error;
    throw new Error((e && (e.message || e.code)) || (typeof e === "string" && e) || json.message || `Supplier error (HTTP ${r.status})`);
  }
  return json;
}

// Refreshes the supplier catalogue (price + stock). Cached for 55 s unless forced / older than maxAge.
async function refreshSupplier(maxAge = 55_000) {
  await refreshPx(maxAge); // second supplier (PixelSub API), no-op without its key
  if (supKey()) await refreshSupplierRate(); // throttled: at most every 10 min
  if (!supKey() || Date.now() - supCache.at < maxAge) return supCache;
  try {
    const json = await supRequest("GET", "/products");
    const list = Array.isArray(json.products) ? json.products : [];
    supCache = { ...supCache, at: Date.now(), list, byId: Object.fromEntries(list.map((x) => [x.variant_id, x])), currency: json.currency || "IDR", error: "" };
  } catch (e) {
    supCache.error = e.message;
    supCache.at = Date.now() - maxAge + 15_000; // retry in ~15 s
    console.error("Supplier refresh:", e.message);
  }
  return supCache;
}
/* ---------- Supplier #2: PixelSub reseller API (X-API-Key, prices in USD) ----------
   Plans linked to it: variant.source = { type: "pixelsub", variantId: "<productId>", markup, resellerMarkup }
   Env: PIXELSUB_API_KEY, PIXELSUB_API_BASE (default below) */
const PX_BASE = (process.env.PIXELSUB_API_BASE || "https://pixelsub-production-f248.up.railway.app/api/v1").replace(/\/$/, "");
const pxKey = () => process.env.PIXELSUB_API_KEY || "";
let pxCache = { at: 0, byId: {}, list: [], error: "", balance: null };

async function pxRequest(method, pathname, body) {
  if (!pxKey()) throw new Error("PixelSub API key is not set on the server (PIXELSUB_API_KEY).");
  const r = await fetch(PX_BASE + pathname, {
    method,
    headers: { "X-API-Key": pxKey(), ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = json.error;
    throw new Error((e && (e.message || e.code)) || (typeof e === "string" && e) || json.message || `PixelSub API error (HTTP ${r.status})`);
  }
  return json;
}

async function refreshPx(maxAge = 55_000) {
  if (!pxKey() || Date.now() - pxCache.at < maxAge) return pxCache;
  try {
    const json = await pxRequest("GET", "/products");
    const arr = Array.isArray(json) ? json : Array.isArray(json.products) ? json.products : Array.isArray(json.data) ? json.data : [];
    const list = arr.map((x) => ({
      id: String(x.id), name: String(x.name || `Product ${x.id}`), price: Number(x.price) || 0,
      stock: x.stock === null || x.stock === undefined ? null : Math.max(0, Number(x.stock) || 0), // null = unlimited
      inStock: x.inStock !== false,
    }));
    pxCache = { ...pxCache, at: Date.now(), list, byId: Object.fromEntries(list.map((x) => [x.id, x])), error: "" };
  } catch (e) {
    pxCache.error = e.message;
    pxCache.at = Date.now() - maxAge + 15_000;
    console.error("PixelSub API refresh:", e.message);
  }
  return pxCache;
}
if (supKey()) { refreshSupplier(0); setInterval(() => refreshSupplier(), 60_000).unref(); }
else if (pxKey()) { refreshPx(0); setInterval(() => refreshPx(), 60_000).unref(); }
const PX_UNLIMITED = 999; // shown stock for "unlimited" products

function pxQuote(v) {
  const s = pxCache.byId[String(v.source.variantId)];
  if (!s) return null;
  const cost = s.price;
  const price = ceil2(cost * (1 + (Number(v.source.markup) || 0) / 100));
  let bulkPrice = v.source.resellerMarkup === null || v.source.resellerMarkup === undefined || v.source.resellerMarkup === ""
    ? null : ceil2(cost * (1 + Number(v.source.resellerMarkup) / 100));
  if (bulkPrice !== null && bulkPrice >= price) bulkPrice = null;
  const stock = s.inStock ? (s.stock === null ? PX_UNLIMITED : s.stock) : 0;
  return { cost: r4(cost), unitCost: r4(cost), price, bulkPrice, stock, minQty: 1, supplierPrice: s.price, supplierStock: s.stock, available: stock > 0 };
}

const r4 = (n) => Math.round(n * 10000) / 10000;
// How many supplier currency units = 1 USD:
//   - amounts already in USD -> 1
//   - rate mode "auto" (default): the USD rate TokoPremium itself uses for the $ prices on its website
//   - rate mode "manual": SITE.supplierRate typed in the admin panel
async function refreshSupplierRate() {
  if (Date.now() - rateCache.at < 10 * 60_000) return;
  rateCache.at = Date.now() - 9 * 60_000; // on failure retry in ~1 min
  try {
    const site = (process.env.TOKOPREMIUM_SITE || "https://tokopremium.digital/").replace(/\/?$/, "/");
    const html = await (await fetch(site, { signal: AbortSignal.timeout(15_000) })).text();
    const m = html.match(/rates\\?":\s*\[\s*\{\s*\\?"code\\?":\s*\\?"USD\\?"[^}]*?\\?"perUnit\\?":\s*([\d.]+)/);
    const rate = m ? Number(m[1]) : 0;
    if (rate > 1000 && rate < 1_000_000) rateCache = { at: Date.now(), rate };
  } catch (e) { console.error("Supplier rate refresh:", e.message); }
}
const supRate = (SITE, currency = supCache.currency) => {
  if (String(currency || "").toUpperCase() === "USD") return 1;
  if (SITE.supplierRateMode !== "manual" && rateCache.rate) return rateCache.rate;
  return Number(SITE.supplierRate) || rateCache.rate || 17900;
};
const ceil2 = (n) => Math.max(0.01, Math.ceil(Math.round(n * 10000) / 100) / 100);

// Live numbers for one linked plan (null if the supplier hasn't been loaded yet)
function supplierQuote(v, SITE, qty = 1) {
  if (v.source && v.source.type === "pixelsub") return pxQuote(v);
  const s = v.source && supCache.byId[v.source.variantId];
  if (!s) return null;
  const rate = supRate(SITE);
  const unitIDR = s.bulk && qty >= s.bulk.min_qty ? s.bulk.price : s.price;
  const cost = s.price / rate;
  const price = ceil2(cost * (1 + (Number(v.source.markup) || 0) / 100));
  let bulkPrice = v.source.resellerMarkup === null || v.source.resellerMarkup === undefined || v.source.resellerMarkup === ""
    ? null : ceil2(cost * (1 + Number(v.source.resellerMarkup) / 100));
  if (bulkPrice !== null && bulkPrice >= price) bulkPrice = null;
  return {
    cost: r4(cost), unitCost: r4(unitIDR / rate), price, bulkPrice,
    stock: s.available ? Math.max(0, Math.min(Number(s.stock) || 0, Number(s.max_qty) || Infinity)) : 0,
    minQty: Number(s.min_qty) || 1, supplierPrice: s.price, supplierStock: s.stock, available: !!s.available,
  };
}

// Catalogue with supplier-linked plans filled in with live price, stock and cost
function liveCatalog() {
  const cat = catalog();
  const has = cat.PRODUCTS.some((p) => p.variants.some((v) => v.source));
  if (!has) return cat;
  return {
    ...cat,
    PRODUCTS: cat.PRODUCTS.map((p) => ({
      ...p,
      variants: p.variants.map((v) => {
        if (!v.source) return v;
        const q = supplierQuote(v, cat.SITE);
        if (!q) return { ...v, stock: 0, live: { available: false, missing: true } };
        return { ...v, price: q.price, bulkPrice: q.bulkPrice, cost: q.cost, stock: q.stock,
          live: { supplierPrice: q.supplierPrice, supplierStock: q.supplierStock, available: q.available, minQty: q.minQty } };
      }),
    })),
  };
}

function publicDataJs() {
  const { SITE, CATEGORIES, PRODUCTS } = liveCatalog();
  // Never send cost prices, supplier links or supplier settings to the browser
  const products = PRODUCTS.map((p) => ({ ...p, variants: p.variants.map(({ cost, source, live, ...v }) => (source ? { ...v, auto: true } : v)) }));
  const site = Object.fromEntries(Object.entries(SITE).filter(([k]) => !k.startsWith("supplier")));
  return "/* Generated by the server from the admin catalogue. Edit products in /admin.html */\n" +
    `const SITE = ${JSON.stringify(site, null, 2)};\n` +
    `const CATEGORIES = ${JSON.stringify(CATEGORIES)};\n` +
    `const PRODUCTS = ${JSON.stringify(products, null, 2)};\n`;
}

/* ---------- Order storage ---------- */
function loadOrders() {
  try { return JSON.parse(fs.readFileSync(ordersFile, "utf8")); } catch { return []; }
}
function saveOrders(orders) {
  fs.mkdirSync(storeDir, { recursive: true });
  const tmp = ordersFile + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(orders, null, 2));
  fs.renameSync(tmp, ordersFile);
}
// What a customer may see of an order: no cost price, no supplier name/ids/errors.
// waitingAdmin = paid, but delivery is stuck (e.g. supplier problem) until the admin sorts it out.
const publicOrder = (o, keepToken = false) => {
  const { token, ...rest } = o;
  const waitingAdmin = o.status === "processing" && o.items.some((i) => !i.delivered && i.supplierError);
  const expiresAt = o.status === "pending" && !o.payment.verified ? new Date(Date.parse(o.createdAt) + ORDER_TTL).toISOString() : null;
  return {
    ...rest, ...(keepToken ? { token } : {}), waitingAdmin, expiresAt,
    items: o.items.map(({ cost, supplier, supplierError, supplierErrorAt, supplierOrderId, ...i }) => i),
  };
};

/* ---------- Stock & automatic delivery ---------- */
// storage/stock.json: { "<slug>|<pkg>|<duration>": [ { id, data, addedAt } ] } — unsold accounts.
// When an order is paid (status "processing"), each non-manual item takes its accounts from stock
// and the order becomes "delivered". Items without enough stock wait until the admin adds more.
const stockFile = path.join(storeDir, "stock.json");
const loadStock = () => readJson(stockFile, {});
const saveStock = (s) => writeJson(stockFile, s);
const planKey = (slug, v) => `${slug}|${v.pkg}|${v.duration}`;
const findPlan = (PRODUCTS, key) => {
  for (const p of PRODUCTS) for (const v of p.variants) if (planKey(p.slug, v) === key) return { p, v };
  return null;
};
// How many a plan can sell: supplier live stock for linked plans, own stock for automatic plans,
// the typed "stock" number for manual ones. Pass a live-catalogue variant.
const available = (stock, slug, v) => (v.source ? v.stock || 0 : v.manual ? v.stock : (stock[planKey(slug, v)] || []).length);

function stockCounts() {
  const { PRODUCTS } = liveCatalog(), stock = loadStock(), out = {};
  for (const p of PRODUCTS) for (const v of p.variants) if (!v.manual) out[planKey(p.slug, v)] = available(stock, p.slug, v);
  return out;
}

// Marks the order delivered once every item has its accounts (shared by stock and supplier delivery)
function finishDelivery(order, texts) {
  order.delivery = [order.delivery, ...texts].filter(Boolean).join("\n\n");
  if (order.items.every((i) => i.delivered)) {
    order.status = "delivered";
    order.deliveredAt = new Date().toISOString();
    order.autoDelivered = true;
  }
}
const deliveryText = (item) => `${item.name} (${item.plan})\n` + item.delivered.map((d, i) => `${item.qty > 1 ? `#${i + 1}  ` : ""}${d}`).join("\n");

// Buys the order's supplier-linked items from TokoPremium and delivers the returned accounts.
// The Idempotency-Key (order id + line) means a retry can never buy the same line twice.
const supBusy = new Set();
async function supplierDeliver(orderId) {
  if (supBusy.has(orderId)) return null;
  const o = loadOrders().find((x) => x.id === orderId);
  if (!o || o.status !== "processing") return o || null;
  const lines = o.items.map((it, idx) => ({ it, idx })).filter(({ it }) => !it.delivered && it.supplier);
  if (!lines.length) return o;
  supBusy.add(orderId);
  const results = [];
  try {
    for (const { it, idx } of lines) {
      try {
        if (it.supplier.type === "pixelsub") {
          // PixelSub API: POST /orders { productId, quantity, reference } -> order.items[].delivered
          const r = await pxRequest("POST", "/orders", { productId: Number.isNaN(Number(it.supplier.variantId)) ? it.supplier.variantId : Number(it.supplier.variantId), quantity: it.qty, reference: `${o.id}-${idx}` });
          const so = r.order || r;
          const accounts = (Array.isArray(so.items) ? so.items : []).flatMap((x) => Array.isArray(x.delivered) ? x.delivered : typeof x.delivered === "string" ? x.delivered.split(/\r?\n/) : [])
            .map((x) => String(x).trim()).filter(Boolean);
          if (accounts.length < it.qty) throw new Error(`PixelSub order ${so.id || ""} returned ${accounts.length} of ${it.qty} account(s) — retry later.`);
          results.push({ idx, accounts: accounts.slice(0, it.qty), supplierOrderId: so.id });
          continue;
        }
        const r = await supRequest("POST", "/orders", { variant_id: it.supplier.variantId, qty: it.qty }, { "Idempotency-Key": `${o.id}-${idx}` });
        const so = r.order || {};
        const accounts = Array.isArray(so.accounts) ? so.accounts.map(String) : [];
        if (accounts.length < it.qty) throw new Error(`Supplier order ${so.id || ""} is "${so.status || "unknown"}" without accounts yet — retry later.`);
        if (typeof r.balance === "number") supCache.balance = r.balance;
        results.push({ idx, accounts: accounts.slice(0, it.qty), supplierOrderId: so.id, totalIDR: so.total, currency: so.currency });
      } catch (e) {
        results.push({ idx, error: e.message });
      }
    }
  } finally {
    supBusy.delete(orderId);
  }
  // Write the results back (re-read so nothing else is overwritten)
  const { SITE } = catalog();
  const orders = loadOrders();
  const cur = orders.find((x) => x.id === orderId);
  if (!cur) return null;
  const texts = [];
  for (const r of results) {
    const item = cur.items[r.idx];
    if (r.error) {
      item.supplierError = r.error;
      item.supplierErrorAt = new Date().toISOString();
      console.error(`Supplier order failed for ${orderId} line ${r.idx}: ${r.error}`);
      continue;
    }
    item.delivered = r.accounts;
    item.deliveredAt = new Date().toISOString();
    item.supplierOrderId = r.supplierOrderId;
    delete item.supplierError; delete item.supplierErrorAt;
    if (typeof r.totalIDR === "number") item.cost = r4(r.totalIDR / supRate(SITE, r.currency) / item.qty); // real buying price in USD
    texts.push(deliveryText(item));
  }
  if (texts.length) finishDelivery(cur, texts);
  saveOrders(orders);
  if (texts.length) console.log(`Supplier delivered ${texts.length} item(s) for ${orderId}`);
  return cur;
}

// After a supplier hiccup: retry all paid orders still waiting on supplier items
async function retrySupplierOrders({ onlyStale = false } = {}) {
  const stale = Date.now() - 50_000; // auto mode: skip lines that failed less than 50 s ago
  const ids = loadOrders().filter((o) => o.status === "processing" &&
    o.items.some((i) => i.supplier && !i.delivered && (!onlyStale || !i.supplierErrorAt || new Date(i.supplierErrorAt).getTime() < stale))).map((o) => o.id);
  for (const id of ids) await supplierDeliver(id);
  return ids.length;
}
// Paid orders stuck on a supplier problem (e.g. empty TokoPremium balance) are retried every minute,
// so they deliver by themselves as soon as the balance is topped up or stock is back.
let autoRetryRunning = false;
if (supKey() || pxKey()) setInterval(async () => {
  if (autoRetryRunning) return;
  autoRetryRunning = true;
  try { await retrySupplierOrders({ onlyStale: true }); } catch (e) { console.error("Supplier auto-retry:", e.message); }
  autoRetryRunning = false;
}, 60_000).unref();

// Synchronous: takes accounts from stock and writes them into the order. Caller saves the order.
function autoDeliver(order) {
  if (order.status !== "processing") return false;
  const { PRODUCTS } = catalog();
  const stock = loadStock();
  const texts = [];
  for (const item of order.items) {
    if (item.delivered || !item.key || item.supplier) continue; // supplier items are bought by supplierDeliver()
    const plan = findPlan(PRODUCTS, item.key);
    if (!plan || plan.v.manual || plan.v.source) continue;
    const list = stock[item.key] || [];
    if (list.length < item.qty) continue; // wait for the admin to add stock
    const taken = list.splice(0, item.qty);
    item.delivered = taken.map((x) => x.data);
    item.deliveredAt = new Date().toISOString();
    texts.push(deliveryText(item));
  }
  if (!texts.length) return false;
  saveStock(stock);
  finishDelivery(order, texts);
  console.log(`Auto-delivered ${texts.length} item(s) for ${order.id}`);
  return true;
}

// After stock is added: deliver paid orders that were waiting (oldest first)
function deliverWaitingOrders() {
  const orders = loadOrders();
  let n = 0;
  for (const o of [...orders].reverse()) if (o.status === "processing" && autoDeliver(o)) n++;
  if (n) saveOrders(orders);
  return n;
}

/* ---------- Reseller wallet ---------- */
// Balance lives on the user (users.json). Every change is written to the ledger (wallet.json).
// Top-up requests live in topups.json. All balance changes happen synchronously (no await in between
// read and write), so two requests can never spend the same money.
const topupsFile = path.join(storeDir, "topups.json");
const ledgerFile = path.join(storeDir, "wallet.json");
const loadTopups = () => readJson(topupsFile, []);
const saveTopups = (t) => writeJson(topupsFile, t);
// Order IDs customers can read out: PS- + 8 random digits (random, so they don't reveal how many orders exist)
function newOrderId() {
  const used = new Set(loadOrders().map((o) => o.id));
  let id;
  do id = "PS-" + crypto.randomInt(10_000_000, 100_000_000); while (used.has(id));
  return id;
}
const newId = (prefix) => prefix + Date.now().toString(36).toUpperCase() + crypto.randomBytes(2).toString("hex").toUpperCase();

function walletApply(username, amount, type, note, ref) {
  const users = readJson(usersFile, []);
  const u = users.find((x) => x.username === username);
  if (!u) throw new Error("Account not found.");
  const before = u.balance || 0;
  const after = Math.round((before + amount) * 100) / 100;
  if (after < 0) throw new Error("Not enough balance.");
  u.balance = after;
  writeJson(usersFile, users);
  const ledger = readJson(ledgerFile, []);
  ledger.unshift({ id: newId("TX"), username, type, amount, balanceAfter: after, note, ref, createdAt: new Date().toISOString() });
  writeJson(ledgerFile, ledger);
  return after;
}

// Marks a pending top-up as completed and credits the balance (once)
function completeTopup(id, by) {
  const topups = loadTopups();
  const t = topups.find((x) => x.id === id);
  if (!t || t.status !== "pending") return t;
  t.status = "completed";
  t.completedAt = new Date().toISOString();
  t.completedBy = by;
  saveTopups(topups);
  walletApply(t.username, t.amount, "topup", `Balance added via ${t.payment.method}`, t.id);
  console.log(`Top-up ${t.id}: +${t.amount} to ${t.username} (${by})`);
  return t;
}

async function verifyTopup(id) {
  const t = loadTopups().find((x) => x.id === id);
  if (!t || !t.payment.auto || t.status !== "pending") return t;
  await tryVerify(t);
  // Re-read after the await and save only this top-up's payment info
  const topups = loadTopups();
  const cur = topups.find((x) => x.id === id);
  cur.payment = t.payment;
  saveTopups(topups);
  if (t.payment.verified && cur.status === "pending") return completeTopup(id, t.payment.provider);
  return cur;
}

/* ---------- Helpers ---------- */
function send(res, code, data) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
}
function readBody(req, max = 200_000) {
  return new Promise((resolve, reject) => {
    let size = 0, chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > max) { reject(new Error("Body too large")); req.destroy(); }
      else chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch { reject(new Error("Invalid JSON")); }
    });
  });
}
const str = (v, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const r2 = (n) => Math.round(n * 100) / 100; // money is USD with cents
const isAdmin = (req) => {
  const k = Buffer.from(String(req.headers["x-admin-key"] || ""));
  const a = Buffer.from(ADMIN_KEY);
  return k.length === a.length && crypto.timingSafeEqual(k, a);
};

/* ---------- Reseller accounts & sessions ---------- */
// Anyone who signs up is a reseller and gets the 2+ price. Guests can order at the 1 pc price.
const usersFile = path.join(storeDir, "users.json");
const sessionsFile = path.join(storeDir, "sessions.json");
const SESSION_DAYS = 30;

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
const writeJson = (f, data) => {
  fs.mkdirSync(storeDir, { recursive: true });
  fs.writeFileSync(f + ".tmp", JSON.stringify(data, null, 2));
  fs.renameSync(f + ".tmp", f);
};
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const hashPassword = (pw, salt = crypto.randomBytes(16).toString("hex")) =>
  ({ salt, hash: crypto.scryptSync(pw, salt, 64).toString("hex") });
const checkPassword = (pw, u) => {
  const a = Buffer.from(hashPassword(pw, u.salt).hash, "hex"), b = Buffer.from(u.hash, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

function cookies(req) {
  return Object.fromEntries((req.headers.cookie || "").split(";").map((c) => c.trim().split("=")).filter((x) => x[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join("="))]));
}
function sessionUser(req) {
  const t = cookies(req).ps_session;
  if (!t) return null;
  const s = readJson(sessionsFile, {})[sha256(t)];
  if (!s || s.exp < Date.now()) return null;
  const u = readJson(usersFile, []).find((x) => x.username === s.username);
  return u && !u.disabled ? u : null;
}
function startSession(req, res, username) {
  const token = crypto.randomBytes(32).toString("hex");
  const sessions = readJson(sessionsFile, {});
  for (const [k, s] of Object.entries(sessions)) if (s.exp < Date.now()) delete sessions[k];
  sessions[sha256(token)] = { username, exp: Date.now() + SESSION_DAYS * 864e5 };
  writeJson(sessionsFile, sessions);
  const secure = req.headers["x-forwarded-proto"] === "https" || req.socket.encrypted ? "; Secure" : "";
  res.setHeader("Set-Cookie", `ps_session=${token}; HttpOnly; Path=/; Max-Age=${SESSION_DAYS * 86400}; SameSite=Lax${secure}`);
}
const publicUser = (u) => ({
  username: u.username, status: userStatus(u), reseller: isReseller(u), balance: u.balance || 0, createdAt: u.createdAt,
  application: u.application ? { type: u.application.type, link: u.application.link, note: u.application.note || "", contact: u.application.contact || "",
    submittedAt: u.application.submittedAt, rejectNote: u.rejectNote || "" } : null,
});
// Simple brute-force protection: 10 failed logins per IP per 15 minutes
const attempts = new Map();
const ipOf = (req) => String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
function tooManyAttempts(req) {
  const a = attempts.get(ipOf(req));
  return a && a.count >= 10 && Date.now() - a.first < 15 * 60_000;
}
function failedAttempt(req) {
  const ip = ipOf(req), a = attempts.get(ip);
  if (!a || Date.now() - a.first > 15 * 60_000) attempts.set(ip, { count: 1, first: Date.now() });
  else a.count++;
}

/* ---------- Reseller applications ---------- */
// Anyone can create an account, but it only becomes a reseller (reseller price + wallet) after the admin
// approves the application. Accounts created before this feature (no status) count as approved.
const userStatus = (u) => u.status || "approved";
const isReseller = (u) => !!u && !u.disabled && userStatus(u) === "approved";
const APP_TYPES = { website: "Website / online store", bot: "Telegram / WhatsApp bot", other: "Facebook page / group / other" };

function cleanStoreLink(raw, type) {
  let s = String(raw || "").trim();
  if (type === "bot" && /^@?[A-Za-z0-9_]{4,32}$/.test(s)) s = "https://t.me/" + s.replace(/^@/, "");
  if (s.length > 300) return null;
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (!/^https?:$/.test(u.protocol) || !u.hostname.includes(".") || u.username || u.password) return null;
  return u.toString();
}
const linkKey = (link) => { const u = new URL(link); return (u.hostname.replace(/^www\./, "") + u.pathname.replace(/\/+$/, "")).toLowerCase(); };

// Validates the "where do you sell" part of an application. Returns { application } or { error }.
function parseApplication(body, users, exceptUsername) {
  const type = APP_TYPES[body.type] ? body.type : null;
  if (!type) return { error: "Choose where you sell." };
  const link = cleanStoreLink(body.link, type);
  if (!link) return { error: type === "bot" ? "Enter your bot link (e.g. https://t.me/yourbot) or its @username." : "Enter a valid link to your website or page (https://…)." };
  const key = linkKey(link);
  if (users.some((x) => x.username !== exceptUsername && x.application && x.application.linkKey === key && userStatus(x) !== "rejected")) {
    return { error: "This link is already used by another reseller application." };
  }
  return { application: { type, link, linkKey: key, note: str(body.note, 500), contact: str(body.contact, 80), submittedAt: new Date().toISOString() } };
}

const signupHits = new Map(); // ip -> { n, at }: at most 10 sign-ups per IP per hour
function signupLimited(req) {
  const ip = ipOf(req), h = signupHits.get(ip);
  if (!h || Date.now() - h.at > 3600_000) { signupHits.set(ip, { n: 1, at: Date.now() }); return false; }
  return ++h.n > 10;
}

async function signup(req, res) {
  const body = await readBody(req);
  const username = str(body.username, 30).toLowerCase();
  const password = typeof body.password === "string" ? body.password : "";
  if (!/^[a-z0-9_.]{3,30}$/.test(username)) return send(res, 400, { error: "Username: 3–30 letters, numbers, _ or ." });
  if (password.length < 6 || password.length > 200) return send(res, 400, { error: "Password must be at least 6 characters." });
  if (tooManyAttempts(req) || signupLimited(req)) return send(res, 429, { error: "Too many attempts. Try again later." });
  const users = readJson(usersFile, []);
  if (users.some((u) => u.username === username)) return send(res, 400, { error: "This username is taken." });
  const app = parseApplication(body, users, null);
  if (app.error) return send(res, 400, { error: app.error });
  const u = { username, ...hashPassword(password), createdAt: new Date().toISOString(), status: "pending", application: app.application };
  users.push(u);
  writeJson(usersFile, users);
  startSession(req, res, username);
  console.log(`New reseller application: ${username} (${app.application.type}: ${app.application.link})`);
  send(res, 201, publicUser(u));
}

// Applicant fixes/changes the store link (after a rejection, or while waiting)
async function applyAgain(req, res) {
  const u0 = sessionUser(req);
  if (!u0) return send(res, 401, { error: "Please log in." });
  if (isReseller(u0)) return send(res, 400, { error: "You are already an approved reseller." });
  const body = await readBody(req);
  const users = readJson(usersFile, []);
  const u = users.find((x) => x.username === u0.username);
  const app = parseApplication(body, users, u.username);
  if (app.error) return send(res, 400, { error: app.error });
  u.application = app.application; u.status = "pending"; delete u.rejectNote;
  writeJson(usersFile, users);
  console.log(`Reseller application re-submitted: ${u.username}`);
  send(res, 200, publicUser(u));
}

async function adminReviewApplication(req, res, username) {
  const body = await readBody(req);
  const users = readJson(usersFile, []);
  const u = users.find((x) => x.username === username);
  if (!u) return send(res, 404, { error: "Account not found." });
  if (body.action === "approve") { u.status = "approved"; delete u.rejectNote; u.approvedAt = new Date().toISOString(); }
  else if (body.action === "reject") { u.status = "rejected"; u.rejectNote = str(body.note, 300); u.reviewedAt = new Date().toISOString(); }
  else return send(res, 400, { error: "Unknown action." });
  writeJson(usersFile, users);
  console.log(`Reseller ${body.action}: ${username}`);
  send(res, 200, publicUser(u));
}

async function login(req, res) {
  const body = await readBody(req);
  if (tooManyAttempts(req)) return send(res, 429, { error: "Too many attempts. Try again in 15 minutes." });
  const username = str(body.username, 30).toLowerCase();
  const u = readJson(usersFile, []).find((x) => x.username === username);
  if (!u || u.disabled || !checkPassword(String(body.password || ""), u)) {
    failedAttempt(req);
    return send(res, 401, { error: "Wrong username or password." });
  }
  startSession(req, res, username);
  send(res, 200, publicUser(u));
}

function logout(req, res) {
  const t = cookies(req).ps_session;
  if (t) {
    const sessions = readJson(sessionsFile, {});
    delete sessions[sha256(t)];
    writeJson(sessionsFile, sessions);
  }
  res.setHeader("Set-Cookie", "ps_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax");
  send(res, 200, { ok: true });
}

/* ---------- API ---------- */
async function createOrder(req, res) {
  const body = await readBody(req, 3_000_000); // room for a payment screenshot
  // Supplier-linked items: make sure price & stock are fresh (≤ 30 s old) before pricing the order
  if (Array.isArray(body.items) && catalog().PRODUCTS.some((p) => body.items.some((it) => it && it.slug === p.slug && p.variants[it.vi] && p.variants[it.vi].source))) {
    await refreshSupplier(30_000);
  }
  const { SITE, PRODUCTS } = liveCatalog();
  const bulkMin = SITE.bulkMinQty || 2;
  const user = sessionUser(req);

  const reseller = isReseller(user);
  const customer = user ? { username: user.username, reseller } : { guest: true };
  const payment = {
    method: str(body.pay, 40),
    sender: str(body.sender, 40),
    trx: str(body.trx, 60),
  };
  const useBalance = payment.method === "Balance";
  if (useBalance && !user) return send(res, 401, { error: "Log in to pay with your balance." });
  if (useBalance && !reseller) return send(res, 403, { error: "Paying from balance is for approved resellers." });
  if (!useBalance && !SITE.payments.includes(payment.method)) return send(res, 400, { error: "Choose a payment method." });
  const info = (SITE.paymentInfo || {})[payment.method] || {};
  if (!useBalance && !info.redirect && !payment.trx) return send(res, 400, { error: "Transaction ID is required." });
  if (useBalance || info.redirect) { payment.trx = ""; payment.sender = ""; }
  if (PROOF_PROVIDERS.includes(info.provider)) payment.sender = ""; // Binance: the Order ID alone is enough
  if (!Array.isArray(body.items) || !body.items.length || body.items.length > 50) return send(res, 400, { error: "Your cart is empty." });

  // Prices are always recalculated here; the browser's numbers are never trusted.
  const items = [];
  const stock = loadStock();
  for (const it of body.items) {
    const p = PRODUCTS.find((x) => x.slug === it.slug);
    const v = p && p.variants[it.vi];
    const qty = Number.parseInt(it.qty, 10);
    if (!v || !Number.isInteger(qty) || qty < 1) return send(res, 400, { error: "A product in your cart is no longer available." });
    const left = available(stock, p.slug, v);
    if (qty > left) return send(res, 400, { error: left ? `${p.name} (${v.pkg} – ${v.duration}) only has ${left} left.` : `${p.name} (${v.pkg} – ${v.duration}) is out of stock.` });
    const quote = v.source ? supplierQuote(v, SITE, qty) : null;
    if (v.source && !quote) return send(res, 503, { error: `${p.name} is temporarily unavailable. Please try again in a minute.` });
    if (quote && qty < quote.minQty) return send(res, 400, { error: `${p.name} (${v.pkg} – ${v.duration}): minimum ${quote.minQty} per order.` });
    const bulk = reseller && v.bulkPrice != null && v.bulkPrice < v.price && qty >= bulkMin;
    const unit = bulk ? v.bulkPrice : v.price;
    items.push({ slug: p.slug, key: planKey(p.slug, v), name: p.name, plan: `${v.pkg} – ${v.duration}`, qty, unit, regular: v.price, total: r2(unit * qty),
      cost: quote ? quote.unitCost : v.cost ?? null, // cost price at the time of sale, for profit reports (never shown to customers)
      ...(v.source ? { supplier: { type: v.source.type, variantId: v.source.variantId } } : {}) });
  }
  const total = r2(items.reduce((a, i) => a + i.total, 0));
  const regular = r2(items.reduce((a, i) => a + i.regular * i.qty, 0));
  if (info.provider) {
    payment.auto = true;
    payment.provider = info.provider;
    payment.amountUsdt = total; // prices are USD, paid 1:1 in USDT
  }

  if (payment.trx && trxUsed(payment.trx)) {
    return send(res, 400, { error: "This Transaction ID was already used." });
  }
  const order = {
    id: newOrderId(),
    token: crypto.randomBytes(16).toString("hex"),
    createdAt: new Date().toISOString(),
    status: "pending",
    currency: SITE.currency,
    items, total, discount: r2(regular - total),
    customer, payment,
    delivery: "",
  };
  if (useBalance) {
    // Deduct first (throws if the balance is too low), then save the order — no await in between.
    try { walletApply(user.username, -total, "order", `Order ${order.id}`, order.id); }
    catch (e) { return send(res, 400, { error: e.message }); }
    payment.verified = true;
    payment.verifiedAt = order.createdAt;
    payment.verifyNote = "Paid from balance.";
    order.status = "processing";
  }
  if (info.redirect) {
    try { await createInvoice(order, req, `/order.html?id=${order.id}&t=${order.token}`, ORDER_TTL / 1000); }
    catch (e) { console.error(e.message); return send(res, 502, { error: "Could not start the Cryptomus payment. Please try another method." }); }
  } else if (payment.auto) {
    await tryVerify(order);
  }
  autoDeliver(order); // paid already (balance / Binance / Bybit) -> hand over the accounts now
  const orders = loadOrders(); // read after any await so concurrent orders aren't lost
  orders.unshift(order);
  saveOrders(orders);
  console.log(`New order ${order.id}: ${SITE.currency}${total} via ${payment.method}${payment.verified ? " (verified)" : ""}`);
  if (order.status === "processing") await supplierDeliver(order.id); // buy supplier items now so the customer gets them instantly
  send(res, 201, { id: order.id, token: order.token, verified: !!payment.verified, payUrl: payment.payUrl });
}

// Customer asks to re-check a payment (limited to once every 15 s per order)
async function customerVerify(req, res, id, token) {
  const orders = loadOrders();
  const o = orders.find((x) => x.id === id);
  if (!o || !token || o.token !== token) return send(res, 404, { error: "Order not found." });
  if (!o.payment.auto) return send(res, 400, { error: "This order is verified manually by the admin." });
  if (o.payment.verified) return send(res, 200, publicOrder(o));
  const wait = 15_000 - (Date.now() - (o.payment.lastCheck || 0));
  if (wait > 0) return send(res, 429, { error: `Please wait ${Math.ceil(wait / 1000)} s before checking again.` });
  send(res, 200, publicOrder(await verifyOrder(id)));
}

// Re-check an order's payment and save only that order's payment/status.
// reopen: a late payment on an order that expired unpaid still counts (e.g. a Cryptomus webhook).
async function verifyOrder(id, { reopen = false } = {}) {
  const o = loadOrders().find((x) => x.id === id);
  await tryVerify(o);
  const orders = loadOrders();
  const cur = orders.find((x) => x.id === id);
  cur.payment = o.payment;
  if (o.payment.verified && (cur.status === "pending" || (reopen && cur.status === "cancelled" && cur.expired))) {
    cur.status = "processing";
    if (cur.expired) { delete cur.expired; delete cur.cancelledAt; delete cur.cancelReason; }
  }
  autoDeliver(cur);
  saveOrders(orders);
  if (cur.status === "processing") return (await supplierDeliver(id)) || cur;
  return cur;
}

/* ---------- Unpaid orders: cancel & 20-minute expiry ---------- */
const ORDER_TTL = 20 * 60_000;
const isOpenUnpaid = (o) => o && o.status === "pending" && !o.payment.verified;
const isOverdue = (o) => isOpenUnpaid(o) && Date.now() - Date.parse(o.createdAt) >= ORDER_TTL;

// Cancels an unpaid order after one last payment check, so a paid order is never cancelled.
// Returns the order as saved.
async function cancelUnpaid(id, reason, { expired = false } = {}) {
  let o = loadOrders().find((x) => x.id === id);
  if (!isOpenUnpaid(o)) return o;
  if (o.payment.auto) {
    o = await verifyOrder(id);
    if (!isOpenUnpaid(o)) return o;
    if (expired && o.payment.inProgress) return o; // Cryptomus is still confirming a payment
  }
  const orders = loadOrders();
  const cur = orders.find((x) => x.id === id);
  if (!isOpenUnpaid(cur)) return cur;
  cur.status = "cancelled";
  cur.cancelledAt = new Date().toISOString();
  cur.cancelReason = reason;
  if (expired) cur.expired = true;
  saveOrders(orders);
  console.log(`Order ${id} cancelled: ${reason}`);
  return cur;
}

async function customerCancel(req, res, id, token) {
  const o = loadOrders().find((x) => x.id === id);
  if (!o || !token || o.token !== token) return send(res, 404, { error: "Order not found." });
  if (!isOpenUnpaid(o)) return send(res, 400, { error: "This order can't be cancelled — its payment is already confirmed or it was closed." });
  const cur = await cancelUnpaid(id, "Cancelled by the customer.");
  if (cur.status !== "cancelled") return send(res, 409, { ...publicOrder(cur), error: "Your payment was just confirmed, so the order was not cancelled." });
  send(res, 200, publicOrder(cur));
}

// Every minute: re-check unpaid orders automatically, and cancel those still unpaid after 20 minutes.
let unpaidSweepRunning = false;
async function sweepUnpaid() {
  if (unpaidSweepRunning) return;
  unpaidSweepRunning = true;
  try {
    for (const o of loadOrders().filter(isOpenUnpaid)) {
      try {
        if (isOverdue(o)) await cancelUnpaid(o.id, "Expired — payment was not confirmed within 20 minutes.", { expired: true });
        else if (o.payment.auto && Date.now() - (o.payment.lastCheck || 0) >= 55_000) await verifyOrder(o.id);
      } catch (e) { console.error(`Unpaid order check ${o.id}:`, e.message); }
    }
  } finally { unpaidSweepRunning = false; }
}
setInterval(sweepUnpaid, 60_000).unref();

/* ---------- Wallet API ---------- */
function walletInfo(req, res) {
  const u = sessionUser(req);
  if (!u) return send(res, 401, { error: "Please log in." });
  if (!isReseller(u)) return send(res, 403, { error: "Your reseller application is not approved yet." });
  const orders = loadOrders().filter((o) => o.customer.username === u.username);
  send(res, 200, {
    balance: u.balance || 0,
    ledger: readJson(ledgerFile, []).filter((x) => x.username === u.username).slice(0, 200),
    topups: loadTopups().filter((x) => x.username === u.username).slice(0, 100),
    stats: {
      orders: orders.length,
      spent: r2(orders.filter((o) => o.status !== "cancelled").reduce((a, o) => a + o.total, 0)),
      saved: r2(orders.filter((o) => o.status !== "cancelled").reduce((a, o) => a + (o.discount || 0), 0)),
    },
  });
}

async function createTopup(req, res) {
  const u = sessionUser(req);
  if (!u) return send(res, 401, { error: "Please log in." });
  if (!isReseller(u)) return send(res, 403, { error: "Your reseller application is not approved yet." });
  const body = await readBody(req, 3_000_000); // room for a payment screenshot
  const { SITE } = catalog();
  const amount = r2(Number(body.amount));
  const min = SITE.topupMin || 1, max = SITE.topupMax || 1000;
  if (!Number.isFinite(amount) || amount < min || amount > max) return send(res, 400, { error: `Amount must be between ${SITE.currency}${min} and ${SITE.currency}${max}.` });
  const payment = { method: str(body.pay, 40), sender: str(body.sender, 40), trx: str(body.trx, 60) };
  if (!SITE.payments.includes(payment.method)) return send(res, 400, { error: "Choose a payment method." });
  const info = (SITE.paymentInfo || {})[payment.method] || {};
  if (info.redirect) { payment.trx = ""; payment.sender = ""; }
  else if (!payment.trx) return send(res, 400, { error: "Transaction ID is required." });
  if (payment.trx && trxUsed(payment.trx)) return send(res, 400, { error: "This Transaction ID was already used." });
  if (PROOF_PROVIDERS.includes(info.provider)) payment.sender = "";
  if (info.provider) {
    payment.auto = true;
    payment.provider = info.provider;
    payment.amountUsdt = amount;
  }
  const t = { id: newId("TU"), username: u.username, amount, status: "pending", payment, createdAt: new Date().toISOString() };
  if (info.redirect) {
    try { await createInvoice(t, req, "/account.html#add"); }
    catch (e) { console.error(e.message); return send(res, 502, { error: "Could not start the Cryptomus payment. Please try another method." }); }
  }
  const topups = loadTopups();
  topups.unshift(t);
  saveTopups(topups);
  console.log(`Top-up request ${t.id}: ${u.username} ${SITE.currency}${amount} via ${payment.method}`);
  send(res, 201, payment.auto && !info.redirect ? await verifyTopup(t.id) : t);
}

// Cryptomus calls this when an invoice status changes. We check the signature, then re-confirm
// the payment with Cryptomus before marking anything as paid.
async function cryptomusWebhook(req, res) {
  const data = await readBody(req);
  if (!cryptomusWebhookValid(data)) return send(res, 401, { error: "Bad signature" });
  const id = String(data.order_id || "");
  if (id.startsWith("TU")) await verifyTopup(id);
  else if (loadOrders().some((o) => o.id === id && (o.status === "pending" || (o.status === "cancelled" && o.expired)))) await verifyOrder(id, { reopen: true });
  send(res, 200, { ok: true });
}

async function userVerifyTopup(req, res, id) {
  const u = sessionUser(req);
  if (!u) return send(res, 401, { error: "Please log in." });
  if (!isReseller(u)) return send(res, 403, { error: "Your reseller application is not approved yet." });
  const t = loadTopups().find((x) => x.id === id && x.username === u.username);
  if (!t) return send(res, 404, { error: "Top-up not found." });
  if (!t.payment.auto || t.status !== "pending") return send(res, 200, t);
  const wait = 15_000 - (Date.now() - (t.payment.lastCheck || 0));
  if (wait > 0) return send(res, 429, { error: `Please wait ${Math.ceil(wait / 1000)} s before checking again.` });
  send(res, 200, await verifyTopup(id));
}

async function changePassword(req, res) {
  const u = sessionUser(req);
  if (!u) return send(res, 401, { error: "Please log in." });
  const body = await readBody(req);
  if (tooManyAttempts(req)) return send(res, 429, { error: "Too many attempts. Try again in 15 minutes." });
  if (!checkPassword(String(body.current || ""), u)) { failedAttempt(req); return send(res, 400, { error: "Current password is wrong." }); }
  const next = typeof body.next === "string" ? body.next : "";
  if (next.length < 6 || next.length > 200) return send(res, 400, { error: "New password must be at least 6 characters." });
  const users = readJson(usersFile, []);
  Object.assign(users.find((x) => x.username === u.username), hashPassword(next));
  writeJson(usersFile, users);
  send(res, 200, { ok: true });
}

async function getOrder(req, res, id, token) {
  let o = loadOrders().find((x) => x.id === id);
  if (!o || !token || o.token !== token) return send(res, 404, { error: "Order not found." });
  if (isOverdue(o)) o = await cancelUnpaid(id, "Expired — payment was not confirmed within 20 minutes.", { expired: true });
  send(res, 200, publicOrder(o));
}

async function adminUpdate(req, res, id) {
  const body = await readBody(req);
  const orders = loadOrders();
  const o = orders.find((x) => x.id === id);
  if (!o) return send(res, 404, { error: "Order not found." });
  if (body.status !== undefined && !STATUSES.includes(body.status)) return send(res, 400, { error: "Invalid status." });
  if (o.refunded && body.status && body.status !== "cancelled") return send(res, 400, { error: "This order was refunded to the reseller's balance and can't be reopened." });
  if (body.delivery !== undefined) o.delivery = str(body.delivery, 4000);
  let warning = "";

  if (body.status === "processing" || body.status === "delivered") {
    // Admin approved the order: count it as paid, then hand over accounts from stock
    if (!o.payment.verified) {
      o.payment.verified = true;
      o.payment.verifiedAt = new Date().toISOString();
      o.payment.verifyNote = "Approved by admin.";
      o.payment.approvedByAdmin = true;
    }
    // Also covers orders marked "Delivered" earlier without their accounts
    const hadText = o.status === "delivered" && o.delivery.trim();
    if (!hadText && o.items.some((i) => !i.delivered)) o.status = "processing";
    autoDeliver(o);
    o.updatedAt = new Date().toISOString();
    saveOrders(orders);
    // Supplier items: buy them now
    await supplierDeliver(id);
    const fresh = loadOrders();
    const cur = fresh.find((x) => x.id === id);
    const missing = cur.items.filter((i) => !i.delivered);
    if (cur.status !== "delivered" && body.status === "delivered") {
      if (cur.delivery.trim() && !missing.some((i) => i.supplier)) {
        // Remaining items (manual plans / no stock) were delivered by the admin's own text
        cur.status = "delivered";
        cur.deliveredAt = new Date().toISOString();
        saveOrders(fresh);
      } else {
        const sup = missing.filter((i) => i.supplier), own = missing.filter((i) => !i.supplier);
        warning = "Not delivered yet: " + [
          own.length ? `no stock for ${own.map((i) => `${i.name} (${i.plan}) ×${i.qty}`).join(", ")} — add stock (it delivers automatically) or type the details` : "",
          sup.length ? `TokoPremium order failed for ${sup.map((i) => `${i.name} (${i.plan})`).join(", ")}: ${sup.map((i) => i.supplierError || "no response").join("; ")} — fix it (e.g. top up your TokoPremium balance) and press Retry` : "",
        ].filter(Boolean).join(". ") + ".";
      }
    }
    return send(res, 200, { ...cur, warning });
  } else if (body.status !== undefined) {
    o.status = body.status;
    // Cancelling an order paid from balance gives the money back (once)
    if (o.status === "cancelled" && o.payment.method === "Balance" && !o.refunded) {
      walletApply(o.customer.username, o.total, "refund", `Refund for cancelled order ${o.id}`, o.id);
      o.refunded = true;
    }
  }
  o.updatedAt = new Date().toISOString();
  saveOrders(orders);
  send(res, 200, { ...o, warning });
}

// Permanently delete an order (e.g. test orders). Options:
//   restock: put accounts this order took from stock back at the front of the stock list
//   refund:  give the money back to the reseller's balance if it was paid from balance
// A copy of the deleted order is kept in storage/deleted-orders.json.
async function adminDeleteOrder(req, res, id) {
  const body = await readBody(req);
  const orders = loadOrders();
  const i = orders.findIndex((x) => x.id === id);
  if (i < 0) return send(res, 404, { error: "Order not found." });
  const o = orders[i];
  let restocked = 0, refunded = 0;

  if (body.refund && o.payment.method === "Balance" && !o.refunded && o.customer.username) {
    walletApply(o.customer.username, o.total, "refund", `Refund for deleted order ${o.id}`, o.id);
    refunded = o.total;
  }
  if (body.restock) {
    const stock = loadStock();
    for (const it of o.items) {
      if (!Array.isArray(it.delivered) || !it.key) continue;
      const list = (stock[it.key] = stock[it.key] || []);
      const have = new Set(list.map((x) => x.data));
      const back = it.delivered.filter((d) => !have.has(d)).map((data) => ({ id: newId("ST"), data, addedAt: new Date().toISOString(), returnedFrom: o.id }));
      list.unshift(...back);
      restocked += back.length;
    }
    if (restocked) saveStock(stock);
  }

  orders.splice(i, 1);
  saveOrders(orders);
  const log = readJson(path.join(storeDir, "deleted-orders.json"), []);
  log.unshift({ ...o, deletedAt: new Date().toISOString(), restocked, refunded });
  writeJson(path.join(storeDir, "deleted-orders.json"), log.slice(0, 500));
  console.log(`Deleted order ${o.id} (restocked ${restocked}, refunded ${refunded})`);
  send(res, 200, { ok: true, restocked, refunded });
}

/* ---------- Admin: products, settings, uploads ---------- */
const num = (v) => (v === "" || v === null || v === undefined ? null : Number(v));

// Validates a product from the admin editor. Returns { product } or { error }.
function cleanProduct(b, CATEGORIES) {
  const name = str(b.name, 80);
  const slug = str(b.slug, 60).toLowerCase();
  if (!name) return { error: "Product name is required." };
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) return { error: "Slug: lowercase letters, numbers and dashes only (e.g. netflix-premium)." };
  if (!CATEGORIES.includes(b.category)) return { error: "Choose a category." };
  const image = str(b.image, 200);
  if (image && (!/^assets\/img\/[\w\-./]+\.(png|jpe?g|webp|gif)$/i.test(image) || image.includes(".."))) return { error: "Invalid image path." };
  const color = str(b.color, 9) || "#2563eb";
  if (!/^#[0-9a-f]{3,8}$/i.test(color)) return { error: "Color must be a hex code like #E50914." };
  if (!Array.isArray(b.variants) || !b.variants.length || b.variants.length > 30) return { error: "Add at least one plan." };
  const seen = new Set(), variants = [];
  for (const [i, x] of b.variants.entries()) {
    const n = `Plan ${i + 1}`;
    const v = {
      pkg: str(x.pkg, 50), duration: str(x.duration, 40),
      cost: num(x.cost), price: num(x.price), bulkPrice: num(x.bulkPrice),
      warranty: str(x.warranty, 40) || "—",
    };
    if (!v.pkg || !v.duration) return { error: `${n}: package and duration are required.` };
    if (seen.has(v.pkg + "|" + v.duration)) return { error: `${n}: "${v.pkg} – ${v.duration}" is listed twice.` };
    seen.add(v.pkg + "|" + v.duration);
    if (x.source && (x.source.type === "tokopremium" || x.source.type === "pixelsub")) {
      // Linked to the supplier: price comes from supplier price + markup
      const stype = x.source.type, sname = stype === "pixelsub" ? "PixelSub API" : "TokoPremium";
      const markup = Number(x.source.markup), rm = x.source.resellerMarkup;
      const resellerMarkup = rm === "" || rm === null || rm === undefined ? null : Number(rm);
      if (!str(x.source.variantId, 80)) return { error: `${n}: choose the ${sname} product.` };
      if (!(markup >= 0 && markup <= 1000)) return { error: `${n}: markup must be between 0 and 1000%.` };
      if (resellerMarkup !== null && !(resellerMarkup >= 0 && resellerMarkup <= markup)) return { error: `${n}: reseller markup must be between 0 and the normal markup.` };
      v.source = { type: stype, variantId: str(x.source.variantId, 80), markup: r2(markup), resellerMarkup: resellerMarkup === null ? null : r2(resellerMarkup) };
      const q = supplierQuote(v, catalog().SITE);
      v.price = q ? q.price : v.price > 0 ? r2(v.price) : 0.01; // last known price, refreshed live
      v.bulkPrice = q ? q.bulkPrice : null;
      v.cost = q ? q.cost : v.cost;
      v.stock = 0;
      v._origKey = str(x.origKey, 200);
      variants.push(v);
      continue;
    }
    if (!(v.price > 0)) return { error: `${n}: selling price must be more than 0.` };
    if (v.bulkPrice !== null && !(v.bulkPrice > 0 && v.bulkPrice <= v.price)) return { error: `${n}: reseller price must be between 0 and the selling price (or empty).` };
    if (v.cost !== null && !(v.cost >= 0)) return { error: `${n}: cost can't be negative.` };
    for (const k of ["cost", "price", "bulkPrice"]) if (v[k] !== null) v[k] = r2(v[k]);
    if (x.manual) { v.manual = true; v.stock = Math.max(0, Math.floor(Number(x.stock) || 0)); }
    else v.stock = 0;
    v._origKey = str(x.origKey, 200);
    variants.push(v);
  }
  return {
    product: {
      slug, image: image || undefined, name, category: b.category,
      icon: str(b.icon, 3) || name.slice(0, 1).toUpperCase(), color,
      short: str(b.short, 300), sold: Math.max(0, Math.floor(Number(b.sold) || 0)),
      isNew: !!b.isNew, popular: !!b.popular,
      terms: (Array.isArray(b.terms) ? b.terms : String(b.terms || "").split("\n")).map((t) => str(String(t), 200)).filter(Boolean).slice(0, 20),
      variants,
    },
  };
}

async function adminSaveProduct(req, res) {
  const body = await readBody(req);
  const cat = JSON.parse(JSON.stringify(catalog()));
  const { product, error } = cleanProduct(body.product || {}, cat.CATEGORIES);
  if (error) return send(res, 400, { error });
  const orig = str(body.originalSlug, 60);
  const idx = orig ? cat.PRODUCTS.findIndex((p) => p.slug === orig) : -1;
  if (orig && idx < 0) return send(res, 404, { error: "Product not found." });
  if (cat.PRODUCTS.some((p, i) => p.slug === product.slug && i !== idx)) return send(res, 400, { error: "Another product already uses this slug." });

  // Keep stock attached when a plan or the slug is renamed
  const stock = loadStock();
  let moved = false;
  for (const v of product.variants) {
    const newKey = planKey(product.slug, v);
    if (v._origKey && v._origKey !== newKey && stock[v._origKey]) {
      stock[newKey] = (stock[newKey] || []).concat(stock[v._origKey]);
      delete stock[v._origKey];
      moved = true;
    }
    delete v._origKey;
  }
  if (moved) saveStock(stock);

  if (idx >= 0) cat.PRODUCTS[idx] = product; else cat.PRODUCTS.push(product);
  saveCatalog(cat);
  send(res, 200, { ok: true, product });
}

async function adminDeleteProduct(req, res) {
  const body = await readBody(req);
  const cat = JSON.parse(JSON.stringify(catalog()));
  const idx = cat.PRODUCTS.findIndex((p) => p.slug === body.slug);
  if (idx < 0) return send(res, 404, { error: "Product not found." });
  const [p] = cat.PRODUCTS.splice(idx, 1);
  saveCatalog(cat);
  const stock = loadStock();
  let removed = 0;
  for (const v of p.variants) { const k = planKey(p.slug, v); removed += (stock[k] || []).length; delete stock[k]; }
  saveStock(stock);
  send(res, 200, { ok: true, removedStock: removed });
}

async function adminSaveSettings(req, res) {
  const b = await readBody(req);
  const cat = JSON.parse(JSON.stringify(catalog()));
  const S = cat.SITE;
  const s = b.site || {};
  const set = (k, v) => { S[k] = v; };
  if (s.name !== undefined) set("name", str(s.name, 40) || S.name);
  if (s.domain !== undefined) set("domain", str(s.domain, 60));
  if (s.email !== undefined) {
    if (s.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.email)) return send(res, 400, { error: "Invalid email address." });
    set("email", str(s.email, 100));
  }
  if (s.whatsapp !== undefined) {
    const w = String(s.whatsapp).replace(/[^\d]/g, "");
    if (w && (w.length < 8 || w.length > 15)) return send(res, 400, { error: "WhatsApp: full number with country code, digits only (e.g. 8801700000000)." });
    set("whatsapp", w);
  }
  if (s.telegram !== undefined) {
    const t = String(s.telegram).replace(/^@/, "").trim();
    if (t && !/^[A-Za-z0-9_]{3,32}$/.test(t)) return send(res, 400, { error: "Telegram: username without @ (letters, numbers, _)." });
    set("telegram", t);
  }
  if (s.bot !== undefined) {
    let bl = String(s.bot).trim();
    if (/^@?[A-Za-z0-9_]{4,32}$/.test(bl)) bl = "https://t.me/" + bl.replace(/^@/, "");
    if (bl && !/^https:\/\/[^\s"'<>]+$/i.test(bl)) return send(res, 400, { error: "Bot link: use a full https:// link (e.g. https://t.me/yourbot) or @username." });
    set("bot", bl.slice(0, 200));
  }
  if (s.hours !== undefined) set("hours", str(s.hours, 80));
  for (const k of ["bulkMinQty", "topupMin", "topupMax"]) {
    if (s[k] === undefined) continue;
    const n = Number(s[k]);
    if (!(n > 0)) return send(res, 400, { error: `${k} must be more than 0.` });
    set(k, k === "bulkMinQty" ? Math.max(2, Math.floor(n)) : r2(n));
  }
  if (S.topupMin > S.topupMax) return send(res, 400, { error: "Minimum top-up can't be more than the maximum." });
  if (s.payments !== undefined) {
    const list = (Array.isArray(s.payments) ? s.payments : []).filter((m) => S.paymentInfo[m]);
    if (!list.length) return send(res, 400, { error: "Keep at least one payment method on." });
    set("payments", list);
  }
  if (s.paymentIds) for (const [m, v] of Object.entries(s.paymentIds)) {
    if (S.paymentInfo[m] && "value" in S.paymentInfo[m]) S.paymentInfo[m].value = str(String(v), 80);
  }
  if (Array.isArray(b.categories)) {
    const cats = [...new Set(b.categories.map((c) => str(String(c), 40)).filter(Boolean))].slice(0, 20);
    const used = cat.PRODUCTS.map((p) => p.category).filter((c) => !cats.includes(c));
    if (used.length) return send(res, 400, { error: `Category "${used[0]}" still has products. Move them first.` });
    if (!cats.length) return send(res, 400, { error: "Keep at least one category." });
    cat.CATEGORIES = cats;
  }
  saveCatalog(cat);
  send(res, 200, { ok: true, SITE: S, CATEGORIES: cat.CATEGORIES });
}

// Image upload: base64 body, only real PNG/JPEG/WEBP/GIF files (checked by their first bytes), max 2 MB
// Image type from the file's first bytes (null if it isn't a PNG/JPG/WEBP/GIF)
function imageExt(buf) {
  const sig = buf.subarray(0, 12);
  return sig[0] === 0x89 && sig.toString("ascii", 1, 4) === "PNG" ? "png"
    : sig[0] === 0xff && sig[1] === 0xd8 ? "jpg"
    : sig.toString("ascii", 0, 4) === "RIFF" && sig.toString("ascii", 8, 12) === "WEBP" ? "webp"
    : sig.toString("ascii", 0, 3) === "GIF" ? "gif" : null;
}

// Payment screenshots: kept on the data volume outside the public folder; only the admin can open them.
const proofsDir = path.join(storeDir, "proofs");
const PROOF_PROVIDERS = ["binance"]; // methods where the customer uploads a screenshot instead of their sender ID
function saveProof(dataUrl) {
  const buf = Buffer.from(String(dataUrl || "").replace(/^data:[^,]+,/, ""), "base64");
  if (!buf.length) throw new Error("Please upload a screenshot of your payment.");
  if (buf.length > 2_000_000) throw new Error("Screenshot must be smaller than 2 MB.");
  const ext = imageExt(buf);
  if (!ext) throw new Error("Screenshot must be a PNG, JPG or WEBP image.");
  fs.mkdirSync(proofsDir, { recursive: true });
  const name = `${Date.now().toString(36)}-${crypto.randomBytes(6).toString("hex")}.${ext}`;
  fs.writeFileSync(path.join(proofsDir, name), buf);
  return name;
}
function adminProof(res, name) {
  if (!/^[a-z0-9]+-[a-f0-9]{12}\.(png|jpg|webp|gif)$/.test(name)) return send(res, 404, { error: "Not found." });
  const file = path.join(proofsDir, name);
  if (!fs.existsSync(file)) return send(res, 404, { error: "Not found." });
  const type = { png: "image/png", jpg: "image/jpeg", webp: "image/webp", gif: "image/gif" }[name.split(".").pop()];
  res.writeHead(200, { "Content-Type": type, "Cache-Control": "private, no-store" });
  res.end(fs.readFileSync(file));
}

async function adminUpload(req, res) {
  const body = await readBody(req, 3_000_000);
  const buf = Buffer.from(String(body.data || "").replace(/^data:[^,]+,/, ""), "base64");
  if (!buf.length || buf.length > 2_000_000) return send(res, 400, { error: "Image must be smaller than 2 MB." });
  const ext = imageExt(buf);
  if (!ext) return send(res, 400, { error: "Only PNG, JPG, WEBP or GIF images." });
  const dir = path.join(storeDir, "uploads"); // on the data volume, so uploads survive redeploys
  fs.mkdirSync(dir, { recursive: true });
  const name = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}.${ext}`;
  fs.writeFileSync(path.join(dir, name), buf);
  send(res, 200, { path: `assets/img/uploads/${name}` });
}

/* ---------- Admin: accounting ---------- */
// Paid orders (payment verified / delivered) count as sales. Profit uses the cost price saved on each
// order line when it was sold, so later cost changes don't rewrite history.
const expensesFile = path.join(storeDir, "expenses.json");
const PAID = ["processing", "delivered"];

function accounting(fromStr, toStr) {
  const from = fromStr ? new Date(fromStr + "T00:00:00").getTime() : 0;
  const to = toStr ? new Date(toStr + "T23:59:59.999").getTime() : Infinity;
  const inRange = (iso) => { const t = new Date(iso).getTime(); return t >= from && t <= to; };
  const orders = loadOrders().filter((o) => PAID.includes(o.status) && inRange(o.createdAt));
  const { PRODUCTS } = catalog();
  const costNow = {};
  for (const p of PRODUCTS) for (const v of p.variants) costNow[planKey(p.slug, v)] = v.cost;

  const T = { orders: orders.length, revenue: 0, cost: 0, profit: 0, items: 0, missingCost: 0, guestRevenue: 0, resellerRevenue: 0, discounts: 0 };
  const byDay = {}, byProduct = {}, byMethod = {};
  for (const o of orders) {
    const day = o.createdAt.slice(0, 10);
    const d = (byDay[day] = byDay[day] || { date: day, orders: 0, revenue: 0, cost: 0, profit: 0 });
    const m = (byMethod[o.payment.method] = byMethod[o.payment.method] || { method: o.payment.method, orders: 0, revenue: 0 });
    d.orders++; m.orders++; m.revenue += o.total;
    T.revenue += o.total; T.discounts += o.discount || 0;
    if (o.customer.reseller) T.resellerRevenue += o.total; else T.guestRevenue += o.total;
    for (const it of o.items) {
      const unitCost = it.cost ?? costNow[it.key] ?? null;
      const cost = unitCost === null ? 0 : unitCost * it.qty;
      if (unitCost === null) T.missingCost += it.qty;
      T.items += it.qty; T.cost += cost; d.revenue += it.total; d.cost += cost;
      const k = it.key || it.slug + "|" + it.plan;
      const pr = (byProduct[k] = byProduct[k] || { name: it.name, plan: it.plan, qty: 0, revenue: 0, cost: 0, profit: 0 });
      pr.qty += it.qty; pr.revenue += it.total; pr.cost += cost;
    }
  }
  T.profit = T.revenue - T.cost;
  for (const x of Object.values(byDay)) x.profit = x.revenue - x.cost;
  for (const x of Object.values(byProduct)) x.profit = x.revenue - x.cost;

  const expenses = readJson(expensesFile, []).filter((e) => inRange(e.date + "T12:00:00"));
  const expenseTotal = expenses.reduce((a, e) => a + e.amount, 0);
  const topups = loadTopups().filter((t) => t.status === "completed" && inRange(t.completedAt || t.createdAt));
  const balances = readJson(usersFile, []).reduce((a, u) => a + (u.balance || 0), 0);
  const round = (o) => { for (const k in o) if (typeof o[k] === "number") o[k] = r2(o[k]); return o; };

  return {
    totals: round({ ...T, margin: T.revenue ? (T.profit / T.revenue) * 100 : 0, avgOrder: T.orders ? T.revenue / T.orders : 0,
      expenses: expenseTotal, netProfit: T.profit - expenseTotal, topups: topups.reduce((a, t) => a + t.amount, 0), balances }),
    byDay: Object.values(byDay).sort((a, b) => a.date.localeCompare(b.date)).map(round),
    byProduct: Object.values(byProduct).sort((a, b) => b.profit - a.profit).map(round),
    byMethod: Object.values(byMethod).sort((a, b) => b.revenue - a.revenue).map(round),
    expenses: expenses.sort((a, b) => b.date.localeCompare(a.date)),
    pending: loadOrders().filter((o) => o.status === "pending").length,
  };
}

async function adminExpense(req, res, action) {
  const body = await readBody(req);
  const list = readJson(expensesFile, []);
  if (action === "delete") {
    const i = list.findIndex((e) => e.id === body.id);
    if (i < 0) return send(res, 404, { error: "Not found." });
    list.splice(i, 1);
  } else {
    const amount = r2(Number(body.amount));
    const date = str(body.date, 10);
    if (!(amount > 0)) return send(res, 400, { error: "Amount must be more than 0." });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return send(res, 400, { error: "Pick a date." });
    list.unshift({ id: newId("EX"), date, amount, note: str(body.note, 120) || "Expense", createdAt: new Date().toISOString() });
  }
  writeJson(expensesFile, list);
  send(res, 200, { ok: true });
}

/* ---------- Admin: supplier (TokoPremium) ---------- */
async function adminSupplier(req, res) {
  await refreshSupplier(15_000);
  const { SITE, PRODUCTS } = catalog();
  let balance = null, balanceCurrency = supCache.currency, mode = "", balanceError = "";
  if (supKey()) {
    try {
      const b = await supRequest("GET", "/balance");
      balance = b.balance; balanceCurrency = b.currency || balanceCurrency; mode = b.mode || "";
      supCache.balance = balance; supCache.mode = mode;
    } catch (e) { balanceError = e.message; }
  }
  const links = {};
  for (const p of PRODUCTS) for (const v of p.variants) if (v.source && v.source.type !== "pixelsub") (links[v.source.variantId] = links[v.source.variantId] || []).push({ slug: p.slug, name: p.name, plan: `${v.pkg} – ${v.duration}` });
  const rate = supRate(SITE);
  // Second supplier: PixelSub API (USD)
  let pxBalance = null, pxBalanceError = "";
  if (pxKey()) {
    try {
      const b = await pxRequest("GET", "/balance");
      const raw = b.balance ?? (b.data && b.data.balance) ?? b.amount ?? null;
      pxBalance = raw === null || raw === undefined || raw === "" ? null : Number(raw);
      if (pxBalance !== null && !Number.isFinite(pxBalance)) pxBalance = null;
      pxCache.balance = pxBalance;
    } catch (e) { pxBalanceError = e.message; }
  }
  const pxLinks = {};
  for (const p of PRODUCTS) for (const v of p.variants) if (v.source && v.source.type === "pixelsub") (pxLinks[v.source.variantId] = pxLinks[v.source.variantId] || []).push({ slug: p.slug, name: p.name, plan: `${v.pkg} – ${v.duration}` });
  const pixelsub = {
    configured: !!pxKey(), balance: pxBalance, balanceError: pxBalanceError, error: pxCache.error,
    updatedAt: pxCache.at ? new Date(pxCache.at).toISOString() : null,
    products: pxCache.list.map((s) => ({ variant_id: s.id, product: s.name, variant: "", price: s.price, usd: s.price, stock: s.inStock ? (s.stock === null ? PX_UNLIMITED : s.stock) : 0,
      available: s.inStock, linkedTo: pxLinks[s.id] || [] })),
  };
  // Everything is reported in USD for the admin; the supplier's own currency is kept for reference
  send(res, 200, {
    pixelsub,
    configured: !!supKey(), mode, balanceError,
    balanceUsd: balance === null ? null : r2(balance / supRate(SITE, balanceCurrency)),
    balanceOriginal: balance, balanceCurrency,
    currency: supCache.currency, converted: rate !== 1, error: supCache.error, updatedAt: supCache.at ? new Date(supCache.at).toISOString() : null,
    rate, rateMode: SITE.supplierRateMode === "manual" ? "manual" : "auto", liveRate: rateCache.rate, manualRate: Number(SITE.supplierRate) || 17900,
    defaultMarkup: Number(SITE.supplierMarkup ?? 30), defaultResellerMarkup: SITE.supplierResellerMarkup ?? null,
    products: supCache.list.map((s) => ({ ...s, usd: r4(s.price / rate), normalUsd: r4((s.normal_price || 0) / rate),
      bulkUsd: s.bulk ? r4(s.bulk.price / rate) : null, linkedTo: links[s.variant_id] || [] })),
  });
}

async function adminSupplierSettings(req, res) {
  const b = await readBody(req);
  const cat = JSON.parse(JSON.stringify(catalog()));
  const mode = b.rateMode === "manual" ? "manual" : "auto";
  const rate = b.rate === "" || b.rate === undefined ? Number(cat.SITE.supplierRate) || 17900 : Number(b.rate), markup = Number(b.markup);
  const rm = b.resellerMarkup === "" || b.resellerMarkup === null || b.resellerMarkup === undefined ? null : Number(b.resellerMarkup);
  if (!(rate >= 1 && rate <= 10_000_000)) return send(res, 400, { error: "Rate: how many IDR = 1 USD (e.g. 17900)." });
  if (!(markup >= 0 && markup <= 1000)) return send(res, 400, { error: "Default markup must be between 0 and 1000%." });
  if (rm !== null && !(rm >= 0 && rm <= markup)) return send(res, 400, { error: "Reseller markup must be between 0 and the normal markup." });
  Object.assign(cat.SITE, { supplierRateMode: mode, supplierRate: r2(rate), supplierMarkup: r2(markup), supplierResellerMarkup: rm === null ? null : r2(rm) });
  saveCatalog(cat);
  send(res, 200, { ok: true });
}

// Adds a supplier product (all or chosen variants) to the store as linked plans
async function adminSupplierImport(req, res) {
  const b = await readBody(req);
  await refreshSupplier(15_000);
  const cat = JSON.parse(JSON.stringify(catalog()));
  const S = cat.SITE;
  const ids = Array.isArray(b.variantIds) ? b.variantIds.map(String) : [];
  const picked = supCache.list.filter((s) => ids.includes(s.variant_id));
  if (!picked.length) return send(res, 400, { error: "Choose at least one TokoPremium product." });
  if (!cat.CATEGORIES.includes(b.category)) return send(res, 400, { error: "Choose a category." });
  const markup = b.markup === undefined || b.markup === "" ? Number(S.supplierMarkup ?? 30) : Number(b.markup);
  const rm = b.resellerMarkup === undefined ? S.supplierResellerMarkup ?? null : b.resellerMarkup === "" || b.resellerMarkup === null ? null : Number(b.resellerMarkup);
  if (!(markup >= 0 && markup <= 1000)) return send(res, 400, { error: "Markup must be between 0 and 1000%." });
  if (rm !== null && !(rm >= 0 && rm <= markup)) return send(res, 400, { error: "Reseller markup must be between 0 and the normal markup." });

  const slug = (String(b.slug || picked[0].product_slug).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "product").slice(0, 60);
  let p = cat.PRODUCTS.find((x) => x.slug === slug);
  const created = !p;
  if (!p) {
    const name = str(b.name, 80) || picked[0].product;
    p = { slug, name, category: b.category, icon: name.slice(0, 1).toUpperCase(), color: "#2563eb", short: str(b.short, 300) || `${name} — instant delivery.`,
      sold: 0, isNew: true, popular: false, terms: [], variants: [] };
    const img = ["png", "webp"].map((e) => `assets/img/${slug}.${e}`).find((f) => fs.existsSync(path.join(root, f)));
    if (img) p.image = img;
    cat.PRODUCTS.push(p);
  }
  let added = 0;
  for (const s of picked) {
    if (p.variants.some((v) => v.source && v.source.type !== "pixelsub" && v.source.variantId === s.variant_id)) continue;
    const pkg = s.account_type ? s.account_type[0].toUpperCase() + s.account_type.slice(1) : "Account";
    let duration = str(s.variant, 40) || "Plan";
    while (p.variants.some((v) => v.pkg === pkg && v.duration === duration)) duration += " ·";
    const v = { pkg, duration, warranty: s.warranty_days ? `${s.warranty_days} Days` : "—", stock: 0,
      source: { type: "tokopremium", variantId: s.variant_id, markup: r2(markup), resellerMarkup: rm === null ? null : r2(rm) } };
    const q = supplierQuote(v, S);
    Object.assign(v, { price: q ? q.price : 0.01, bulkPrice: q ? q.bulkPrice : null, cost: q ? q.cost : null });
    p.variants.push(v);
    added++;
  }
  saveCatalog(cat);
  send(res, 200, { ok: true, slug: p.slug, created, added });
}

// Adds PixelSub API products to the store as linked plans. Each one becomes its own product
// (name / package / duration are guessed from the supplier's title and can be edited in Products),
// or, with b.group, all go into one product with that name.
async function adminPxImport(req, res) {
  const b = await readBody(req);
  await refreshPx(15_000);
  const cat = JSON.parse(JSON.stringify(catalog()));
  const S = cat.SITE;
  const ids = Array.isArray(b.ids) ? b.ids.map(String) : [];
  const picked = pxCache.list.filter((s) => ids.includes(s.id));
  if (!picked.length) return send(res, 400, { error: "Choose at least one PixelSub product." });
  if (!cat.CATEGORIES.includes(b.category)) return send(res, 400, { error: "Choose a category." });
  const markup = b.markup === undefined || b.markup === "" ? Number(S.supplierMarkup ?? 30) : Number(b.markup);
  const rm = b.resellerMarkup === undefined || b.resellerMarkup === "" || b.resellerMarkup === null ? null : Number(b.resellerMarkup);
  if (!(markup >= 0 && markup <= 1000)) return send(res, 400, { error: "Markup must be between 0 and 1000%." });
  if (rm !== null && !(rm >= 0 && rm <= markup)) return send(res, 400, { error: "Reseller markup must be between 0 and the markup." });
  const slugify = (s) => (String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "product").slice(0, 60);
  const unitName = { m: "Month", mo: "Month", month: "Month", months: "Month", d: "Day", day: "Day", days: "Day", y: "Year", yr: "Year", year: "Year", years: "Year", w: "Week", week: "Week", weeks: "Week" };
  const group = str(b.group, 80);
  let added = 0, createdN = 0;
  for (const s of picked) {
    if (cat.PRODUCTS.some((x) => x.variants.some((v) => v.source && v.source.type === "pixelsub" && v.source.variantId === s.id))) continue;
    let title = s.name, duration = "", pkg = "Standard";
    const pm = title.match(/\(([^)]{1,30})\)/);
    if (pm) { pkg = pm[1].trim(); title = title.replace(pm[0], " "); }
    const dm = title.match(/(\d+)\s*(months?|mo|m|days?|d|years?|yr|y|weeks?|w)\b/i);
    if (dm) {
      const n = Number(dm[1]), u = unitName[dm[2].toLowerCase()];
      duration = `${n} ${u}${n > 1 ? "s" : ""}`;
      title = title.replace(dm[0], " ");
    }
    title = title.replace(/[–—-]\s*$/g, "").replace(/\s{2,}/g, " ").replace(/\s+[–—-]\s+/g, " ").trim() || s.name;
    if (!duration) duration = "Standard";
    const name = group || title;
    const slug = slugify(name);
    let p = cat.PRODUCTS.find((x) => x.slug === slug);
    if (!p) {
      p = { slug, name, category: b.category, icon: name.slice(0, 1).toUpperCase(), color: "#2563eb", short: `${name} — instant delivery.`,
        sold: 0, isNew: true, popular: false, terms: [], variants: [] };
      const img = ["png", "webp"].map((e) => `assets/img/${slug}.${e}`).find((f) => fs.existsSync(path.join(root, f)));
      if (img) p.image = img;
      cat.PRODUCTS.push(p);
      createdN++;
    }
    while (p.variants.some((v) => v.pkg === pkg && v.duration === duration)) duration += " ·";
    const v = { pkg, duration, warranty: "—", stock: 0, source: { type: "pixelsub", variantId: s.id, markup: r2(markup), resellerMarkup: rm === null ? null : r2(rm) } };
    const q = pxQuote(v);
    Object.assign(v, { price: q ? q.price : 0.01, bulkPrice: q ? q.bulkPrice : null, cost: q ? q.cost : null });
    p.variants.push(v);
    added++;
  }
  saveCatalog(cat);
  send(res, 200, { ok: true, added, created: createdN });
}

async function api(req, res, url) {
  const parts = url.pathname.split("/").filter(Boolean); // ["api", ...]
  const route = req.method + " " + parts.slice(1).join("/");
  if (route === "POST auth/signup") return signup(req, res);
  if (route === "POST auth/login") return login(req, res);
  if (route === "POST auth/apply") return applyAgain(req, res);
  if (route === "POST auth/logout") return logout(req, res);
  if (route === "GET auth/me") {
    const u = sessionUser(req);
    return u ? send(res, 200, publicUser(u)) : send(res, 200, null);
  }
  if (route === "GET my/orders") {
    const u = sessionUser(req);
    if (!u) return send(res, 401, { error: "Please log in." });
    return send(res, 200, loadOrders().filter((o) => o.customer.username === u.username).map((o) => publicOrder(o, true)));
  }
  if (route === "POST cryptomus/webhook") return cryptomusWebhook(req, res);
  if (route === "GET stock") return send(res, 200, stockCounts());
  if (route === "GET wallet") return walletInfo(req, res);
  if (route === "POST wallet/topup") return createTopup(req, res);
  if (req.method === "POST" && parts[1] === "wallet" && parts[2] === "topup" && parts[4] === "verify" && parts.length === 5) return userVerifyTopup(req, res, parts[3]);
  if (route === "POST auth/password") return changePassword(req, res);
  if (req.method === "POST" && parts[1] === "orders" && parts.length === 2) return createOrder(req, res);
  if (req.method === "GET" && parts[1] === "orders" && parts.length === 3) return getOrder(req, res, parts[2], url.searchParams.get("t"));
  if (req.method === "POST" && parts[1] === "orders" && parts[3] === "verify" && parts.length === 4) return customerVerify(req, res, parts[2], url.searchParams.get("t"));
  if (req.method === "POST" && parts[1] === "orders" && parts[3] === "cancel" && parts.length === 4) return customerCancel(req, res, parts[2], url.searchParams.get("t"));
  if (parts[1] === "admin") {
    if (!isAdmin(req)) return send(res, 401, { error: "Wrong admin key." });
    if (req.method === "GET" && parts[2] === "orders" && parts.length === 3) return send(res, 200, loadOrders());
    if (req.method === "GET" && parts[2] === "users" && parts.length === 3) {
      const orders = loadOrders();
      return send(res, 200, readJson(usersFile, []).map((u) => ({ ...publicUser(u), orders: orders.filter((o) => o.customer.username === u.username).length })));
    }
    if (req.method === "POST" && parts[2] === "orders" && parts[4] === "verify" && parts.length === 5) {
      const o = loadOrders().find((x) => x.id === parts[3]);
      if (!o) return send(res, 404, { error: "Order not found." });
      if (!o.payment.auto) return send(res, 400, { error: "This payment method is checked manually." });
      clearPayCaches();
      return send(res, 200, await verifyOrder(o.id));
    }
    if (req.method === "POST" && parts[2] === "orders" && parts[4] === "delete" && parts.length === 5) return adminDeleteOrder(req, res, parts[3]);
    if (req.method === "POST" && parts[2] === "orders" && parts.length === 4) return adminUpdate(req, res, parts[3]);

    if (req.method === "POST" && parts[2] === "users" && parts[4] === "review" && parts.length === 5) return adminReviewApplication(req, res, parts[3]);
    if (route === "GET admin/topups") return send(res, 200, loadTopups());
    if (req.method === "GET" && parts[2] === "proofs" && parts.length === 4) return adminProof(res, parts[3]);

    if (route === "GET admin/health") return send(res, 200, { dataDir: storeDir, dataAtRisk });
    if (route === "GET admin/catalog") { await refreshSupplier(30_000); return send(res, 200, liveCatalog()); }
    if (route === "GET admin/supplier") return adminSupplier(req, res);
    if (route === "POST admin/supplier/settings") return adminSupplierSettings(req, res);
    if (route === "POST admin/supplier/import") return adminSupplierImport(req, res);
    if (route === "POST admin/supplier/px-import") return adminPxImport(req, res);
    if (route === "POST admin/supplier/retry") return send(res, 200, { retried: await retrySupplierOrders() });
    if (req.method === "POST" && parts[2] === "orders" && parts[4] === "supplier-retry" && parts.length === 5) {
      const o = await supplierDeliver(parts[3]);
      if (!o) return send(res, 404, { error: "Order not found or already being processed." });
      const failed = o.items.filter((i) => i.supplier && !i.delivered);
      return send(res, 200, { ...o, warning: failed.length ? `Still failing: ${failed.map((i) => i.supplierError || "no response").join("; ")}` : "" });
    }
    if (route === "POST admin/products/save") return adminSaveProduct(req, res);
    if (route === "POST admin/products/delete") return adminDeleteProduct(req, res);
    if (route === "POST admin/settings") return adminSaveSettings(req, res);
    if (route === "POST admin/upload") return adminUpload(req, res);
    if (route === "GET admin/accounting") return send(res, 200, accounting(url.searchParams.get("from"), url.searchParams.get("to")));
    if (route === "POST admin/expenses/add") return adminExpense(req, res, "add");
    if (route === "POST admin/expenses/delete") return adminExpense(req, res, "delete");

    // Stock: list, add (one account per line), remove
    if (route === "GET admin/stock") {
      const { PRODUCTS } = catalog(), stock = loadStock();
      const plans = [];
      for (const p of PRODUCTS) for (const v of p.variants) {
        const key = planKey(p.slug, v);
        plans.push({ key, product: p.name, plan: `${v.pkg} – ${v.duration}`, manual: !!v.manual || !!v.source, supplier: !!v.source,
          items: v.manual || v.source ? [] : stock[key] || [] });
      }
      const waiting = loadOrders().filter((o) => o.status === "processing").length;
      return send(res, 200, { plans, waiting });
    }
    if (route === "POST admin/stock") {
      const body = await readBody(req);
      const plan = findPlan(catalog().PRODUCTS, String(body.key || ""));
      if (!plan || plan.v.manual || plan.v.source) return send(res, 400, { error: "Choose an automatic-delivery plan (not manual or TokoPremium)." });
      const lines = String(body.items || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(0, 2000);
      if (!lines.length) return send(res, 400, { error: "Paste at least one account (one per line)." });
      const stock = loadStock();
      const list = (stock[body.key] = stock[body.key] || []);
      const existing = new Set(list.map((x) => x.data));
      let added = 0;
      for (const data of lines) {
        if (existing.has(data) || data.length > 1000) continue;
        list.push({ id: newId("ST"), data, addedAt: new Date().toISOString() });
        existing.add(data); added++;
      }
      saveStock(stock);
      const delivered = deliverWaitingOrders();
      return send(res, 200, { added, skipped: lines.length - added, inStock: (loadStock()[body.key] || []).length, deliveredOrders: delivered });
    }
    if (route === "POST admin/stock/remove") {
      const body = await readBody(req);
      const stock = loadStock();
      const list = stock[body.key] || [];
      const i = list.findIndex((x) => x.id === body.id);
      if (i < 0) return send(res, 404, { error: "Not found." });
      list.splice(i, 1);
      saveStock(stock);
      return send(res, 200, { ok: true });
    }
    if (route === "POST admin/deliver") return send(res, 200, { deliveredOrders: deliverWaitingOrders() });
    if (req.method === "POST" && parts[2] === "topups" && parts.length === 4) {
      const body = await readBody(req);
      const t = loadTopups().find((x) => x.id === parts[3]);
      if (!t) return send(res, 404, { error: "Top-up not found." });
      if (t.status !== "pending") return send(res, 400, { error: `Already ${t.status}.` });
      if (body.action === "approve") return send(res, 200, completeTopup(t.id, "admin"));
      if (body.action === "verify") { clearPayCaches(); return send(res, 200, await verifyTopup(t.id)); }
      if (body.action === "reject") {
        const topups = loadTopups();
        const cur = topups.find((x) => x.id === t.id);
        cur.status = "rejected";
        cur.note = str(body.note, 300);
        saveTopups(topups);
        return send(res, 200, cur);
      }
      return send(res, 400, { error: "Unknown action." });
    }
    if (req.method === "POST" && parts[2] === "users" && parts[4] === "adjust" && parts.length === 5) {
      const body = await readBody(req);
      const amount = Math.round(Number(body.amount) * 100) / 100;
      if (!Number.isFinite(amount) || amount === 0) return send(res, 400, { error: "Enter an amount (use minus to deduct)." });
      try {
        const balance = walletApply(parts[3], amount, "adjust", str(body.note, 200) || "Adjusted by admin", "admin");
        return send(res, 200, { balance });
      } catch (e) { return send(res, 400, { error: e.message }); }
    }
  }
  send(res, 404, { error: "Not found" });
}

/* ---------- Static files ---------- */
const BLOCKED = /^\/(storage|server\.js|\.claude|node_modules|\.env[^/]*|tests?)(\/|$)/i;

/* ---------- SEO: robots.txt, sitemap.xml, per-page meta tags + structured data ---------- */
const escAttr = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const jsonLd = (o) => `<script type="application/ld+json">${JSON.stringify(o).replace(/</g, "\\u003c")}</script>`;
const absUrl = (base, p) => (/^https?:/i.test(p || "") ? p : `${base}/${String(p || "").replace(/^\//, "")}`);

function robotsTxt(base) {
  return `User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /admin\nDisallow: /account\nDisallow: /order\nDisallow: /cart\nDisallow: /login\n\nSitemap: ${base}/sitemap.xml\n`;
}

function sitemapXml(base) {
  const { PRODUCTS } = catalog();
  const day = new Date().toISOString().slice(0, 10);
  const urls = [
    { loc: `${base}/`, pr: "1.0", cf: "daily" },
    { loc: `${base}/reseller.html`, pr: "0.7", cf: "weekly" },
    { loc: `${base}/landing.html`, pr: "0.6", cf: "weekly" },
    ...PRODUCTS.map((p) => ({ loc: `${base}/product.html?p=${encodeURIComponent(p.slug)}`, pr: "0.8", cf: "daily" })),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls.map((u) => `  <url><loc>${escAttr(u.loc)}</loc><lastmod>${day}</lastmod><changefreq>${u.cf}</changefreq><priority>${u.pr}</priority></url>`).join("\n") + `\n</urlset>\n`;
}

// Returns the <head> tags (title/description/canonical/Open Graph/Twitter/JSON-LD) for a public page, or null.
function seoHead(file, url, base) {
  const { SITE, PRODUCTS } = liveCatalog();
  const name = SITE.name || "PixelSub";
  const logo = absUrl(base, "assets/img/logo.png");
  const mk = ({ title, desc, canon, image, type = "website", extra = "" }) =>
    `<title>${escAttr(title)}</title>\n  <meta name="description" content="${escAttr(desc)}">\n  <link rel="canonical" href="${escAttr(canon)}">\n` +
    `  <meta name="robots" content="index, follow, max-image-preview:large">\n  <meta name="theme-color" content="#2563eb">\n` +
    `  <meta property="og:site_name" content="${escAttr(name)}">\n  <meta property="og:type" content="${type}">\n  <meta property="og:title" content="${escAttr(title)}">\n` +
    `  <meta property="og:description" content="${escAttr(desc)}">\n  <meta property="og:url" content="${escAttr(canon)}">\n  <meta property="og:image" content="${escAttr(image || logo)}">\n` +
    `  <meta name="twitter:card" content="summary_large_image">\n  <meta name="twitter:title" content="${escAttr(title)}">\n  <meta name="twitter:description" content="${escAttr(desc)}">\n  <meta name="twitter:image" content="${escAttr(image || logo)}">\n  ${extra}`;

  if (file === "index.html") {
    const names = PRODUCTS.slice(0, 8).map((p) => p.name).join(", ");
    return mk({
      title: `${name} | Buy Netflix, ChatGPT, CapCut, Canva & Premium Accounts Cheap`,
      desc: `Buy original premium accounts at reseller prices: ${names} and more. Instant delivery 24/7, replacement warranty, pay with Binance Pay, Bybit or crypto.`,
      canon: `${base}/`,
      extra: jsonLd({ "@context": "https://schema.org", "@graph": [
        { "@type": "Organization", "@id": `${base}/#org`, name, url: `${base}/`, logo, ...(SITE.email ? { email: SITE.email } : {}) },
        { "@type": "WebSite", "@id": `${base}/#site`, name, url: `${base}/`, publisher: { "@id": `${base}/#org` } },
      ] }),
    });
  }
  if (file === "reseller.html") {
    return mk({
      title: `Become a Reseller | Wholesale Premium Account Prices | ${name}`,
      desc: `Join the ${name} reseller program and buy premium accounts for less when you take 2 or more. Wholesale prices on Netflix, ChatGPT, CapCut, Canva and more.`,
      canon: `${base}/reseller.html`,
    });
  }
  if (file === "landing.html") {
    return mk({
      title: `Digital Product Supplier at Wholesale Prices | ${name}`,
      desc: `Looking for a digital product supplier at wholesale prices? Order easily on our website or Telegram bot. Netflix, ChatGPT, CapCut, Canva and more, instant delivery 24/7.`,
      canon: `${base}/landing.html`,
    });
  }
  if (file === "product.html") {
    const p = PRODUCTS.find((x) => x.slug === url.searchParams.get("p"));
    if (!p) return null;
    const prices = p.variants.map((v) => v.price).filter((n) => typeof n === "number" && n > 0);
    const low = prices.length ? Math.min(...prices) : null, high = prices.length ? Math.max(...prices) : null;
    const inStock = p.variants.some((v) => (v.stock || 0) > 0);
    const canon = `${base}/product.html?p=${encodeURIComponent(p.slug)}`;
    const image = p.image ? absUrl(base, p.image) : logo;
    const desc = `Buy ${p.name}${low != null ? ` from $${low}` : ""} — ${p.short || `original ${p.category} account`} Instant delivery, replacement warranty. Pay with Binance Pay, Bybit or crypto.`.slice(0, 300);
    const offer = low != null ? {
      "@type": "AggregateOffer", priceCurrency: "USD", lowPrice: low, highPrice: high, offerCount: p.variants.length,
      availability: inStock ? "https://schema.org/InStock" : "https://schema.org/OutOfStock", url: canon,
    } : undefined;
    return mk({
      title: `Buy ${p.name}${low != null ? ` from $${low}` : ""} | ${name}`, desc, canon, image, type: "product",
      extra: jsonLd({ "@context": "https://schema.org", "@type": "Product", name: p.name, description: p.short || p.name, image, category: p.category,
        brand: { "@type": "Brand", name: p.name }, ...(offer ? { offers: offer } : {}) }) + "\n  " + jsonLd({ "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: `${base}/` },
        { "@type": "ListItem", position: 2, name: p.name, item: canon } ] }),
    });
  }
  return null;
}

// Crawlable fallback: plain links to every product (the product grid itself is drawn by JavaScript)
function seoNoscript(base) {
  const { PRODUCTS } = catalog();
  return `<noscript><nav aria-label="Products"><ul>${PRODUCTS.map((p) => `<li><a href="${base}/product.html?p=${encodeURIComponent(p.slug)}">${escAttr(p.name)}</a> — ${escAttr(p.short || p.category)}</li>`).join("")}</ul></nav></noscript>`;
}

function serveHtml(req, res, file, url) {
  fs.readFile(path.join(root, file), "utf8", (err, html) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    const base = publicBase(req);
    const head = seoHead(file, url, base);
    if (head) {
      html = html.replace(/<title>[\s\S]*?<\/title>\s*/i, "").replace(/<meta name="description"[^>]*>\s*/i, "").replace("</head>", `  ${head}\n</head>`);
      if (file === "index.html") html = html.replace('<header id="site-header"></header>', `<header id="site-header"></header>\n  ${seoNoscript(base)}`);
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
    res.end(html);
  });
}

function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (BLOCKED.test(p)) { res.writeHead(404); return res.end("Not found"); }
  if (p === "/robots.txt") { res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }); return res.end(robotsTxt(publicBase(req))); }
  if (p === "/sitemap.xml") { res.writeHead(200, { "Content-Type": "application/xml; charset=utf-8" }); return res.end(sitemapXml(publicBase(req))); }
  if (p === "/") p = "/index.html";
  if (["/index.html", "/reseller.html", "/landing.html", "/product.html", "/reseller", "/landing", "/product"].includes(p)) {
    return serveHtml(req, res, p.replace(/^\//, "").replace(/(?<!\.html)$/, ".html"), url);
  }
  if (p === "/assets/js/data.js") {
    res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-cache" });
    return res.end(publicDataJs());
  }
  if (p.endsWith("/")) p += "index.html";
  // Clean URLs: /admin -> /admin.html, /cart -> /cart.html ...
  else if (/^\/[a-z]+$/.test(p) && fs.existsSync(path.join(root, p + ".html"))) p += ".html";
  // Admin-uploaded product images are stored on the data volume
  const up = p.match(/^\/assets\/img\/uploads\/([\w.-]+)$/);
  const file = up ? path.join(storeDir, "uploads", up[1]) : path.join(root, p);
  if (!up && !file.startsWith(root + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": types[path.extname(file).toLowerCase()] || "application/octet-stream" });
    res.end(data);
  });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (url.pathname.startsWith("/api/")) await api(req, res, url);
    else serveStatic(req, res, url);
  } catch (e) {
    send(res, 400, { error: e.message || "Bad request" });
  }
}).listen(port, () => {
  console.log(`PixelSub running at http://localhost:${port}`);
  console.log(`Data folder: ${storeDir}`);
  if (dataAtRisk) console.error("WARNING: running on Railway WITHOUT a Volume - all orders, stock and product edits are lost on every deploy. Add a Volume and set DATA_DIR to its mount path.");
  if (ADMIN_KEY === "change-me") console.log('Admin key is the default "change-me" - set ADMIN_KEY before going live.');
});
