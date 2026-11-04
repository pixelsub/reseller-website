/* =========================================================
   PixelSub — store configuration & product catalogue
   Edit this file to change prices, products, contact info.

   PRICING RULE (per variant), all prices in USD:
     price      -> price per piece when the customer buys 1
     bulkPrice  -> price per piece when a logged-in reseller buys 2 or more
   Leave bulkPrice out (or null) for products with one flat price.

   DELIVERY:
     Plans are delivered automatically from the stock you add in the admin panel (Stock tab),
     and the stock shown on the site is the real number of accounts in stock.
     manual: true -> plan needs you to act (invite to the customer's email etc.): delivered by you
                     from the admin panel, and the "stock" number here is what the site shows.
   ========================================================= */

const SITE = {
  name: "PixelSub",
  domain: "pixelsub.shop",
  currency: "$",
  bulkMinQty: 2,                    // quantity from which bulkPrice applies
  whatsapp: "8801857234526",        // WhatsApp number, country code, no + or spaces
  telegram: "pixelsub09",           // Telegram username without @
  email: "support@pixelsub.shop",
  hours: "10:00 AM – 12:00 AM (GMT+6)",
  payments: ["Binance Pay", "Bybit", "Cryptomus"],
  topupMin: 1,                      // reseller "Add balance" limits ($)
  topupMax: 1000,
  // Payment methods. Prices are in USD and paid 1:1 in USDT.
  //   provider "binance" / "bybit": customer sends USDT to the ID below, then enters the transfer ID -> checked via API
  //   provider "cryptomus": customer is sent to a Cryptomus invoice page and can pay with any crypto -> confirmed by webhook
  paymentInfo: {
    "Binance Pay": { label: "Binance Pay ID", value: "1067913841", provider: "binance" },
    "Bybit":       { label: "Bybit UID", value: "516771587", provider: "bybit" },
    "Cryptomus":   { provider: "cryptomus", redirect: true },
  },
};

const CATEGORIES = ["Streaming", "AI Tools", "Design & Content", "VPN", "Utilities"];

const PRODUCTS = [
  {
    slug: "capcut-pro", image: "assets/img/capcut.png", name: "CapCut Pro", category: "Design & Content", icon: "Cc", color: "#111827",
    short: "Watermark-free video editing with every CapCut Pro feature unlocked.",
    sold: 2150, isNew: false, popular: true,
    terms: ["Private account", "Up to 3 devices", "Don't log in on several devices at the same time", "Works on all devices"],
    variants: [
      { pkg: "Individual", duration: "1 Month",  price: 1.44, bulkPrice: 1.2, stock: 25, warranty: "30 Days" },
      { pkg: "Individual", duration: "6 Months", price: 7.6, bulkPrice: 6.8, stock: 6,  warranty: "60 Days" },
      { pkg: "Member",     duration: "1 Month",  price: 0.72,  bulkPrice: 0.56,  stock: 40, warranty: "30 Days" },
    ],
  },
  {
    slug: "canva-pro", image: "assets/img/canva.webp", name: "Canva Pro", category: "Design & Content", icon: "C", color: "#00C4CC",
    short: "Premium templates, brand kit, background remover and the full Canva Pro toolkit.",
    sold: 860, popular: true,
    terms: ["Invite to your own email", "All Pro features", "Works on web & mobile"],
    variants: [
      { pkg: "Invite", duration: "1 Month",  price: 0.48,  bulkPrice: 0.36,  stock: 60, manual: true, warranty: "30 Days" },
      { pkg: "Invite", duration: "1 Year",   price: 3.6, bulkPrice: 3.04, stock: 30, manual: true, warranty: "Full period" },
    ],
  },
  {
    slug: "chatgpt-plus", image: "assets/img/chatgpt.png", name: "ChatGPT Plus", category: "AI Tools", icon: "AI", color: "#10A37F",
    short: "Faster replies, the latest models, image generation and file analysis.",
    sold: 1240, popular: true,
    terms: ["Shared or private options", "Don't change the password", "Don't delete other chats (shared)"],
    variants: [
      { pkg: "Shared",  duration: "1 Month", price: 3.6,  bulkPrice: 3.12,  stock: 20, warranty: "30 Days" },
      { pkg: "Private", duration: "1 Month", price: 19.2, bulkPrice: 18, stock: 5,  warranty: "30 Days" },
    ],
  },
  {
    slug: "gemini-pro", image: "assets/img/gemini.webp", name: "Gemini Pro", category: "AI Tools", icon: "G", color: "#4F7DF3",
    short: "Google AI Pro with Gemini Advanced, 2 TB storage and Veo access.",
    sold: 540, isNew: true,
    terms: ["Activated on your own Gmail", "Includes 2 TB Google storage"],
    variants: [
      { pkg: "Own Email", duration: "1 Month",   price: 2,  bulkPrice: 1.6,  stock: 15, manual: true, warranty: "30 Days" },
      { pkg: "Own Email", duration: "12 Months", price: 12, bulkPrice: 10.4, stock: 8,  manual: true, warranty: "Full period" },
    ],
  },
  {
    slug: "supergrok", image: "assets/img/supergrok.png", name: "SuperGrok", category: "AI Tools", icon: "X", color: "#000000",
    short: "Grok's top tier with higher limits and the newest models.",
    sold: 120, isNew: true,
    terms: ["Private account", "Don't change account details"],
    variants: [
      { pkg: "Private", duration: "1 Month", price: 9.6, bulkPrice: 8.4, stock: 4, warranty: "30 Days" },
    ],
  },
  {
    slug: "leonardo-ai", image: "assets/img/leonardo-ai.png", name: "Leonardo AI", category: "AI Tools", icon: "L", color: "#7C3AED",
    short: "AI image and video generation with premium tokens every month.",
    sold: 210,
    terms: ["Shared account", "Fair-use token limit"],
    variants: [
      { pkg: "Shared", duration: "1 Month", price: 2.4, bulkPrice: 1.92, stock: 10, warranty: "30 Days" },
    ],
  },
  {
    slug: "netflix-premium", image: "assets/img/netflix.png", name: "Netflix Premium", category: "Streaming", icon: "N", color: "#E50914",
    short: "4K Ultra HD streaming. One profile, one screen, original account.",
    sold: 3020, popular: true,
    terms: ["1 profile, 1 device", "Don't change the profile PIN", "Don't change the password"],
    variants: [
      { pkg: "1 Screen", duration: "1 Month", price: 2.8, bulkPrice: 2.4, stock: 30, warranty: "30 Days" },
      { pkg: "1 Screen", duration: "3 Months", price: 7.92, bulkPrice: 7.04, stock: 12, warranty: "90 Days" },
    ],
  },
  {
    slug: "youtube-premium", image: "assets/img/youtube.webp", name: "YouTube Premium", category: "Streaming", icon: "▶", color: "#FF0000",
    short: "Ad-free YouTube, background play and YouTube Music included.",
    sold: 1780, popular: true,
    terms: ["Family invite to your Gmail", "Works on all devices"],
    variants: [
      { pkg: "Family Invite", duration: "1 Month",  price: 0.96,  bulkPrice: 0.76,  stock: 50, manual: true, warranty: "30 Days" },
      { pkg: "Family Invite", duration: "6 Months", price: 5.2,  bulkPrice: 4.48, stock: 20, manual: true, warranty: "Full period" },
    ],
  },
  {
    slug: "spotify-premium", image: "assets/img/spotify.png", name: "Spotify Premium", category: "Streaming", icon: "S", color: "#1DB954",
    short: "Ad-free music, offline downloads and unlimited skips.",
    sold: 990,
    terms: ["Individual account", "Works worldwide"],
    variants: [
      { pkg: "Individual", duration: "1 Month", price: 1.2, bulkPrice: 0.96, stock: 35, warranty: "30 Days" },
      { pkg: "Individual", duration: "3 Months", price: 3.36, bulkPrice: 2.88, stock: 15, warranty: "90 Days" },
    ],
  },
  {
    slug: "prime-video", image: "assets/img/prime-video.png", name: "Prime Video", category: "Streaming", icon: "P", color: "#00A8E1",
    short: "Amazon Originals, movies and series in HD on any device.",
    sold: 430,
    terms: ["1 profile", "Don't change the password"],
    variants: [
      { pkg: "Shared Profile", duration: "1 Month", price: 1.12, bulkPrice: 0.88, stock: 18, warranty: "30 Days" },
    ],
  },
  {
    slug: "hbo-max", image: "assets/img/hbo-max.png", name: "HBO Max", category: "Streaming", icon: "H", color: "#5822B4",
    short: "HBO Originals and blockbuster movies, stream in HD or download offline.",
    sold: 90, isNew: true,
    terms: ["1 profile", "Don't change the password"],
    variants: [
      { pkg: "Shared Profile", duration: "1 Month", price: 2.64, bulkPrice: 2.24, stock: 3, warranty: "30 Days" },
    ],
  },
  {
    slug: "expressvpn", name: "ExpressVPN", category: "VPN", icon: "E", color: "#DA3940",
    short: "Fast, private VPN with servers in 100+ countries.",
    sold: 640,
    terms: ["1 device", "Don't log out other devices"],
    variants: [
      { pkg: "1 Device", duration: "1 Month", price: 1.04, bulkPrice: 0.8, stock: 0,  warranty: "30 Days" },
      { pkg: "1 Device", duration: "6 Months", price: 4.8, bulkPrice: 4.16, stock: 9, warranty: "Full period" },
    ],
  },
  {
    slug: "surfshark-vpn", image: "assets/img/surfshark.webp", name: "Surfshark VPN", category: "VPN", icon: "S", color: "#178A9E",
    short: "Unlimited devices, ad blocker and secure browsing everywhere.",
    sold: 310,
    terms: ["Shared login", "Don't change the password"],
    variants: [
      { pkg: "Shared", duration: "1 Month", price: 0.88, bulkPrice: 0.68, stock: 22, warranty: "30 Days" },
    ],
  },
  {
    slug: "microsoft-office", name: "Microsoft Office License", category: "Utilities", icon: "O", color: "#D83B01",
    short: "Genuine Office license key for Word, Excel, PowerPoint and more.",
    sold: 270,
    terms: ["Lifetime license key", "1 PC activation"],
    variants: [
      { pkg: "Office 2021 Pro Plus", duration: "Lifetime", price: 4.4, bulkPrice: 3.6, stock: 40, warranty: "Activation" },
      { pkg: "Office 365", duration: "1 Year", price: 7.2, bulkPrice: 6.24, stock: 12, warranty: "Full period" },
    ],
  },
  {
    slug: "duolingo-super", image: "assets/img/duolingo.png", name: "Duolingo Super", category: "Utilities", icon: "D", color: "#58CC02",
    short: "No ads, unlimited hearts and personalised practice.",
    sold: 140,
    terms: ["Family invite", "Works on all devices"],
    variants: [
      { pkg: "Family Invite", duration: "1 Year", price: 3.2, bulkPrice: null, stock: 0, manual: true, warranty: "Full period" },
    ],
  },
  {
    slug: "alight-motion", image: "assets/img/alight-motion.png", name: "Alight Motion", category: "Design & Content", icon: "A", color: "#10B981",
    short: "Pro motion graphics, keyframes and effects without watermark.",
    sold: 150, isNew: true,
    terms: ["Your own account", "Works on Android & iOS"],
    variants: [
      { pkg: "Own Account", duration: "1 Year", price: 1.76, bulkPrice: 1.36, stock: 7, manual: true, warranty: "Full period" },
    ],
  },
  {
    slug: "paypal-account", image: "assets/img/paypal.webp", name: "New PayPal Account", category: "Utilities", icon: "P", color: "#253B80",
    short: "Freshly created PayPal account with verified email access, ready to use right after purchase.",
    sold: 387, isNew: true,
    terms: ["Email access included", "Change the password after login", "Not for illegal use"],
    variants: [
      { pkg: "Email Verified", duration: "Lifetime", price: 0.32, bulkPrice: 0.24, stock: 93, warranty: "Login" },
    ],
  },
  {
    slug: "wetv", image: "assets/img/wetv.webp", name: "WeTV VIP", category: "Streaming", icon: "W", color: "#1E90FF",
    short: "Full K-Drama & C-Drama library in HD with the latest episodes every day.",
    sold: 60,
    terms: ["Shared account", "Don't change the password"],
    variants: [
      { pkg: "Shared", duration: "1 Month", price: 1.04, bulkPrice: 0.8, stock: 5, warranty: "30 Days" },
    ],
  },
  {
    slug: "viu-premium", image: "assets/img/viu.png", name: "Viu Premium", category: "Streaming", icon: "V", color: "#F5B800",
    short: "Ad-free Asian dramas and variety shows with HD streaming and downloads.",
    sold: 75,
    terms: ["Shared account", "Don't change the password"],
    variants: [
      { pkg: "Shared", duration: "1 Month", price: 0.88, bulkPrice: 0.68, stock: 12, warranty: "30 Days" },
    ],
  },
  {
    slug: "hma-vpn", image: "assets/img/hma-vpn.png", name: "HMA VPN", category: "VPN", icon: "H", color: "#64748B",
    short: "Hide My Ass! VPN — fast servers worldwide and private browsing.",
    sold: 95,
    terms: ["1 device", "Don't change the password"],
    variants: [
      { pkg: "1 Device", duration: "1 Month", price: 0.96, bulkPrice: 0.72, stock: 14, warranty: "30 Days" },
    ],
  },
  {
    slug: "truecaller-premium", image: "assets/img/truecaller.png", name: "Truecaller Premium", category: "Utilities", icon: "T", color: "#0087FF",
    short: "Ad-free caller ID, see who viewed your profile and advanced spam blocking.",
    sold: 40, isNew: true,
    terms: ["Activated on your own number", "Android & iOS"],
    variants: [
      { pkg: "Own Number", duration: "1 Month", price: 1.2, bulkPrice: 0.96, stock: 10, manual: true, warranty: "30 Days" },
    ],
  },
];
