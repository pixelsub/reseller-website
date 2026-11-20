# PixelSub (pixelsub.shop) — reseller storefront

Plain HTML/CSS/JS site with a small Node.js server (no npm packages) that stores orders.

## Run
1. Copy `.env.example` to `.env` and fill it in (admin key, PUBLIC_URL, Binance / Bybit / Cryptomus keys).
2. Start:
```
node --env-file-if-exists=.env server.js
```
Then open http://localhost:5173

`.env` settings:
- `ADMIN_KEY` — password for the admin panel. **Default is `change-me` — set your own before going live.**
- `PUBLIC_URL` — your live address, e.g. `https://pixelsub.shop` (Cryptomus sends customers back here and calls `/api/cryptomus/webhook`).
- `BINANCE_API_KEY` / `BINANCE_API_SECRET` — Binance key with **"Enable Reading" only** (no trading/withdrawal), IP-restricted.
- `BYBIT_API_KEY` / `BYBIT_API_SECRET` — Bybit **read-only** key (wallet history), IP-restricted.
- `CRYPTOMUS_MERCHANT_ID` / `CRYPTOMUS_PAYMENT_API_KEY` (or `CRYPTOMUS_API_KEY`) — Cryptomus merchant ID and Payment API key.
- `PORT` — default 5173

## Currency & payments
All prices are in **US dollars** and paid 1:1 in USDT. Three methods, all confirmed automatically:
- **Binance Pay** — checkout shows your Pay ID and the USDT amount (tap-to-copy). The customer pays and enters the **Binance Order ID**; the server finds it in your Binance Pay history (`/sapi/v1/pay/transactions`).
- **Bybit** — checkout shows your Bybit UID and amount. The customer sends USDT by internal transfer (Send to Bybit user / UID) and enters the **transfer ID**; the server finds it in `/v5/asset/deposit/query-internal-record` (must be USDT and status "success").
- **Cryptomus** — no ID to copy: the customer is redirected to a Cryptomus invoice and can pay with 100+ coins. Cryptomus calls `/api/cryptomus/webhook` (signature checked), and the server re-confirms with `/v1/payment/info` before marking it paid. When the customer comes back, the order page checks again automatically.
- For Binance/Bybit a payment must be at least the order amount, incoming, and its ID can be used only once (across orders and balance top-ups).
- If a payment isn't found yet, the customer can press "Check payment again"; the admin can press "Check payment now".
- Delivering the account (pasting the details in the admin panel) is still done by you.
## Automatic delivery (stock)
- Admin panel → **Stock**: pick a product plan and paste accounts, **one per line** (e.g. `email@mail.com:password | Profile 2`). Duplicates are skipped.
- The site's "X left" for these plans is the real number of accounts in stock; you can't sell more than you have.
- When a payment is confirmed (Binance / Bybit / Cryptomus / balance, or when you set an order to "Payment verified" by hand) the server takes the accounts from stock, writes them into the order and marks it **Delivered**. The customer sees them on the order page immediately (with a copy button).
- If stock ran out before the payment was confirmed, the order waits in "Payment verified"; as soon as you add stock for that plan it is delivered automatically (or press "Deliver waiting orders now").
- Plans with `manual: true` in `data.js` (invites / activation on the customer's own email or number) are never auto-delivered — paste the details in the order yourself.
- Stock lives in `storage/stock.json` (private). Stock is matched by product slug + package + duration, so renaming a plan in `data.js` needs its stock re-added.

## Supplier: PixelSub API (live price & stock, no markup)
Set `PIXELSUB_API_KEY` in `.env` (the same PixelSub account your Telegram bot uses) and restart.
- **No markup:** the site shows exactly the price and stock PixelSub returns. Any price calculation (reseller discounts etc.) is done in the PixelSub admin panel, not here.
- **Auto-add:** every PixelSub product is added to the store automatically (a plan linked to it, name/duration guessed from its title, category guessed from keywords). Products you delete are not added again. Set `PIXELSUB_AUTO_ADD=0` to turn this off.
- **Admin → Supplier:** PixelSub balance and the full catalogue with live price & stock; you can also add products by hand and press **Retry failed supplier orders**.
- **Description:** a PixelSub-linked plan shows the product description written in the PixelSub bot in the product page's terms box, exactly as written there (same lines and blank lines, refreshed every minute). Products without one show the terms typed in Admin → Products.
- Edit names, logos and terms in **Admin → Products** (a PixelSub-linked plan's price and stock are read-only).

How it works:
- The server refreshes PixelSub's price & stock every minute, and again (≤ 30 s old) right before pricing an order. Customers can't order more than PixelSub has.
- When an order is paid (Binance / Bybit / Cryptomus / balance / admin approval), the server **buys from PixelSub** (`POST /orders`, paid from your PixelSub balance) and delivers the returned accounts instantly. Each order line sends a `reference` (`<order id>-<line>`).
- If PixelSub refuses (e.g. not enough balance, out of stock), the order stays "Payment verified" and Admin → Orders shows the error with a **Retry** button; failed orders are also retried automatically every minute.
- The PixelSub price is saved as the order's cost.
- Cost prices and supplier links are never sent to customers.

## Hosting
Because orders are saved on the server, the site needs **Node.js hosting** (a VPS, cPanel "Setup Node.js App", Render, Railway…). Static-only hosts (Netlify/GitHub Pages) can't save orders.
Orders are stored in `storage/orders.json` — back this file up. It is never served to the public.

## Admin panel (`/admin.html`)
Log in with `ADMIN_KEY`. Sidebar sections:
- **Dashboard** — revenue, product cost, gross profit & margin, other expenses, **net profit**; guest vs reseller sales, top-ups, reseller balances owed; a revenue/profit-per-day chart; profit by product; sales by payment method. Filter: today / 7 days / 30 days / this month / all time / custom dates. Add or delete **other expenses** (ads, tools…) here.
- **Orders** — every order, payment check, status, delivery details.
- **Products** — add / edit / delete products. Per plan: package, duration, **cost price** (private), **selling price** (1 pc), **reseller price** (2+), live margin, warranty, ⚡ Auto or Manual delivery (+ stock for manual). Also name, slug, category, description, terms, “New”/“Popular”, logo upload (PNG/JPG/WEBP/GIF, max 2 MB → `assets/img/uploads/`) or letters + color.
- **Stock** — accounts for automatic delivery.
- **Balance requests** and **Resellers** — top-ups and reseller balances.
- **Settings** — store name, domain, working hours; **contact info** (email, WhatsApp, Telegram); payment methods on/off, Binance Pay ID, Bybit UID; reseller price start quantity, top-up limits; categories.

Every change is live on the site immediately.

### Where the data lives
- The catalogue (products, prices, costs, settings) is saved in `storage/catalog.json`. Until the first save in the admin panel, `assets/js/data.js` is used as the starting catalogue.
- The site always loads `/assets/js/data.js`; the server generates it from the catalogue **without cost prices**.
- Each order line stores the cost price at the time of sale, so profit reports stay correct after you change costs. Orders sold before a cost was entered use the current cost (the dashboard warns about items with no cost).
- Back up the whole `storage/` folder (orders, catalogue, accounts, stock, balances, expenses).

## Buyers vs resellers
- **Login is required to order** (no guest checkout): the server refuses `POST /api/orders` without a session, and the cart shows **Log in** / **Create free account** instead of the payment form; after logging in the customer comes back to the cart.
- **Email login:** accounts are created with an **email** (it is the login; stored as the account's `username`). The server checks the format and that the email's domain exists and accepts mail (DNS MX lookup — e.g. `gmail.con` is refused); if the server's own DNS lookup fails, the email is accepted. Ownership is not confirmed (no email is sent). Accounts made before this change keep their username and log in with it in the same field.
- **Buyer account:** `login.html?mode=signup` ("Create account") — only an email and password, ready right away. Always pays the **1 pc price**, whatever the quantity. Buyers are listed in **Admin → Resellers → Buyers** and can apply to the reseller program later from their profile. Old guest orders (from before this change) still open with their order link.
- **Forgot password:** the login page links to the shop's Telegram with the request typed in. In **Admin → Resellers** press **Reset password** under the account: a temporary password is shown once (with a ready-to-send message). The old password stops working and the account is logged out everywhere; after logging in with the temporary password the customer is sent to **Settings** to choose their own.
- **Reseller program (by approval):** anyone can create an account at `login.html` ("Apply as reseller") with an email, password and the link of their **website or bot** (required; a bot can be given as `@handle`). The account starts as **Pending**: it can order like a normal member (normal prices) but has **no reseller price and no wallet**. In **Admin → Resellers** the admin sees the link, contact and note under **Pending**, and presses **Approve** or **Reject** (with a reason shown to the applicant, who can fix the link and apply again). Only approved resellers get the 2+ price, the wallet and Balance payment; an approved reseller can later be **revoked**. One link can't be used by two active applications. Accounts created before this feature count as approved.
- Accounts are stored in `storage/users.json` (passwords hashed with scrypt); logins use an HttpOnly cookie for 30 days. 10 wrong logins per IP lock that IP for 15 minutes.

## Reseller profile & balance (`account.html`)
- **Overview** — balance, total orders, total spent, money saved with reseller prices, recent orders.
- **Add balance** — amount (`SITE.topupMin`–`SITE.topupMax`), payment method with tap-to-copy details, Transaction ID.
  Top-ups are added automatically once Binance / Bybit / Cryptomus confirms the payment (admin can also approve manually).
- **My orders**, **Balance history** (every top-up, order payment, refund and admin adjustment) and **Settings** (change password, log out).
- At checkout a logged-in reseller can choose **My balance**: the amount is deducted instantly and the order is marked paid.
- Admin panel → **Balance requests** (approve / reject / check payment) and **Resellers** (see balances, add or deduct money).
  Cancelling an order that was paid from balance refunds it automatically (once).
- Data: `storage/topups.json` (requests), `storage/wallet.json` (balance history); the balance itself is in `storage/users.json`.

## How ordering works
1. Customer adds products (Add to cart / Buy now) → cart.
2. Checkout shows where to send the money for the chosen method (tap-to-copy); customer pays and enters the **Binance Order ID / Bybit transfer ID** → **Place order** (Cryptomus: redirected to pay).
3. The server recalculates every price from `data.js` (2+ price only for logged-in resellers), saves the order and sends the customer to their private order page (`order.html?id=…&t=…`).
4. Admin opens **`/admin.html`**, enters the admin key, checks the TrxID, sets the status and pastes the account details → they appear on the customer's order page.

## Pages
- `index.html` — home: hero, catalogue (tabs + search), 2+ pricing, how to order, FAQ, contact
- `product.html?p=<slug>` — plan selector, 1 pc vs 2+ price, quantity, Add to cart / Buy now
- `cart.html` — cart with automatic bulk pricing and checkout
- `login.html` — login / join as reseller
- `account.html` — reseller profile: balance, add balance, orders, history, settings
- `order.html` — order status & delivered account details / list of my orders
- `admin.html` — admin panel (not linked from the site): dashboard, orders, products, stock, balances, resellers, settings
- `reseller.html` — reseller program, price list, application form
