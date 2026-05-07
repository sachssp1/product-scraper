#!/usr/bin/env node
/**
 * scrape.mjs — Generic product scraper
 *
 * Extracts products (name, price, description, image, URL) from any e-commerce site.
 * Detection pipeline — tried in order, first match wins:
 *   0. Embedded JSON  __NEXT_DATA__, __PRELOADED_STATE__, window.__STATE__ etc.
 *   1. JSON-LD        <script type="application/ld+json"> Product / ItemList
 *   2. Microdata      itemtype="schema.org/Product" + itemprop attributes
 *   3. Heuristic HTML common product-card / product-tile class patterns
 *   4. Open Graph     og:title + og:price (single-product PDP fallback)
 *
 * Built-in named configs (--config <name>):
 *   nto   — NTO SFCC storefront (zzse-251.dx.commercecloud.salesforce.com)
 *
 * Usage:
 *   node scrape.mjs --urls "https://www.asda.com/dept/bakery"
 *   node scrape.mjs --urls "https://www.asda.com/dept/bakery" --browser
 *   node scrape.mjs --urls "https://asda.com/cat/a,https://asda.com/cat/b" --limit 10
 *   node scrape.mjs --config nto --out catalog.json
 *   node scrape.mjs --help
 *
 * --browser uses Playwright (real Chromium) — needed for sites with bot protection (ASDA etc.)
 * Install once: npm install -g playwright && npx playwright install chromium
 */

import { writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import path from "node:path";

// ─── CLI ──────────────────────────────────────────────────────────────────────

const { values: args } = parseArgs({
  options: {
    urls:      { type: "string",  default: "" },
    config:    { type: "string",  default: "" },
    out:       { type: "string",  default: "products.json" },
    limit:     { type: "string",  default: "20" },
    "no-pdp":  { type: "boolean", default: false },
    browser:   { type: "boolean", default: false },
    delay:     { type: "string",  default: "300" },
    help:      { type: "boolean", default: false },
  },
});

if (args.help) {
  console.log(`
Usage: node scrape.mjs [options]

  --urls      <url,...>  Category/listing URLs to scrape (comma-separated)
  --config    <name>     Named config: nto
  --out       <file>     Output JSON file (default: products.json)
  --limit     <n>        Max products per URL (default: 20)
  --no-pdp               Skip individual product page enrichment
  --browser              Use real Chromium via Playwright (bypasses bot protection)
  --delay     <ms>       Delay between requests in ms (default: 300)
  --help                 Show this message

Examples:
  node scrape.mjs --urls "https://www.asda.com/department/food-cupboard" --browser
  node scrape.mjs --urls "https://asda.com/cat/a,https://asda.com/cat/b" --limit 10 --no-pdp
  node scrape.mjs --config nto --out data/catalog.json

Setup for --browser (one time):
  npm install -g playwright && npx playwright install chromium
`);
  process.exit(0);
}

const MAX_PER_URL  = parseInt(args.limit, 10) || 20;
const FETCH_PDP    = !args["no-pdp"];
let   USE_BROWSER  = args.browser;
const DELAY_MS     = parseInt(args.delay, 10) || 300;
const OUT_FILE     = args.out;

// ─── HTTP (plain fetch) ───────────────────────────────────────────────────────

async function fetchTextHttp(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-GB,en;q=0.9",
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

// ─── BROWSER FETCH (Playwright) ───────────────────────────────────────────────

let _browser = null;

async function getBrowser() {
  if (_browser) return _browser;
  let pw;
  try {
    pw = await import("playwright");
  } catch {
    console.error(
      "\n✗ Playwright not installed. Run:\n" +
      "    npm install -g playwright && npx playwright install chromium\n"
    );
    process.exit(1);
  }
  _browser = await pw.chromium.launch({
    headless: true,
    args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"],
  });
  return _browser;
}

// Fresh context per URL — avoids session-based bot detection
async function newBrowserContext() {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    locale: "en-GB",
    viewport: { width: 1280, height: 800 },
    extraHTTPHeaders: { "Accept-Language": "en-GB,en;q=0.9" },
  });
  // Patch automation fingerprint so sites like Selfridges don't detect headless Chrome
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver",  { get: () => undefined });
    Object.defineProperty(navigator, "plugins",    { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, "languages",  { get: () => ["en-GB", "en"] });
    window.chrome = { runtime: {} };
    const orig = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = (p) =>
      p.name === "notifications" ? Promise.resolve({ state: "denied" }) : orig(p);
  });
  return context;
}

// Product API patterns — intercept these responses instead of parsing HTML
const API_PATTERNS = [
  // Algolia (ASDA, many others)
  { test: (u) => u.includes("algolia.net"), parse: parseAlgoliaResponse },
  // Elasticsearch / common search APIs returning { hits: [...] } or { products: [...] }
  { test: (u) => /\/search\b|\/products\b|\/catalog\b|\/items\b/i.test(u) && !/\.js($|\?)/.test(u), parse: parseGenericApiResponse },
  // Catch-all: any JSON response that isn't a script/image/font/tracking pixel
  {
    test: (u) => !/\.js($|\?)/.test(u)
      && !/\.css($|\?)/.test(u)
      && !/\.(png|jpg|gif|webp|svg|woff2?|ttf|ico)($|\?)/i.test(u)
      && !/analytics|tracking|gtm|segment|hotjar|mixpanel|sentry|bugsnag|clarity|beacon/i.test(u),
    parse: parseGenericApiResponse,
  },
];

function parseAlgoliaResponse(data, pageUrl) {
  const hits = data.hits ?? data.results?.[0]?.hits ?? [];
  return hits.map((h) => {
    const name  = String(h.NAME ?? h.name ?? h.title ?? "");
    if (!name) return null;
    const id    = String(h.ID ?? h.objectID ?? h.sku ?? h.id ?? slugify(name));
    const price = h.PRICES?.EN?.PRICE ?? h.PRICES?.price ?? h.price ?? null;
    const imageId = h.IMAGE_ID ?? h.imageId ?? null;
    const image = imageId
      ? `https://asdagroceries.scene7.com/is/image/asdagroceries/${imageId}?wid=400&hei=400&fmt=jpg`
      : absoluteUrl(h.image ?? h.imageUrl ?? "", pageUrl);
    const taxonomy = h.PRIMARY_TAXONOMY ?? {};
    const category = taxonomy.SHELF_NAME ?? taxonomy.AISLE_NAME ?? taxonomy.DEPT_NAME ?? "";
    const pdpSlug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const cin = h.CIN ?? "";
    const pdpUrl = cin ? `https://www.asda.com/product/${pdpSlug}/${cin}` : null;
    return {
      id,
      sku: id,
      name,
      description: "",
      price: typeof price === "number" ? price : parsePrice(String(price ?? "")),
      currency: "GBP",
      image,
      pdpUrl,
      colors: [],
      sizes: [],
      brand: String(h.BRAND ?? h.brand ?? ""),
      inStock: h.STOCK !== "OOS" && h.STATUS !== "D",
      categoryId: category,
      rating: h.AVG_RATING ?? null,
      reviewCount: h.RATING_COUNT ?? 0,
      packSize: h.PACK_SIZE ?? "",
      source: "algolia",
    };
  }).filter(Boolean);
}

function parseGenericApiResponse(data, pageUrl) {
  const arr = findProductArray(data, 0);
  if (!arr) return [];
  return arr.map((o) => jsonObjectToProduct(o, pageUrl)).filter(Boolean);
}

async function fetchBrowserWithApiInterception(url) {
  const context = await newBrowserContext();
  const page = await context.newPage();
  const captured = [];
  const pending = [];

  page.on("response", (res) => {
    const u = res.url();
    const pattern = API_PATTERNS.find((p) => p.test(u));
    if (!pattern) return;
    const p = (async () => {
      try {
        const ct = res.headers()["content-type"] ?? "";
        if (!ct.includes("json")) return;
        const data = await res.json();
        const products = pattern.parse(data, url);
        if (products.length > 0) captured.push(...products);
      } catch {}
    })();
    pending.push(p);
  });

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    // Progressive scroll — triggers lazy-loaded product API calls
    for (let step = 1; step <= 6; step++) {
      await page.evaluate((s) => window.scrollTo(0, document.body.scrollHeight * (s / 6)), step);
      await page.waitForTimeout(800);
    }
    await page.waitForTimeout(2000);
    await Promise.allSettled(pending);
  } finally {
    await page.close();
    await context.close();
  }

  return captured;
}

async function fetchTextBrowser(url) {
  const context = await newBrowserContext();
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
    await page.waitForTimeout(2000);
    return await page.content();
  } finally {
    await page.close();
    await context.close();
  }
}

async function closeBrowser() {
  if (_browser) {
    await _browser.close();
    _browser = null;
  }
}

// ─── UNIFIED FETCH ────────────────────────────────────────────────────────────

async function fetchText(url) {
  if (USE_BROWSER) return fetchTextBrowser(url);
  return fetchTextHttp(url);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log   = (...a) => console.log(...a);
const warn  = (...a) => console.warn("⚠ ", ...a);

// ─── UTILITIES ────────────────────────────────────────────────────────────────

function decodeEntities(s = "") {
  return String(s)
    .replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ").replace(/&pound;/g, "£")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&[a-z]+;/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function absoluteUrl(href, base) {
  if (!href) return "";
  const s = String(href);
  if (s.startsWith("http")) return s;
  try { return new URL(s, base).href; } catch { return s; }
}

function parsePrice(s) {
  if (s == null) return null;
  const m = String(s).replace(/,/g, "").match(/[\d]+\.?\d*/);
  return m ? parseFloat(m[0]) : null;
}

function slugify(s = "") {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "product";
}

function detectCurrency(html = "") {
  if (/£/.test(html) || /GBP/i.test(html)) return "GBP";
  if (/USD/i.test(html))                   return "USD";
  if (/€/.test(html) || /EUR/i.test(html)) return "EUR";
  if (/\$/.test(html))                     return "USD";
  return "GBP";
}

// ─── STRATEGY 0: EMBEDDED JSON ────────────────────────────────────────────────
// Many React/Next.js sites (ASDA, Tesco, etc.) embed full page data as JSON.
// __NEXT_DATA__ is the most common; we also try other patterns.

function extractEmbeddedJson(html, pageUrl) {
  const candidates = [
    // Next.js
    html.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/),
    // Redux / Nuxt preloaded state
    html.match(/window\.__PRELOADED_STATE__\s*=\s*({[\s\S]*?});\s*<\/script>/),
    html.match(/window\.__STATE__\s*=\s*({[\s\S]*?});\s*<\/script>/),
    html.match(/window\.__INITIAL_STATE__\s*=\s*({[\s\S]*?});\s*<\/script>/),
  ].filter(Boolean);

  for (const match of candidates) {
    let data;
    try { data = JSON.parse(match[1].trim()); } catch { continue; }
    const arr = findProductArray(data, 0);
    if (arr && arr.length > 0) {
      log(`    [Embedded JSON: ${arr.length}]`);
      return arr.map((o) => jsonObjectToProduct(o, pageUrl)).filter(Boolean);
    }
  }
  return [];
}

function findProductArray(obj, depth) {
  if (depth > 7 || !obj || typeof obj !== "object") return null;
  if (Array.isArray(obj)) {
    if (obj.length > 0 && obj.length < 500 && isProductLike(obj[0])) return obj;
    for (const item of obj) {
      const found = findProductArray(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  // Check high-signal keys first
  for (const key of ["products", "items", "results", "hits", "productItems", "catalogItems", "goods", "data"]) {
    if (obj[key]) {
      const found = findProductArray(obj[key], depth + 1);
      if (found) return found;
    }
  }
  for (const val of Object.values(obj)) {
    if (val && typeof val === "object") {
      const found = findProductArray(val, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function isProductLike(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  const keys = Object.keys(obj).map((k) => k.toLowerCase());
  const hasName  = keys.some((k) => ["name", "title", "displayname", "productname"].includes(k));
  const hasPrice = keys.some((k) => k.includes("price") || k.includes("cost"));
  return hasName && hasPrice;
}

function jsonObjectToProduct(obj, pageUrl) {
  const lc = {};
  for (const [k, v] of Object.entries(obj)) lc[k.toLowerCase()] = v;

  const name = decodeEntities(
    lc.name ?? lc.title ?? lc.displayname ?? lc.productname ?? ""
  );
  if (!name) return null;

  // Price: may be a number, string, or nested object
  let price = null;
  const rawPrice = lc.price ?? lc.saleprice ?? lc.regularprice ?? lc.currentprice;
  if (typeof rawPrice === "number") price = rawPrice;
  else if (typeof rawPrice === "string") price = parsePrice(rawPrice);
  else if (rawPrice && typeof rawPrice === "object") {
    price = parsePrice(
      rawPrice.value ?? rawPrice.amount ?? rawPrice.current?.value ?? rawPrice.now ?? ""
    );
  }

  const rawImg = lc.image ?? lc.imageurl ?? lc.thumbnail ?? lc.img ?? lc.primaryimage;
  const image = absoluteUrl(
    typeof rawImg === "string" ? rawImg : (rawImg?.url ?? rawImg?.src ?? ""),
    pageUrl
  );

  const id = String(lc.id ?? lc.sku ?? lc.productid ?? lc.pid ?? slugify(name));

  const rawUrl = lc.url ?? lc.link ?? lc.href ?? lc.pdpurl ?? lc.canonicalurl;
  const pdpUrl = absoluteUrl(String(rawUrl ?? ""), pageUrl) || null;

  const description = decodeEntities(
    lc.description ?? lc.longdescription ?? lc.shortdescription ?? ""
  ).slice(0, 600);

  const brand = decodeEntities(
    typeof lc.brand === "string" ? lc.brand
    : lc.brand?.name ?? lc.brandname ?? lc.manufacturer ?? ""
  );

  return {
    id,
    sku: String(lc.sku ?? id),
    name,
    description,
    price,
    currency: "GBP",
    image,
    pdpUrl,
    colors: [],
    sizes: [],
    brand,
    inStock: lc.instock !== false && lc.available !== false,
    source: "json-embed",
  };
}

// ─── STRATEGY 1: JSON-LD ──────────────────────────────────────────────────────

function extractJsonLd(html, pageUrl) {
  const products = [];
  const re = /<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    let data;
    try { data = JSON.parse(m[1].trim()); } catch { continue; }
    const nodes = Array.isArray(data) ? data : (data["@graph"] ?? [data]);
    for (const node of nodes) {
      const t = node["@type"];
      if (t === "Product" || (Array.isArray(t) && t.includes("Product"))) {
        products.push(jsonLdNodeToProduct(node, pageUrl));
      }
      if (t === "ItemList" || (Array.isArray(t) && t.includes("ItemList"))) {
        for (const elem of node.itemListElement ?? []) {
          const item = elem.item ?? elem;
          if (item["@type"] === "Product") products.push(jsonLdNodeToProduct(item, pageUrl));
        }
      }
    }
  }
  if (products.length > 0) log(`    [JSON-LD: ${products.length}]`);
  return products;
}

function jsonLdNodeToProduct(node, pageUrl) {
  const offers  = Array.isArray(node.offers) ? node.offers : (node.offers ? [node.offers] : []);
  const offer   = offers[0] ?? {};
  const price   = offer.price != null ? parseFloat(offer.price) : null;
  const currency = offer.priceCurrency ?? "GBP";

  const rawImg = Array.isArray(node.image) ? node.image[0] : node.image;
  const image  = absoluteUrl(rawImg?.url ?? rawImg ?? "", pageUrl);

  const id    = node.sku ?? node.productID ?? slugify(node.name ?? "");
  const pdpUrl = absoluteUrl(node.url ?? "", pageUrl) || null;

  return {
    id,
    sku: node.sku ?? id,
    name: decodeEntities(node.name ?? ""),
    description: decodeEntities(node.description ?? "").slice(0, 600),
    price,
    currency,
    image,
    pdpUrl,
    colors: [],
    sizes: [],
    brand: decodeEntities(node.brand?.name ?? node.brand ?? ""),
    inStock: offer.availability !== "https://schema.org/OutOfStock",
    source: "jsonld",
  };
}

// ─── STRATEGY 2: MICRODATA ────────────────────────────────────────────────────

function extractMicrodata(html, pageUrl) {
  const products = [];
  const re = /itemtype="https?:\/\/schema\.org\/Product"/gi;
  const positions = [];
  let m;
  while ((m = re.exec(html)) !== null) positions.push(m.index);

  for (let i = 0; i < positions.length; i++) {
    const start = positions[i];
    const end   = i + 1 < positions.length ? positions[i + 1] : start + 8000;
    const chunk = html.slice(Math.max(0, start - 200), end);

    const get = (prop) => {
      const r = new RegExp(
        `itemprop="${prop}"[^>]*(?:content="([^"]+)"|href="([^"]+)"|src="([^"]+)">([^<]{0,200}))`,
        "i"
      );
      const hit = chunk.match(r);
      return decodeEntities(hit?.[1] ?? hit?.[2] ?? hit?.[3] ?? hit?.[4] ?? "");
    };

    const name = get("name");
    if (!name) continue;

    const price  = parsePrice(get("price") || get("lowPrice"));
    const imgM   = chunk.match(/itemprop="image"[^>]*(?:content="([^"]+)"|src="([^"]+)")/i);
    const image  = absoluteUrl(imgM?.[1] ?? imgM?.[2] ?? "", pageUrl);
    const linkM  = chunk.match(/itemprop="url"[^>]*(?:content="([^"]+)"|href="([^"]+)")/i);
    const pdpUrl = absoluteUrl(linkM?.[1] ?? linkM?.[2] ?? "", pageUrl) || null;
    const id     = get("sku") || get("productID") || slugify(name);

    products.push({
      id,
      sku: get("sku") || id,
      name,
      description: get("description").slice(0, 600),
      price,
      currency: "GBP",
      image,
      pdpUrl,
      colors: [],
      sizes: [],
      brand: get("brand"),
      inStock: true,
      source: "microdata",
    });
  }
  if (products.length > 0) log(`    [Microdata: ${products.length}]`);
  return products;
}

// ─── STRATEGY 3: HEURISTIC HTML ──────────────────────────────────────────────
// Recognises the most common e-commerce tile patterns via class names / data attrs.

const TILE_OPENERS = [
  // SFCC / SFRA: <div class="product" data-pid="...">
  /<div\s+class="product"\s+data-pid="([^"]+)"[^>]*>/gi,
  // AllSaints / BEM SFCC: <section class="b-product_tile" data-pid="...">
  /<(?:section|div|article|li)[^>]+\bdata-pid="([^"]+)"[^>]*>/gi,
  // Shopify
  /<li[^>]+\bclass="[^"]*(?:product-item|grid-product|card-product)[^"]*"[^>]*>/gi,
  // WooCommerce
  /<li[^>]+\bclass="[^"]*(?:wc-block-grid__product|product_cat|type-product)[^"]*"[^>]*>/gi,
  // Generic: product-card, product-tile, product-item, item-card, b-product_tile
  /<(?:div|li|article|section)[^>]+\bclass="[^"]*(?:product-card|product-tile|product-item|item-card|product-pod|b-product_tile)[^"]*"[^>]*>/gi,
];

function extractHeuristic(html, pageUrl) {
  const seen = new Set();
  const currency = detectCurrency(html);

  // Fast path: data-analytics JSON on product tile elements (AllSaints / SFCC BEM)
  const analyticsRe = /<(?:section|div|article|li)[^>]+\bdata-pid="([^"]+)"[^>]*\bdata-analytics="([^"]+)"[^>]*>/gi;
  const analyticsProducts = [];
  let am;
  while ((am = analyticsRe.exec(html)) !== null) {
    try {
      const pid  = am[1];
      const data = JSON.parse(am[2].replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
      const item = data?.gtmInfoExtended?.items?.[0] ?? data;
      const name = decodeEntities(item.item_name ?? item.name ?? data.name ?? "");
      if (!name || seen.has(pid)) continue;
      seen.add(pid);
      const price  = parseFloat(item.price ?? data.price ?? 0) || null;
      const colour = item.item_colour ?? data.variant ?? "";
      const inStock = String(item.item_in_stock ?? "Yes").toLowerCase() !== "no";
      const category = item.item_category3 ?? item.item_category2 ?? item.item_category ?? data.category ?? "";
      // Find the PDP link and image in the tile chunk
      const tileStart = am.index;
      const tileEnd   = html.indexOf('</section>', tileStart + 1) + 10 || tileStart + 3000;
      const chunk     = html.slice(tileStart, tileEnd);
      const linkM     = chunk.match(/href="(\/[^"?#][^"]*?)"/);
      const imgM      = chunk.match(/<img[^>]+src="(https?[^"]+)"/);
      analyticsProducts.push({
        id: pid, sku: pid, name,
        description: "",
        price,
        currency: data.currency ?? "GBP",
        image: absoluteUrl(imgM?.[1] ?? "", pageUrl),
        pdpUrl: linkM ? absoluteUrl(linkM[1], pageUrl) : null,
        colors: colour ? [colour] : [],
        sizes: [],
        brand: "",
        inStock,
        categoryId: category,
        source: "data-analytics",
      });
    } catch {}
  }
  if (analyticsProducts.length > 0) {
    log(`    [data-analytics: ${analyticsProducts.length}]`);
    return analyticsProducts;
  }

  // Fast path: data-testid="product-card" (Selfridges, many React storefronts)
  if (html.includes('data-testid="product-card"')) {
    const cardRe = /data-testid="product-card"[\s\S]{0,3000}?(?=data-testid="product-card"|$)/g;
    const testidProducts = [];
    let tm;
    while ((tm = cardRe.exec(html)) !== null) {
      const chunk = tm[0];
      // Name: inside an <a> link heading
      const nameM = chunk.match(/<div[^>]*>([^<]{3,120})<\/div><\/a>/) ||
                    chunk.match(/<a[^>]*>[^<]*<div[^>]*>([^<]{3,120})<\/div>/) ||
                    chunk.match(/role="link"[^>]*>[\s\S]{0,200}?<div[^>]*>([^<]{3,120})<\/div>/);
      const name = decodeEntities(nameM?.[1] ?? "").trim();
      if (!name || seen.has(name) || /\{\{/.test(name)) continue;
      seen.add(name);

      // Brand: typically in an <h2> before the product name
      const brandM = chunk.match(/<h2[^>]*>([^<]{1,80})<\/h2>/);
      const brand = decodeEntities(brandM?.[1] ?? "").trim();

      // Price: £XX.XX
      const priceM = chunk.match(/£([\d,]+\.?\d*)/);
      const price = priceM ? parseFloat(priceM[1].replace(/,/g, "")) : null;

      // Image
      const imgM = chunk.match(/src="((?:https?:)?\/\/[^"]+selfridges[^"]+)"/);
      const image = imgM ? absoluteUrl(imgM[1], pageUrl) : "";

      // PDP link
      const linkM = chunk.match(/href="(\/[^"]+_R\d+[^"]*)"/);
      const pdpUrl = linkM ? absoluteUrl(linkM[1], pageUrl) : null;

      // Colours
      const colourM = chunk.match(/([\d]+)\s*Colou?rs?/i);
      const id = (pdpUrl?.match(/_R(\d+)/)?.[1] ?? slugify(name));

      testidProducts.push({
        id, sku: id, name, brand,
        description: "",
        price,
        currency: detectCurrency(chunk) || "GBP",
        image,
        pdpUrl,
        colors: colourM ? [`${colourM[1]} colours`] : [],
        sizes: [],
        inStock: true,
        source: "data-testid",
      });
    }
    if (testidProducts.length > 0) {
      log(`    [data-testid: ${testidProducts.length}]`);
      return testidProducts;
    }
  }

  for (const re of TILE_OPENERS) {
    re.lastIndex = 0;
    const positions = [];
    let m;
    while ((m = re.exec(html)) !== null) {
      positions.push({ start: m.index, pid: m[1] ?? null });
    }
    if (positions.length === 0) continue;

    const products = [];
    for (let i = 0; i < positions.length; i++) {
      const { start, pid } = positions[i];
      const end  = i + 1 < positions.length ? positions[i + 1].start : start + 5000;
      const tile = html.slice(start, end);

      const id = pid ??
        tile.match(/\bdata-product-id="([^"]+)"/)?.[1] ??
        tile.match(/\bdata-id="([^"]+)"/)?.[1] ?? null;

      const nameM =
        tile.match(/<[^>]+\bclass="[^"]*(?:product-name|product-title|tile-name|card-title)[^"]*"[^>]*>([^<]{2,120})</) ||
        tile.match(/<(?:h2|h3|h4)[^>]*>([^<]{2,120})</) ||
        tile.match(/\balt="([^"]{3,100})"/) ||
        tile.match(/\btitle="([^"]{3,100})"/);
      const name = decodeEntities(nameM?.[1] ?? "");
      // Reject Handlebars/Mustache/template placeholders like {{alt}} or {product.name}
      if (!name || /\{\{|\{%/.test(name) || seen.has(name)) continue;
      seen.add(name);

      const priceM =
        tile.match(/itemprop="price"[^>]*content="([\d.,]+)"/) ||
        tile.match(/data-price="([\d.,]+)"/) ||
        tile.match(/class="[^"]*(?:price|value|sales)[^"]*"[\s\S]{0,200}?content="([\d.,]+)"/) ||
        tile.match(/(?:£|\$|€)\s*([\d.,]+)/);
      const price = priceM ? parseFloat(priceM[1].replace(/,/g, "")) : null;

      const imgM =
        tile.match(/<img[^>]+\bclass="[^"]*(?:tile-image|product-image|primary-image)[^"]*"[^>]+src="([^"]+)"/) ||
        tile.match(/<img[^>]+src="([^"]+)"[^>]+\balt="[^"]{3,}"/) ||
        tile.match(/<img[^>]+src="(https?[^"]+)"/);
      const image = absoluteUrl(imgM?.[1] ?? "", pageUrl);

      const linkM =
        tile.match(/<a[^>]+href="([^"]+\.html[^"]*)"/) ||
        tile.match(/<a[^>]+href="([^"]+\/p\/[^"]+)"/) ||
        tile.match(/<a[^>]+href="([^"]+\/products?\/[^"]+)"/) ||
        tile.match(/<a[^>]+href="([^"#?][^"]{4,})"[^>]*>/);
      const pdpUrl = linkM ? absoluteUrl(linkM[1], pageUrl) : null;

      products.push({
        id: id ?? slugify(name),
        sku: id ?? slugify(name),
        name,
        description: "",
        price,
        currency,
        image,
        pdpUrl,
        colors: [],
        sizes: [],
        brand: "",
        inStock: true,
        source: "heuristic",
      });
    }

    if (products.length > 0) {
      log(`    [Heuristic: ${products.length}]`);
      return products;
    }
  }
  return [];
}

// ─── STRATEGY 4: OPEN GRAPH (single-product PDP fallback) ────────────────────

function extractOpenGraph(html, pageUrl) {
  const get = (prop) => {
    const m =
      html.match(new RegExp(`<meta[^>]+property="${prop}"[^>]+content="([^"]+)"`, "i")) ||
      html.match(new RegExp(`<meta[^>]+content="([^"]+)"[^>]+property="${prop}"`, "i"));
    return m?.[1] ?? "";
  };

  const name = decodeEntities(get("og:title"));
  if (!name) return [];

  const ogType = get("og:type").toLowerCase();
  const price    = parsePrice(get("og:price:amount") || get("product:price:amount"));
  const currency = get("og:price:currency") || get("product:price:currency") || "GBP";

  // Only use OG as a product source if the page is explicitly typed as a product
  // or has a price — avoids treating category/collection pages as single products
  if (ogType !== "product" && price == null) return [];

  const image    = absoluteUrl(get("og:image"), pageUrl);
  const pdpUrl   = absoluteUrl(get("og:url"), pageUrl) || pageUrl;
  const description = decodeEntities(
    get("og:description") ||
    (html.match(/<meta[^>]+name="description"[^>]+content="([^"]+)"/i)?.[1] ?? "")
  ).slice(0, 600);

  log(`    [Open Graph: 1]`);
  return [{
    id: slugify(name),
    sku: slugify(name),
    name,
    description,
    price,
    currency,
    image,
    pdpUrl,
    colors: [],
    sizes: [],
    brand: "",
    inStock: true,
    source: "og",
  }];
}

// ─── COMBINED EXTRACTION ──────────────────────────────────────────────────────

function extractProducts(html, pageUrl) {
  let products;

  products = extractEmbeddedJson(html, pageUrl);
  if (products.length > 0) return products;

  products = extractJsonLd(html, pageUrl);
  if (products.length > 0) return products;

  products = extractMicrodata(html, pageUrl);
  if (products.length > 0) return products;

  products = extractHeuristic(html, pageUrl);
  if (products.length > 0) return products;

  products = extractOpenGraph(html, pageUrl);
  return products;
}

// ─── PDP ENRICHMENT ───────────────────────────────────────────────────────────

async function enrichFromPdp(product) {
  if (!product.pdpUrl) return product;
  let html;
  try { html = await fetchText(product.pdpUrl); }
  catch { return product; }

  // Prefer JSON-LD on PDP — it's the most reliable
  const jProducts = extractJsonLd(html, product.pdpUrl);
  if (jProducts.length > 0) {
    const j = jProducts[0];
    return {
      ...product,
      description: j.description || product.description,
      price:       j.price ?? product.price,
      image:       j.image || product.image,
      colors:      j.colors.length ? j.colors : product.colors,
      sizes:       j.sizes.length  ? j.sizes  : product.sizes,
      brand:       j.brand || product.brand,
      inStock:     j.inStock,
    };
  }

  // Heuristic PDP fallback
  let description = product.description;
  if (!description) {
    const dM =
      html.match(/<[^>]+\bclass="[^"]*long-description[^"]*"[^>]*>([\s\S]{0,3000}?)<\/(?:div|p|section)>/) ||
      html.match(/<[^>]+\bclass="[^"]*product-description[^"]*"[^>]*>([\s\S]{0,3000}?)<\/(?:div|p|section)>/) ||
      html.match(/<[^>]+\bclass="[^"]*description[^"]*"[^>]*>([\s\S]{0,2000}?)<\/(?:div|p|section)>/) ||
      html.match(/<meta[^>]+name="description"[^>]+content="([^"]+)"/i);
    if (dM) description = decodeEntities(dM[1]).slice(0, 600);
  }

  let price = product.price;
  if (price == null) {
    const pM =
      html.match(/itemprop="price"[^>]*content="([\d.,]+)"/) ||
      html.match(/data-price="([\d.,]+)"/) ||
      html.match(/(?:£|\$|€)\s*([\d.,]+\.\d{2})/);
    if (pM) price = parseFloat(pM[1].replace(/,/g, ""));
  }

  // SFRA swatch colors
  const colors = [];
  const colorRe = /<div[^>]+\bclass="[^"]*swatch-color[^"]*"[^>]*\btitle="([^"]+)"/g;
  let cm;
  while ((cm = colorRe.exec(html)) !== null) {
    const c = decodeEntities(cm[1]);
    if (c && !colors.includes(c)) colors.push(c);
  }

  const heroM =
    html.match(/<img[^>]+\bclass="[^"]*(?:primary-image|product-image|hero)[^"]*"[^>]+src="([^"]+)"/) ||
    html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/);
  const image = heroM ? absoluteUrl(heroM[1], product.pdpUrl) : product.image;

  return {
    ...product,
    description,
    price: price ?? product.price,
    image,
    colors: colors.length ? colors.slice(0, 8) : product.colors,
  };
}

// ─── OUTPUT SHAPE ─────────────────────────────────────────────────────────────

function toOutputShape(p) {
  return {
    id:               p.id,
    sku:              p.sku,
    name:             p.name,
    brand:            p.brand || "",
    category:         p.categoryId || "",
    price:            typeof p.price === "number" && !Number.isNaN(p.price) ? p.price : 0,
    currency:         p.currency || "GBP",
    image:            p.image || "",
    shortDescription: (p.description || "").slice(0, 140),
    description:      p.description || "",
    colors:           p.colors || [],
    sizes:            p.sizes || [],
    inStock:          p.inStock !== false,
    pdpUrl:           p.pdpUrl || "",
    ...(p.rating    != null && { rating: p.rating }),
    ...(p.reviewCount != null && { reviewCount: p.reviewCount }),
    ...(p.packSize  != null && { packSize: p.packSize }),
    source:           p.source || "",
  };
}

// ─── NAMED CONFIGS ────────────────────────────────────────────────────────────

const CONFIGS = {
  asda: {
    browserRequired: true,
    urls: [
      // Fruit, Veg & Flowers
      "https://www.asda.com/groceries/fruit-veg-flowers/fruit",
      "https://www.asda.com/groceries/fruit-veg-flowers/vegetables-potatoes",
      "https://www.asda.com/groceries/fruit-veg-flowers/salads-stir-fry",
      "https://www.asda.com/groceries/fruit-veg-flowers/raw-nuts-seeds-dried-fruit",
      // Meat, Poultry & Fish
      "https://www.asda.com/groceries/meat-poultry-fish/meat-poultry",
      "https://www.asda.com/groceries/meat-poultry-fish/fish-seafood",
      "https://www.asda.com/groceries/meat-poultry-fish/cooked-meat",
      // Bakery
      "https://www.asda.com/groceries/bakery/bread-rolls",
      "https://www.asda.com/groceries/bakery/wraps-bagels-pittas-naans",
      "https://www.asda.com/groceries/bakery/cakes",
      "https://www.asda.com/groceries/bakery/cake-bars-slices-tarts",
      "https://www.asda.com/groceries/bakery/desserts-cream-cakes",
      "https://www.asda.com/groceries/bakery/crumpets-muffins-pancakes",
      // Chilled Food
      "https://www.asda.com/groceries/chilled-food/milk-butter-cream-eggs",
      "https://www.asda.com/groceries/chilled-food/cheese",
      "https://www.asda.com/groceries/chilled-food/yogurts-desserts",
      "https://www.asda.com/groceries/chilled-food/ready-meals",
      "https://www.asda.com/groceries/chilled-food/pizza-pasta-garlic-bread",
      "https://www.asda.com/groceries/chilled-food/cooked-meat",
      // Frozen Food
      "https://www.asda.com/groceries/frozen-food/frozen-chicken-meat",
      "https://www.asda.com/groceries/frozen-food/frozen-fish-seafood",
      "https://www.asda.com/groceries/frozen-food/frozen-ready-meals",
      "https://www.asda.com/groceries/frozen-food/frozen-pizza-garlic-bread",
      "https://www.asda.com/groceries/frozen-food/frozen-chips-potatoes-sides",
      "https://www.asda.com/groceries/frozen-food/ice-cream-ice-lollies",
      "https://www.asda.com/groceries/frozen-food/frozen-vegetables-fruit-herbs",
      // Food Cupboard
      "https://www.asda.com/groceries/food-cupboard/cereals-cereal-bars",
      "https://www.asda.com/groceries/food-cupboard/tinned-food",
      "https://www.asda.com/groceries/food-cupboard/rice-pasta-noodles",
      "https://www.asda.com/groceries/food-cupboard/condiments-cooking-ingredients",
      "https://www.asda.com/groceries/food-cupboard/cooking-sauces-meal-kits-sides",
      "https://www.asda.com/groceries/food-cupboard/biscuits",
      "https://www.asda.com/groceries/food-cupboard/coffee-tea-hot-chocolate",
      "https://www.asda.com/groceries/food-cupboard/jams-spreads-desserts",
      "https://www.asda.com/groceries/food-cupboard/home-baking",
      // Sweets, Treats & Snacks
      "https://www.asda.com/groceries/sweets-treats-snacks/chocolate-sweets",
      "https://www.asda.com/groceries/sweets-treats-snacks/crisps-nuts-popcorn",
      "https://www.asda.com/groceries/sweets-treats-snacks/biscuits-crackers",
      // Drinks
      "https://www.asda.com/groceries/drinks/fizzy-drinks",
      "https://www.asda.com/groceries/drinks/water",
      "https://www.asda.com/groceries/drinks/fruit-juice",
      "https://www.asda.com/groceries/drinks/sports-energy-health-drinks",
      "https://www.asda.com/groceries/drinks/coffee-tea-hot-chocolate",
      // Beer, Wine & Spirits
      "https://www.asda.com/groceries/beer-wine-spirits/wine",
      "https://www.asda.com/groceries/beer-wine-spirits/beer-lager-ales",
      "https://www.asda.com/groceries/beer-wine-spirits/cider",
      "https://www.asda.com/groceries/beer-wine-spirits/spirits",
      // Toiletries & Beauty
      "https://www.asda.com/groceries/toiletries-beauty/hair-care-dye-styling",
      "https://www.asda.com/groceries/toiletries-beauty/bath-shower-soap",
      "https://www.asda.com/groceries/toiletries-beauty/dental-care",
      "https://www.asda.com/groceries/toiletries-beauty/skin-care",
      "https://www.asda.com/groceries/toiletries-beauty/deodorants-body-sprays",
      // Laundry & Household
      "https://www.asda.com/groceries/laundry-household/laundry",
      "https://www.asda.com/groceries/laundry-household/cleaning",
      "https://www.asda.com/groceries/laundry-household/toilet-roll",
      "https://www.asda.com/groceries/laundry-household/household-essentials",
    ],
  },
  nto: {
    urls: [
      "https://zzse-251.dx.commercecloud.salesforce.com/s/nto/en_GB/women-jackets",
      "https://zzse-251.dx.commercecloud.salesforce.com/s/nto/en_GB/women-tops",
      "https://zzse-251.dx.commercecloud.salesforce.com/s/nto/en_GB/women-bottoms",
      "https://zzse-251.dx.commercecloud.salesforce.com/s/nto/en_GB/women-accessories-backpacks",
      "https://zzse-251.dx.commercecloud.salesforce.com/s/nto/en_GB/mens-jackets",
      "https://zzse-251.dx.commercecloud.salesforce.com/s/nto/en_GB/mens-tops",
      "https://zzse-251.dx.commercecloud.salesforce.com/s/nto/en_GB/mens-bottoms",
      "https://zzse-251.dx.commercecloud.salesforce.com/s/nto/en_GB/mens-shoes",
      "https://zzse-251.dx.commercecloud.salesforce.com/s/nto/en_GB/mens-accessories-backpacks",
      "https://zzse-251.dx.commercecloud.salesforce.com/s/nto/en_GB/kids-bigkids-jackets",
      "https://zzse-251.dx.commercecloud.salesforce.com/s/nto/en_GB/kids-bigkids-shoes",
      "https://zzse-251.dx.commercecloud.salesforce.com/s/nto/en_GB/gear-bags-backpacks",
      "https://zzse-251.dx.commercecloud.salesforce.com/s/nto/en_GB/gear-bags-luggage",
      "https://zzse-251.dx.commercecloud.salesforce.com/s/nto/en_GB/gear-camping-tents",
      "https://zzse-251.dx.commercecloud.salesforce.com/s/nto/en_GB/gear-camping-sleepingbags",
      "https://zzse-251.dx.commercecloud.salesforce.com/s/nto/en_GB/gear-cycling-helmets",
      "https://zzse-251.dx.commercecloud.salesforce.com/s/nto/en_GB/electronics",
    ],
  },
};

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  let urls = [];

  if (args.config) {
    const cfg = CONFIGS[args.config];
    if (!cfg) {
      console.error(`Unknown config "${args.config}". Available: ${Object.keys(CONFIGS).join(", ")}`);
      process.exit(1);
    }
    urls = cfg.urls;
    if (cfg.browserRequired && !USE_BROWSER) {
      log(`Config "${args.config}" requires --browser (enabling automatically)`);
      USE_BROWSER = true;
    }
    log(`Using config "${args.config}" — ${urls.length} category URLs\n`);
  } else if (args.urls) {
    urls = args.urls.split(",").map((u) => u.trim()).filter(Boolean);
  } else {
    console.error("Provide --urls or --config. Run with --help for usage.");
    process.exit(1);
  }

  const all = new Map();

  for (const url of urls) {
    let label;
    try { label = new URL(url).pathname; } catch { label = url; }
    log(`→ ${label}`);

    const categoryId = label.split("/").filter(Boolean).pop() ?? "unknown";
    let products = [];

    if (USE_BROWSER) {
      // Try API interception first — catches Algolia, Elasticsearch, etc.
      try {
        products = await fetchBrowserWithApiInterception(url);
        if (products.length > 0) {
          log(`  ${products.length} product(s) via API — "${products[0].name.slice(0, 60)}"`);
        }
      } catch (err) {
        const msg = err.message ?? "";
        if (/timeout/i.test(msg)) {
          warn(`  browser fetch timed out — the site may be blocking headless browsers (e.g. DataDome, Cloudflare)`);
          warn(`  Sites like Selfridges, ASOS, and John Lewis use bot protection that cannot be bypassed with Playwright`);
        } else {
          warn(`  browser fetch failed: ${msg}`);
        }
        continue;
      }
      // Fall back to HTML parsing if API yielded nothing
      if (products.length === 0) {
        try {
          const html = await fetchTextBrowser(url);
          // Check for actual bot-block pages (not just CDN scripts that mention challenge)
          const isBlocked = /datadome/i.test(html)
            || /<title[^>]*>\s*(?:access denied|just a moment|checking your browser|attention required)/i.test(html)
            || (html.length < 5000 && /_cf_chl|captcha/i.test(html));
          if (isBlocked) {
            warn(`  Bot protection detected — this site is actively blocking automated browsers`);
            warn(`  Unfortunately this site cannot be scraped with this tool`);
            continue;
          }
          products = extractProducts(html, url);
          if (products.length > 0) {
            log(`  ${products.length} product(s) via HTML — "${products[0].name.slice(0, 60)}"`);
          }
        } catch {}
      }
    } else {
      let html;
      try {
        html = await fetchText(url);
      } catch (err) {
        warn(`  fetch failed: ${err.message}`);
        if (/403|forbidden/i.test(err.message)) {
          warn(`  Tip: retry with --browser to bypass bot protection`);
        }
        continue;
      }
      products = extractProducts(html, url);
      if (products.length === 0) {
        warn(`  0 products found in static HTML — this site likely requires JavaScript to render products`);
        warn(`  Retry with "Use Playwright browser" enabled in the dashboard`);
      }
    }

    products = products.slice(0, MAX_PER_URL);
    if (products.length === 0) {
      warn(`  0 products found`);
    } else {
      log(`  ${products.length} product(s) collected`);
    }

    for (const p of products) {
      if (!all.has(p.id)) all.set(p.id, { ...p, categoryId });
    }
    await sleep(DELAY_MS);
  }

  if (all.size === 0) {
    warn("No products found.");
    if (!USE_BROWSER) {
      warn("Retry with --browser if the site uses bot protection or client-side rendering.");
    }
    await closeBrowser();
    process.exit(1);
  }

  log(`\n${all.size} unique product(s). ${FETCH_PDP ? "Enriching from PDPs..." : "Skipping PDP fetch (--no-pdp)."}`);

  if (FETCH_PDP) {
    let i = 0;
    for (const [id, p] of all) {
      i++;
      process.stdout.write(`\r  [${i}/${all.size}] ${p.name.slice(0, 55).padEnd(55)}`);
      all.set(id, await enrichFromPdp(p));
      await sleep(DELAY_MS);
    }
    process.stdout.write("\n");
  }

  const products = Array.from(all.values()).map(toOutputShape);

  const outDir = path.dirname(OUT_FILE);
  if (outDir && outDir !== ".") await mkdir(outDir, { recursive: true });
  await writeFile(OUT_FILE, JSON.stringify({ products }, null, 2));
  log(`\n✓ Wrote ${OUT_FILE} (${products.length} products)`);

  await closeBrowser();
}

main().catch(async (err) => {
  console.error("✗ Scrape failed:", err);
  await closeBrowser();
  process.exit(1);
});
