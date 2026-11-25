/* PixelSub admin — Dashboard (accounting), Products editor, Settings.
   Orders, Stock, Balance requests and Resellers live in app.js (initAdmin). */

const pct = (n) => `${(Number(n) || 0).toFixed(1)}%`;
// Days are Bangladesh days (UTC+6, no daylight saving), whatever the admin's own time zone
const BD_MS = 6 * 3600e3;
const isoDay = (d) => new Date(d.getTime() + BD_MS).toISOString().slice(0, 10);
const bdNoon = (day) => new Date(day + "T12:00:00+06:00"); // a day's midday, for stepping day by day
const nextDay = (t) => new Date(t.getTime() + 864e5);
const slugify = (s) => String(s).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
const jsonPost = (api, url, body) => api(url, { method: "POST", body: JSON.stringify(body) })
  .then(async (r) => ({ ok: r.ok, data: await r.json().catch(() => ({})) }));

/* ======================= Dashboard / accounting ======================= */
let dashRange = { key: "30d", from: "", to: "" };

function rangeDates(key) {
  const today = new Date(), d = (n) => isoDay(new Date(today.getTime() - n * 864e5));
  if (key === "today") return { from: isoDay(today), to: isoDay(today) };
  if (key === "7d") return { from: d(6), to: isoDay(today) };
  if (key === "30d") return { from: d(29), to: isoDay(today) };
  if (key === "month") return { from: isoDay(today).slice(0, 8) + "01", to: isoDay(today) };
  return { from: "", to: "" };
}

// Revenue vs profit per day: grouped columns, one $ axis, hover tooltip per day
function dailyChart(days, from, to) {
  // Fill missing days so gaps show as zero
  const list = [];
  if (from && to) {
    const map = Object.fromEntries(days.map((d) => [d.date, d]));
    for (let t = bdNoon(from); isoDay(t) <= to; t = nextDay(t)) {
      const k = isoDay(t);
      list.push(map[k] || { date: k, revenue: 0, profit: 0, orders: 0 });
    }
  } else list.push(...days);
  if (!list.length || list.every((d) => !d.revenue)) return `<div class="empty-chart muted">No paid orders in this period yet.</div>`;

  const W = 760, H = 240, pad = { l: 52, r: 8, t: 12, b: 26 };
  const max = Math.max(...list.map((d) => Math.max(d.revenue, d.profit)), 1);
  const step = niceStep(max / 4), top = Math.ceil(max / step) * step;
  const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - Math.max(0, v) / top);
  const band = (W - pad.l - pad.r) / list.length;
  const bw = Math.max(2, Math.min(18, (band - 6) / 2));
  const ticks = []; for (let v = 0; v <= top + 1e-9; v += step) ticks.push(v);
  const every = Math.ceil(list.length / 8);
  const bar = (x, v, c) => {
    const h = Math.max(0, y(0) - y(v));
    if (h < 0.5) return "";
    const r = Math.min(4, bw / 2, h);
    return `<path d="M${x},${y(0)} v${-(h - r)} q0,${-r} ${r},${-r} h${bw - 2 * r} q${r},0 ${r},${r} v${h - r} z" fill="${c}"/>`;
  };
  return `
    <div class="chart-legend"><span><i style="background:var(--c-rev)"></i>Revenue</span><span><i style="background:var(--c-pro)"></i>Gross profit</span></div>
    <div class="chart-wrap">
      <svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Revenue and gross profit per day">
        ${ticks.map((v) => `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${pad.l - 8}" y="${y(v) + 4}" class="tick" text-anchor="end">$${v >= 1000 ? (v / 1000).toFixed(1) + "k" : +v.toFixed(2)}</text>`).join("")}
        ${list.map((d, i) => {
          const x0 = pad.l + i * band + (band - (bw * 2 + 2)) / 2;
          return `<g class="day" data-i="${i}">
            <rect x="${pad.l + i * band}" y="${pad.t}" width="${band}" height="${H - pad.t - pad.b}" class="hit"/>
            ${bar(x0, d.revenue, "var(--c-rev)")}${bar(x0 + bw + 2, d.profit, "var(--c-pro)")}
            ${i % every === 0 ? `<text x="${pad.l + i * band + band / 2}" y="${H - 8}" class="tick" text-anchor="middle">${d.date.slice(5)}</text>` : ""}
          </g>`;
        }).join("")}
      </svg>
      <div class="chart-tip" hidden></div>
    </div>`;

  function niceStep(raw) {
    const p = Math.pow(10, Math.floor(Math.log10(raw || 1))), n = raw / p;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
  }
}

function bindChartHover(el, days) {
  const wrap = $(".chart-wrap", el); if (!wrap) return;
  const tip = $(".chart-tip", wrap);
  const rows = $$(".day", wrap);
  wrap.addEventListener("mousemove", (e) => {
    const g = e.target.closest(".day"); if (!g) { tip.hidden = true; return; }
    const d = days[+g.dataset.i]; if (!d) return;
    rows.forEach((r) => r.classList.toggle("on", r === g));
    tip.innerHTML = `<b>${d.date}</b><span><i style="background:var(--c-rev)"></i>Revenue <b>${money(d.revenue)}</b></span><span><i style="background:var(--c-pro)"></i>Gross profit <b>${money(d.profit)}</b></span><span class="muted">${d.orders || 0} order(s)</span>`;
    tip.hidden = false;
    const box = wrap.getBoundingClientRect();
    const x = e.clientX - box.left;
    tip.style.left = Math.min(box.width - 170, Math.max(0, x + 12)) + "px";
    tip.style.top = "8px";
  });
  wrap.addEventListener("mouseleave", () => { tip.hidden = true; rows.forEach((r) => r.classList.remove("on")); });
}

async function adminDashboard({ el, api, reload }) {
  const { from, to } = dashRange.key === "custom" ? dashRange : rangeDates(dashRange.key);
  const r = await api(`/api/admin/accounting?from=${from}&to=${to}`);
  const A = await r.json();
  const T = A.totals;

  // same filled list as the chart, for the tooltip
  const filled = [];
  if (from && to) {
    const map = Object.fromEntries(A.byDay.map((d) => [d.date, d]));
    for (let t = bdNoon(from); isoDay(t) <= to; t = nextDay(t)) filled.push(map[isoDay(t)] || { date: isoDay(t), revenue: 0, profit: 0, orders: 0 });
  } else filled.push(...A.byDay);

  const health = await api("/api/admin/health").then((r) => r.json()).catch(() => ({}));
  const tile = (label, value, sub = "", cls = "") => `<div class="card kpi ${cls}"><span>${label}</span><strong>${value}</strong>${sub ? `<small>${sub}</small>` : ""}</div>`;
  el.innerHTML = `
    ${health.dataAtRisk ? `<div class="form-error"><b>⚠ Your data is NOT saved permanently.</b> This server has no Volume, so every deploy erases orders, stock, accounts and product edits. In Railway: add a Volume (mount path <code>/data</code>) and set the variable <code>DATA_DIR=/data</code>.</div>` : ""}
    <div class="filter-row">
      ${[["today", "Today"], ["7d", "7 days"], ["30d", "30 days"], ["month", "This month"], ["all", "All time"]].map(([k, l]) => `<button class="tab ${dashRange.key === k ? "active" : ""}" data-range="${k}">${l}</button>`).join("")}
      <span class="custom-range"><input type="date" id="r-from" value="${from}"> – <input type="date" id="r-to" value="${to}"><button class="btn btn-outline" id="r-apply">Apply</button></span>
    </div>

    ${T.missingCost ? `<div class="notice">${T.missingCost} sold item(s) have no cost price, so they count as $0 cost. Add cost prices in <a href="#products" data-go="products">Products</a> for exact profit.</div>` : ""}

    <div class="kpi-grid">
      ${tile("Revenue", money(T.revenue), `${T.orders} paid order(s) · avg ${money(T.avgOrder)}`)}
      ${tile("Product cost", money(T.cost), `${T.items} item(s) sold`)}
      ${tile("Gross profit", money(T.profit), `${pct(T.margin)} margin`, T.profit >= 0 ? "pos" : "neg")}
      ${tile("Other expenses", money(T.expenses), `${A.expenses.length} entr${A.expenses.length === 1 ? "y" : "ies"}`)}
      ${tile("Net profit", money(T.netProfit), "gross profit − expenses", T.netProfit >= 0 ? "pos hero" : "neg hero")}
    </div>
    <div class="kpi-grid small">
      ${tile("Retail sales", money(T.guestRevenue), "buyers and guests, 1 pc price")}
      ${tile("Reseller sales", money(T.resellerRevenue), `${money(T.discounts)} given as reseller discount`)}
      ${tile("Balance top-ups", money(T.topups), "money received into reseller wallets")}
      ${tile("Reseller balances now", money(T.balances), "owed to resellers as credit")}
      ${tile("Unpaid orders", A.pending, "waiting for payment")}
    </div>

    <div class="card panel">
      <h3>Revenue & profit per day</h3>
      ${dailyChart(A.byDay, from, to)}
    </div>

    <div class="dash-two">
      <div class="card panel table-wrap">
        <h3>Profit by product</h3>
        ${A.byProduct.length ? `<table>
          <thead><tr><th>Product</th><th>Sold</th><th>Revenue</th><th>Cost</th><th>Profit</th><th>Margin</th></tr></thead>
          <tbody>${A.byProduct.map((p) => `<tr><td><b>${esc(p.name)}</b><br><span class="muted small">${esc(p.plan)}</span></td><td>${p.qty}</td><td>${money(p.revenue)}</td><td class="muted">${money(p.cost)}</td><td class="${p.profit >= 0 ? "amt-plus" : "amt-minus"}">${money(p.profit)}</td><td>${pct(p.revenue ? (p.profit / p.revenue) * 100 : 0)}</td></tr>`).join("")}</tbody>
        </table>` : `<p class="muted">No sales in this period.</p>`}
      </div>
      <div class="dash-side">
        <div class="card panel table-wrap">
          <h3>By payment method</h3>
          ${A.byMethod.length ? `<table><tbody>${A.byMethod.map((m) => `<tr><td>${esc(m.method)}</td><td class="muted">${m.orders} order(s)</td><td><b>${money(m.revenue)}</b></td></tr>`).join("")}</tbody></table>` : `<p class="muted">No sales yet.</p>`}
        </div>
        <div class="card panel">
          <h3>Other expenses</h3>
          <form class="exp-form" id="exp-form">
            <input type="date" name="date" value="${isoDay(new Date())}" required>
            <input name="note" placeholder="e.g. Facebook ads" maxlength="120">
            <input name="amount" type="number" step="0.01" min="0.01" placeholder="$" required>
            <button class="btn btn-primary">Add</button>
          </form>
          <div class="exp-list">${A.expenses.length ? A.expenses.map((x) => `
            <div class="exp-item"><span class="muted small">${x.date}</span><span>${esc(x.note)}</span><b>${money(x.amount)}</b><button class="icon-btn" data-exp="${esc(x.id)}" aria-label="Delete">${ICON.trash}</button></div>`).join("") : `<p class="muted small">No expenses in this period.</p>`}</div>
        </div>
      </div>
    </div>`;

  bindChartHover(el, filled);
  $$("[data-range]", el).forEach((b) => b.addEventListener("click", () => { dashRange = { key: b.dataset.range }; reload(); }));
  $("#r-apply", el).addEventListener("click", () => { dashRange = { key: "custom", from: $("#r-from", el).value, to: $("#r-to", el).value }; reload(); });
  $$("[data-go]", el).forEach((a) => a.addEventListener("click", (e) => { e.preventDefault(); $(`[data-sec="${a.dataset.go}"]`).click(); }));
  $("#exp-form", el).addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const { ok, data } = await jsonPost(api, "/api/admin/expenses/add", { date: f.get("date"), note: f.get("note"), amount: f.get("amount") });
    toast(ok ? "Expense added" : esc(data.error || "Failed"));
    if (ok) reload();
  });
  $$("[data-exp]", el).forEach((b) => b.addEventListener("click", async () => {
    if (!confirm("Delete this expense?")) return;
    await jsonPost(api, "/api/admin/expenses/delete", { id: b.dataset.exp });
    reload();
  }));
}

/* ======================= Products ======================= */

// Margin cell: profit % and $ per piece at the 1 pc price and at the reseller (2+) price
function marginHtml(cost, price, bulk) {
  const has = (x) => x !== null && x !== undefined && x !== "" && Number(x) > 0;
  if (cost === null || cost === undefined || cost === "") return `<span class="muted">add cost</span>`;
  const line = (label, p) => {
    if (!has(p)) return "";
    const profit = Number(p) - Number(cost), m = (profit / Number(p)) * 100;
    return `<span class="${profit < 0 ? "amt-minus" : "amt-plus"}">${label} ${pct(m)} <small>(${profit < 0 ? "−" : "+"}${money(Math.abs(profit))})</small></span>`;
  };
  const out = line("1 pc", price) + line("2+", bulk);
  return out || `<span class="muted">add price</span>`;
}
let prodState = { q: "", cat: "", editing: null };

async function adminProducts(ctx) {
  const { el, api } = ctx;
  const [cat, st] = await Promise.all([api("/api/admin/catalog").then((r) => r.json()), api("/api/admin/stock").then((r) => r.json())]);
  const stockOf = Object.fromEntries(st.plans.map((p) => [p.key, p.items.length]));
  if (prodState.editing !== null) {
    ctx.supplier = await api("/api/admin/supplier").then((r) => r.json()).catch(() => null);
    return productEditor(ctx, cat, stockOf);
  }

  const q = prodState.q.toLowerCase();
  const list = cat.PRODUCTS.filter((p) => (!prodState.cat || p.category === prodState.cat) && (!q || (p.name + " " + p.slug).toLowerCase().includes(q)));
  const range = (arr) => { const a = arr.filter((x) => x !== null && x !== undefined); if (!a.length) return "—"; const lo = Math.min(...a), hi = Math.max(...a); return lo === hi ? money(lo) : `${money(lo)} – ${money(hi)}`; };

  el.innerHTML = `
    <div class="filter-row">
      <input class="search-in" id="p-q" placeholder="Search products" value="${esc(prodState.q)}">
      <select id="p-cat"><option value="">All categories</option>${cat.CATEGORIES.map((c) => `<option ${c === prodState.cat ? "selected" : ""}>${esc(c)}</option>`).join("")}</select>
      <span style="margin-left:auto"></span>
      <button class="btn btn-primary" id="p-add">${ICON.plus} Add product</button>
    </div>
    <div class="card table-wrap">
      <table class="prod-table">
        <thead><tr><th></th><th>Product</th><th>Category</th><th>Plans</th><th>Cost</th><th>Selling price</th><th>Reseller 2+</th><th>Stock</th><th></th></tr></thead>
        <tbody>${list.map((p) => {
          const stock = p.variants.reduce((a, v) => a + (v.source || v.manual ? v.stock || 0 : stockOf[`${p.slug}|${v.pkg}|${v.duration}`] || 0), 0);
          const noCost = p.variants.some((v) => v.cost === null || v.cost === undefined);
          const linked = p.variants.some((v) => v.source);
return `<tr data-slug="${esc(p.slug)}">
            <td>${productIcon(p, "sm")}</td>
            <td><b>${esc(p.name)}</b>${p.isNew ? ' <span class="tag tag-new">New</span>' : ""}${linked ? ' <span class="tag tag-sup">🔗 PixelSub</span>' : ""}<br><span class="muted small">${esc(p.slug)}</span></td>
            <td class="muted">${esc(p.category)}</td>
            <td>${p.variants.length}</td>
            <td class="${noCost ? "bal-short" : "muted"}">${noCost ? "missing" : range(p.variants.map((v) => v.cost))}</td>
            <td><b>${range(p.variants.map((v) => v.price))}</b></td>
            <td>${range(p.variants.map((v) => v.bulkPrice))}</td>
            <td><b class="${stock ? "" : "bal-short"}">${stock}</b></td>
            <td class="tu-actions"><button class="btn btn-outline" data-edit>Edit</button> <button class="icon-btn" data-delp aria-label="Delete">${ICON.trash}</button></td>
          </tr>`;
        }).join("") || `<tr><td colspan="9" class="muted">No products found.</td></tr>`}</tbody>
      </table>
    </div>
    <p class="muted small">${cat.PRODUCTS.length} product(s). Cost prices are only visible here and are never sent to customers.</p>`;

  const q$ = $("#p-q", el);
  q$.addEventListener("input", () => { prodState.q = q$.value; adminProducts(ctx).then(() => { const n = $("#p-q", el); n.focus(); n.setSelectionRange(n.value.length, n.value.length); }); });
  $("#p-cat", el).addEventListener("change", (e) => { prodState.cat = e.target.value; adminProducts(ctx); });
  $("#p-add", el).addEventListener("click", () => { prodState.editing = ""; adminProducts(ctx); });
  $$("[data-edit]", el).forEach((b) => b.addEventListener("click", () => { prodState.editing = b.closest("tr").dataset.slug; adminProducts(ctx); }));
  $$("[data-delp]", el).forEach((b) => b.addEventListener("click", async () => {
    const slug = b.closest("tr").dataset.slug, p = cat.PRODUCTS.find((x) => x.slug === slug);
    if (!confirm(`Delete "${p.name}"? Its unsold stock will be deleted too. Past orders stay.`)) return;
    const { ok, data } = await jsonPost(api, "/api/admin/products/delete", { slug });
    toast(ok ? `Deleted ${esc(p.name)}${data.removedStock ? ` · ${data.removedStock} stock item(s) removed` : ""}` : esc(data.error || "Failed"));
    adminProducts(ctx);
  }));
}

function productEditor(ctx, cat, stockOf) {
  const { el, api } = ctx;
  const orig = prodState.editing ? cat.PRODUCTS.find((p) => p.slug === prodState.editing) : null;
  const p = orig ? JSON.parse(JSON.stringify(orig)) : {
    name: "", slug: "", category: cat.CATEGORIES[0], short: "", icon: "", color: "#2563eb", image: "", sold: 0, isNew: true, popular: false, terms: [],
    variants: [{ pkg: "Shared", duration: "1 Month", cost: null, price: null, bulkPrice: null, warranty: "30 Days" }],
  };
  p.variants.forEach((v) => (v.origKey = orig ? `${orig.slug}|${v.pkg}|${v.duration}` : ""));
  let slugTouched = !!orig;

  const pxProducts = ((ctx.supplier && ctx.supplier.pixelsub && ctx.supplier.pixelsub.products) || []);
  const isPx = (src) => !!src && src.type === "pixelsub";
  const pxById = Object.fromEntries(pxProducts.map((s) => [s.variant_id, s]));

  // PixelSub plans: price and stock are exactly PixelSub's (no markup) — preview only; the server recalculates on save and on every order
  const quote = (src) => {
    const s = isPx(src) && pxById[src.variantId];
    if (!s) return null;
    const p = Math.max(0.01, Math.round(s.price * 10000) / 10000);
    return { s, cost: p, price: p, bulk: null };
  };

  const supRow = (v, i) => {
    const q = quote(v.source);
    const opts = pxProducts.map((s) => `<option value="${esc(s.variant_id)}" ${v.source.variantId === s.variant_id ? "selected" : ""}>${esc(s.product)} — ${money(s.usd)} · stock ${s.stock >= 999 ? "∞" : s.stock}</option>`);
    return `<tr class="sup-row" data-i="${i}"><td colspan="10">
      <div class="sup-link">
        <span class="sup-tag">🔗 PixelSub API</span>
        <select data-s="variantId"><option value="">— choose product —</option>${opts.join("")}</select>
        <span class="sup-preview">${q ? `PixelSub price <b>${money(q.price)}</b> (site = same) · stock <b>${q.s.available ? q.s.stock : 0}</b>` : pxProducts.length ? "Choose a PixelSub product" : `<span class="bal-short">PixelSub not connected — see the Supplier page</span>`}</span>
      </div>
    </td></tr>`;
  };

  const vRow = (v, i) => {
    const key = `${p.slug}|${v.pkg}|${v.duration}`;
    const linked = !!v.source, q = linked ? quote(v.source) : null;
    const show = (k) => (q ? (k === "cost" ? q.cost : k === "price" ? q.price : q.bulk) : v[k]);
    const mode = linked ? "px" : v.manual ? "manual" : "";
    return `<tr data-i="${i}" class="${linked ? "linked" : ""}">
      <td><input data-f="pkg" value="${esc(v.pkg || "")}" placeholder="Shared"></td>
      <td><input data-f="duration" value="${esc(v.duration || "")}" placeholder="1 Month"></td>
      <td><input data-f="cost" type="number" step="0.01" min="0" value="${show("cost") ?? ""}" placeholder="0.00" ${linked ? "readonly title=\"From PixelSub\"" : ""}></td>
      <td><input data-f="price" type="number" step="0.01" min="0.01" value="${show("price") ?? ""}" placeholder="0.00" ${linked ? "readonly title=\"PixelSub price\"" : "required"}></td>
      <td><input data-f="bulkPrice" type="number" step="0.01" min="0.01" value="${show("bulkPrice") ?? ""}" placeholder="optional" ${linked ? "readonly" : ""}></td>
      <td class="mg">${marginHtml(show("cost"), show("price"), show("bulkPrice"))}</td>
      <td><input data-f="warranty" value="${esc(v.warranty || "")}" placeholder="30 Days"></td>
      <td><select data-f="delivery"><option value="">⚡ Auto (my stock)</option><option value="manual" ${mode === "manual" ? "selected" : ""}>Manual</option><option value="px" ${mode === "px" ? "selected" : ""}>🔗 PixelSub API</option></select></td>
      <td>${linked ? `<span class="muted small">${q ? (q.s.available ? q.s.stock : 0) : 0} live</span>` : v.manual ? `<input data-f="stock" type="number" min="0" step="1" value="${v.stock ?? 0}" class="w-num">` : `<span class="muted small">${stockOf[v.origKey || key] || 0} in stock</span>`}</td>
      <td><button type="button" class="icon-btn" data-rmv aria-label="Remove plan">${ICON.trash}</button></td>
    </tr>${linked ? supRow(v, i) : ""}`;
  };

  const render = () => {
    el.innerHTML = `
      <form class="prod-editor" id="prod-form">
        <div class="pe-top">
          <button type="button" class="btn btn-outline" id="pe-back">← All products</button>
          <h2>${orig ? `Edit: ${esc(orig.name)}` : "New product"}</h2>
          <span style="margin-left:auto"></span>
          ${orig ? `<button type="button" class="btn btn-outline danger" id="pe-del">${ICON.trash} Delete</button>` : ""}
          <button class="btn btn-primary" id="pe-save">Save product</button>
        </div>
        <div class="form-error" id="pe-err" hidden></div>

        <div class="pe-grid">
          <div class="card panel pe-main">
            <h3>Details</h3>
            <div class="two-col">
              <label>Product name<input name="name" value="${esc(p.name)}" required maxlength="80" placeholder="Netflix Premium"></label>
              <label>URL slug<input name="slug" value="${esc(p.slug)}" required maxlength="60" placeholder="netflix-premium"></label>
            </div>
            <div class="two-col">
              <label>Category<select name="category">${cat.CATEGORIES.map((c) => `<option ${c === p.category ? "selected" : ""}>${esc(c)}</option>`).join("")}</select></label>
              <label>Sold count (shown on site)<input name="sold" type="number" min="0" value="${p.sold || 0}"></label>
            </div>
            <label>Short description<textarea name="short" rows="2" maxlength="300">${esc(p.short || "")}</textarea></label>
            <label>Terms — one per line <span class="muted small">(PixelSub plans show the description from the PixelSub bot instead)</span><textarea name="terms" rows="4" placeholder="Private account&#10;Don't change the password">${esc((p.terms || []).join("\n"))}</textarea></label>
            <div class="checks">
              <label class="chk"><input type="checkbox" name="isNew" ${p.isNew ? "checked" : ""}> Show “New” badge</label>
              <label class="chk"><input type="checkbox" name="popular" ${p.popular ? "checked" : ""}> Popular</label>
            </div>
          </div>
          <div class="card panel pe-side">
            <h3>Image</h3>
            <div class="pe-preview" style="--c:${esc(p.color)}">${p.image ? `<img src="${esc(p.image)}" alt="">` : `<span class="pc-logo" style="--c:${esc(p.color)}">${esc(p.icon || (p.name || "?").slice(0, 1))}</span>`}</div>
            <label class="btn btn-outline btn-block upload-btn">Upload logo<input type="file" id="pe-file" accept="image/png,image/jpeg,image/webp,image/gif" hidden></label>
            ${p.image ? `<button type="button" class="btn btn-outline btn-block" id="pe-noimg">Remove image</button>` : ""}
            <div class="two-col">
              <label>Letters (no image)<input name="icon" value="${esc(p.icon || "")}" maxlength="3" placeholder="N"></label>
              <label>Color<input name="color" type="color" value="${/^#[0-9a-f]{6}$/i.test(p.color) ? p.color : "#2563eb"}"></label>
            </div>
          </div>
        </div>

        <div class="card panel">
          <div class="pe-plans-head"><h3>Plans & prices</h3><button type="button" class="btn btn-outline" id="pe-addv">${ICON.plus} Add plan</button></div>
          <div class="table-wrap">
            <table class="plans-table">
              <thead><tr><th>Package</th><th>Duration</th><th>Cost price</th><th>Selling price (1 pc)</th><th>Reseller price (2+)</th><th>Margin</th><th>Warranty</th><th>Delivery</th><th>Stock</th><th></th></tr></thead>
              <tbody>${p.variants.map(vRow).join("")}</tbody>
            </table>
          </div>
          <p class="muted small">Cost price = what the account costs you (private, used for profit reports). Leave reseller price empty for one flat price.
          ⚡ Auto plans are delivered from Stock right after payment; Manual plans are delivered by you and use the stock number you type here.</p>
        </div>
      </form>`;
    bind();
  };

  const readForm = () => {
    const f = $("#prod-form", el);
    p.name = f.name.value; p.slug = f.slug.value; p.category = f.category.value; p.sold = f.sold.value;
    p.short = f.short.value; p.terms = f.terms.value.split("\n"); p.isNew = f.isNew.checked; p.popular = f.popular.checked;
    p.icon = f.icon.value; p.color = f.color.value;
    $$(".plans-table tbody tr", el).forEach((tr) => {
      const v = p.variants[+tr.dataset.i];
      $$("[data-f]", tr).forEach((inp) => {
        const k = inp.dataset.f;
        if (k === "delivery") {
          v.manual = inp.value === "manual";
          const want = inp.value === "px" ? "pixelsub" : "";
          if (want) {
            if (!v.source || v.source.type !== want) v.source = { type: want, variantId: "", markup: 0, resellerMarkup: null };
          } else delete v.source;
        } else if (["cost", "price", "bulkPrice"].includes(k)) v[k] = inp.value === "" ? null : Number(inp.value);
        else if (k === "stock") v.stock = Number(inp.value) || 0;
        else v[k] = inp.value;
      });
      // Supplier link settings (the row under a linked plan)
      $$("[data-s]", tr).forEach((inp) => {
        if (!v.source) return;
        const k = inp.dataset.s;
        v.source[k] = k === "variantId" ? inp.value : inp.value === "" ? (k === "markup" ? 0 : null) : Number(inp.value);
      });
    });
  };

  const bind = () => {
    const f = $("#prod-form", el);
    f.name.addEventListener("input", () => { if (!slugTouched) f.slug.value = slugify(f.name.value); });
    f.slug.addEventListener("input", () => (slugTouched = true));
    $("#pe-back", el).addEventListener("click", () => { prodState.editing = null; adminProducts(ctx); });
    $("#pe-addv", el).addEventListener("click", () => { readForm(); p.variants.push({ pkg: "", duration: "", cost: null, price: null, bulkPrice: null, warranty: "30 Days", origKey: "" }); render(); });
    $$("[data-rmv]", el).forEach((b) => b.addEventListener("click", () => {
      readForm();
      if (p.variants.length === 1) return toast("A product needs at least one plan");
      const v = p.variants[+b.closest("tr").dataset.i];
      if (v.origKey && stockOf[v.origKey] && !confirm(`This plan has ${stockOf[v.origKey]} account(s) in stock. Remove the plan anyway? (Its stock stays saved under the old name.)`)) return;
      p.variants.splice(+b.closest("tr").dataset.i, 1); render();
    }));
    $$('.plans-table select[data-f="delivery"], .plans-table [data-s]', el).forEach((s) => s.addEventListener("change", () => { readForm(); render(); }));
    $$('.plans-table input[data-f="cost"], .plans-table input[data-f="price"], .plans-table input[data-f="bulkPrice"]', el).forEach((inp) => inp.addEventListener("input", () => {
      const tr = inp.closest("tr"), val = (f) => $(`[data-f="${f}"]`, tr).value;
      $(".mg", tr).innerHTML = marginHtml(val("cost"), val("price"), val("bulkPrice"));
    }));
    $("#pe-file", el).addEventListener("change", async (e) => {
      const file = e.target.files[0]; if (!file) return;
      if (file.size > 2_000_000) return toast("Image must be smaller than 2 MB");
      readForm();
      const data = await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(file); });
      const r = await jsonPost(api, "/api/admin/upload", { data });
      if (!r.ok) return toast(esc(r.data.error || "Upload failed"));
      p.image = r.data.path; render(); toast("Image uploaded — remember to save");
    });
    const noimg = $("#pe-noimg", el);
    if (noimg) noimg.addEventListener("click", () => { readForm(); p.image = ""; render(); });
    const del = $("#pe-del", el);
    if (del) del.addEventListener("click", async () => {
      if (!confirm(`Delete "${orig.name}"? Its unsold stock will be deleted too.`)) return;
      const { ok, data } = await jsonPost(api, "/api/admin/products/delete", { slug: orig.slug });
      if (!ok) return toast(esc(data.error || "Failed"));
      toast(`Deleted ${esc(orig.name)}`); prodState.editing = null; adminProducts(ctx);
    });
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      readForm();
      const err = $("#pe-err", el); err.hidden = true;
      const btn = $("#pe-save", el); btn.disabled = true; btn.textContent = "Saving…";
      const { ok, data } = await jsonPost(api, "/api/admin/products/save", { originalSlug: orig ? orig.slug : "", product: p });
      btn.disabled = false; btn.textContent = "Save product";
      if (!ok) { err.textContent = data.error || "Could not save."; err.hidden = false; err.scrollIntoView({ block: "center" }); return; }
      toast(`Saved ${esc(data.product.name)} — live on the site now`);
      prodState.editing = null; adminProducts(ctx);
    });
  };

  render();
}

/* ======================= Supplier (PixelSub API) ======================= */
async function adminSupplierView(ctx) {
  const { el, api, reload } = ctx;
  const [S, cat] = await Promise.all([api("/api/admin/supplier").then((r) => r.json()), api("/api/admin/catalog").then((r) => r.json())]);

  // PixelSub API (prices in USD). The site shows exactly PixelSub's price and stock; new products are added automatically.
  const PX = S.pixelsub || { configured: false, products: [] };
  if (!PX.configured) {
    el.innerHTML = `<div class="card panel">
      <h3>Connect PixelSub API</h3>
      <p>Add the key to the server's <code>.env</code> file (or Railway variables) and restart:</p>
      <pre class="code">PIXELSUB_API_KEY=...</pre>
      <p class="muted small">Then every PixelSub product appears on the site automatically, with PixelSub's own price and stock (no markup).</p>
    </div>`;
    return;
  }
  el.innerHTML = `<div class="card panel">
      <div class="pe-plans-head"><h3>PixelSub API supplier</h3><button class="btn btn-outline" id="sup-retry">↻ Retry failed supplier orders</button></div>
      <p class="muted small">Balance: <b>${PX.balance === null ? "—" : money(PX.balance)}</b> · ${PX.products.length} products · ${PX.products.filter((s) => s.available).length} in stock${PX.updatedAt ? " · updated " + fmtDate(PX.updatedAt) : ""}.
      The site shows PixelSub's price and stock exactly (no markup). New PixelSub products are added to the store automatically.</p>
      ${PX.error ? `<div class="form-error">PixelSub API error: ${esc(PX.error)}</div>` : ""}${PX.balanceError ? `<div class="form-error">Balance: ${esc(PX.balanceError)}</div>` : ""}
      <form class="sup-import" id="px-import">
        <span>Add selected to my store →</span>
        <select name="category">${cat.CATEGORIES.map((c) => `<option>${esc(c)}</option>`).join("")}</select>
        <input name="group" maxlength="80" placeholder="One product name (optional)" title="Leave empty: each selected item becomes its own product. Fill in: all selected become plans of one product.">
        <button class="btn btn-primary" id="px-add" disabled>Add 0 selected</button>
      </form>
      <div class="table-wrap"><table class="sup-table">
        <thead><tr><th></th><th>ID</th><th>Product</th><th>Price (site = same)</th><th>Stock</th><th>In your store</th></tr></thead>
        <tbody>${PX.products.map((s) => `<tr class="${s.available ? "" : "muted"}"><td>${s.linkedTo.length ? "" : `<input type="checkbox" data-px="${esc(s.variant_id)}">`}</td><td>${esc(s.variant_id)}</td><td><b>${esc(s.product)}</b></td><td><b>${money(s.usd)}</b></td>
          <td>${s.available ? `<b>${s.stock >= 999 ? "unlimited" : s.stock}</b>` : '<span class="bal-short">out</span>'}</td>
          <td>${s.linkedTo.length ? s.linkedTo.map((l) => `<a href="#products" data-editp="${esc(l.slug)}">${esc(l.name)}</a> <span class="muted small">${esc(l.plan)}</span>`).join("<br>") : '<span class="muted small">—</span>'}</td></tr>`).join("")}</tbody>
      </table></div>
    </div>`;

  const boxes = $$("[data-px]", el), btn = $("#px-add", el);
  const sync = () => { const n = boxes.filter((b) => b.checked).length; btn.disabled = !n; btn.textContent = `Add ${n} selected`; };
  boxes.forEach((b) => b.addEventListener("change", sync));
  $("#px-import", el).addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    btn.disabled = true; btn.textContent = "Adding…";
    const { ok, data } = await jsonPost(api, "/api/admin/supplier/px-import", { ids: boxes.filter((b) => b.checked).map((b) => b.dataset.px), category: f.category.value, group: f.group.value });
    toast(ok ? `Added ${data.added} plan(s) (${data.created} new product(s)) — live on the site. Edit names, logos and terms in Products.` : esc(data.error || "Failed"));
    reload();
  });
  $("#sup-retry", el).addEventListener("click", async () => {
    const { ok, data } = await jsonPost(api, "/api/admin/supplier/retry", {});
    toast(ok ? (data.retried ? `Retried ${data.retried} order(s) — check Orders` : "No failed supplier orders") : esc(data.error || "Failed"));
  });
  $$("[data-editp]", el).forEach((a) => a.addEventListener("click", (e) => { e.preventDefault(); prodState.editing = a.dataset.editp; $('[data-sec="products"]').click(); }));
}

/* ======================= Settings ======================= */
async function adminSettings({ el, api, reload }) {
  const cat = await api("/api/admin/catalog").then((r) => r.json());
  const S = cat.SITE;
  const methods = Object.keys(S.paymentInfo);
  el.innerHTML = `
    <form id="set-form" class="set-grid">
      <div class="card panel">
        <h3>Store</h3>
        <label>Store name<input name="name" value="${esc(S.name)}" maxlength="40" required></label>
        <label>Domain<input name="domain" value="${esc(S.domain || "")}" maxlength="60" placeholder="pixelsub.shop"></label>      </div>
      <div class="card panel">
        <h3>Contact information</h3>
        <label>Support email<input name="email" type="email" value="${esc(S.email || "")}" maxlength="100"></label>
        <label>WhatsApp number (country code, digits only)<input name="whatsapp" value="${esc(S.whatsapp || "")}" inputmode="tel" placeholder="8801700000000"></label>
        <label>Telegram username<input name="telegram" value="${esc(S.telegram || "")}" placeholder="pixelsub"></label>
        <label>Bot link (used on the ad landing page)<input name="bot" value="${esc(S.bot || "")}" placeholder="https://t.me/yourbot" maxlength="200"></label>
        <p class="muted small">Shown in the footer, contact section and FAQ. The bot link is the main button on <code>/landing</code>; if empty, the Telegram username is used.</p>
      </div>
      <div class="card panel">
        <h3>Payment methods</h3>
        ${methods.map((m) => {
          const info = S.paymentInfo[m];
          return `<div class="pay-set">
            <label class="chk"><input type="checkbox" name="pm" value="${esc(m)}" ${S.payments.includes(m) ? "checked" : ""}> <b>${esc(m)}</b> ${info.redirect ? '<span class="muted small">(redirect, any crypto)</span>' : '<span class="muted small">(USDT, auto-checked)</span>'}</label>
            ${"value" in info ? `<label>${esc(info.label)}<input data-pid="${esc(m)}" value="${esc(info.value)}" maxlength="80"></label>` : ""}
          </div>`;
        }).join("")}
        <p class="muted small">API keys for automatic checking are set in the server's <code>.env</code> file, not here.</p>
      </div>
      <div class="card panel">
        <h3>Resellers</h3>
        <label>Reseller price starts from (pieces)<input name="bulkMinQty" type="number" min="2" step="1" value="${S.bulkMinQty}"></label>
        <div class="two-col">
          <label>Min. balance top-up ($)<input name="topupMin" type="number" min="0.01" step="0.01" value="${S.topupMin}"></label>
          <label>Max. balance top-up ($)<input name="topupMax" type="number" min="1" step="0.01" value="${S.topupMax}"></label>
        </div>
      </div>
      <div class="card panel">
        <h3>Categories</h3>
        <label>One per line (order = order on the site)<textarea name="categories" rows="6">${esc(cat.CATEGORIES.join("\n"))}</textarea></label>
        <p class="muted small">A category that still has products can't be removed.</p>
      </div>
      <div class="set-actions">
        <div class="form-error" id="set-err" hidden></div>
        <button class="btn btn-primary" id="set-save">Save settings</button>
      </div>
    </form>`;

  $("#set-form", el).addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target, err = $("#set-err", el);
    err.hidden = true;
    const paymentIds = {};
    $$("[data-pid]", f).forEach((i) => (paymentIds[i.dataset.pid] = i.value));
    const body = {
      site: {
        name: f.name.value, domain: f.domain.value,
        email: f.email.value, whatsapp: f.whatsapp.value, telegram: f.telegram.value, bot: f.bot.value,
        bulkMinQty: f.bulkMinQty.value, topupMin: f.topupMin.value, topupMax: f.topupMax.value,
        payments: $$('[name="pm"]:checked', f).map((c) => c.value), paymentIds,
      },
      categories: f.categories.value.split("\n"),
    };
    const { ok, data } = await jsonPost(api, "/api/admin/settings", body);
    if (!ok) { err.textContent = data.error || "Could not save."; err.hidden = false; return; }
    toast("Settings saved — live on the site now");
    reload();
  });
}

window.ADMIN_EXTRA = { dashboard: adminDashboard, products: adminProducts, supplier: adminSupplierView, settings: adminSettings };
