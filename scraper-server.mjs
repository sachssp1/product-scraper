#!/usr/bin/env node
/**
 * scraper-server.mjs — Web dashboard for scrape.mjs
 * Usage:  node scraper-server.mjs [--port 4321]
 */

import { createServer }     from 'node:http';
import { spawn }            from 'node:child_process';
import { readFile, unlink } from 'node:fs/promises';
import { randomUUID }       from 'node:crypto';
import path                 from 'node:path';
import { fileURLToPath }    from 'node:url';
import { parseArgs }        from 'node:util';

const __dirname    = path.dirname(fileURLToPath(import.meta.url));
const SCRAPE_SCRIPT = path.join(__dirname, 'scrape.mjs');

const { values: argv } = parseArgs({
  options: { port: { type: 'string', default: '4321' } },
  strict: false,
});
const PORT = parseInt(process.env.PORT || argv.port, 10) || 4321;

// ── Presets ───────────────────────────────────────────────────────────────────
const PRESETS = {
  asda: {
    browser: true,
    urls: [
      'https://www.asda.com/groceries/fruit-veg-flowers/fruit',
      'https://www.asda.com/groceries/fruit-veg-flowers/vegetables-potatoes',
      'https://www.asda.com/groceries/meat-poultry-fish/meat-poultry',
      'https://www.asda.com/groceries/meat-poultry-fish/fish-seafood',
      'https://www.asda.com/groceries/bakery/bread-rolls',
      'https://www.asda.com/groceries/bakery/cakes',
      'https://www.asda.com/groceries/chilled-food/milk-butter-cream-eggs',
      'https://www.asda.com/groceries/chilled-food/cheese',
      'https://www.asda.com/groceries/chilled-food/ready-meals',
      'https://www.asda.com/groceries/frozen-food/frozen-chicken-meat',
      'https://www.asda.com/groceries/frozen-food/ice-cream-ice-lollies',
      'https://www.asda.com/groceries/food-cupboard/cereals-cereal-bars',
      'https://www.asda.com/groceries/food-cupboard/tinned-food',
      'https://www.asda.com/groceries/sweets-treats-snacks/chocolate-sweets',
      'https://www.asda.com/groceries/sweets-treats-snacks/crisps-nuts-popcorn',
      'https://www.asda.com/groceries/drinks/fizzy-drinks',
      'https://www.asda.com/groceries/drinks/water',
      'https://www.asda.com/groceries/beer-wine-spirits/wine',
      'https://www.asda.com/groceries/beer-wine-spirits/beer-lager-ales',
      'https://www.asda.com/groceries/toiletries-beauty/skin-care',
      'https://www.asda.com/groceries/laundry-household/laundry',
    ],
  },
  nto: {
    browser: false,
    urls: [
      'https://zzse-251.dx.commercecloud.salesforce.com/s/nto/en_GB/women-jackets',
      'https://zzse-251.dx.commercecloud.salesforce.com/s/nto/en_GB/women-tops',
      'https://zzse-251.dx.commercecloud.salesforce.com/s/nto/en_GB/women-bottoms',
      'https://zzse-251.dx.commercecloud.salesforce.com/s/nto/en_GB/mens-jackets',
      'https://zzse-251.dx.commercecloud.salesforce.com/s/nto/en_GB/mens-tops',
      'https://zzse-251.dx.commercecloud.salesforce.com/s/nto/en_GB/mens-bottoms',
      'https://zzse-251.dx.commercecloud.salesforce.com/s/nto/en_GB/mens-shoes',
      'https://zzse-251.dx.commercecloud.salesforce.com/s/nto/en_GB/gear-bags-backpacks',
      'https://zzse-251.dx.commercecloud.salesforce.com/s/nto/en_GB/gear-camping-tents',
      'https://zzse-251.dx.commercecloud.salesforce.com/s/nto/en_GB/electronics',
    ],
  },
};

// ── Job store ─────────────────────────────────────────────────────────────────
const jobs = new Map();

function emit(job, type, data) {
  const frame = 'data: ' + JSON.stringify({ type, ...data }) + '\n\n';
  for (const res of job.clients) { try { res.write(frame); } catch {} }
  job.logs.push({ type, ...data });
}

function normaliseUrls(raw) {
  return raw.split(/[\n\r,]+/).map(u => {
    u = u.trim();
    if (u && !/^https?:\/\//i.test(u)) u = 'https://' + u;
    return u;
  }).filter(Boolean).join(',');
}

async function startJob({ urls, limit, delay, browser, noPdp }) {
  const jobId   = randomUUID().replace(/-/g, '');
  const outFile = path.join(__dirname, '.scraper-' + jobId + '.json');
  const job     = { id: jobId, status: 'running', logs: [], clients: new Set(), outFile, result: null };
  jobs.set(jobId, job);

  const spawnArgs = [
    SCRAPE_SCRIPT,
    '--urls',  normaliseUrls(urls),
    '--out',   outFile,
    '--limit', String(limit || 20),
    '--delay', String(delay || 300),
  ];
  if (browser) spawnArgs.push('--browser');
  if (noPdp)   spawnArgs.push('--no-pdp');

  const child = spawn('node', spawnArgs, { stdio: ['ignore', 'pipe', 'pipe'] });

  child.stdout.on('data', chunk => {
    for (const line of chunk.toString().split('\n')) {
      const msg = line.trimEnd();
      if (msg) emit(job, 'log', { message: msg });
    }
  });
  child.stderr.on('data', chunk => {
    for (const line of chunk.toString().split('\n')) {
      const msg = line.trimEnd();
      if (msg) emit(job, 'warn', { message: msg });
    }
  });

  child.on('close', async code => {
    if (code === 0) {
      try {
        job.result = JSON.parse(await readFile(outFile, 'utf8'));
        job.status = 'done';
        emit(job, 'done', { count: job.result?.products?.length ?? 0 });
      } catch (e) {
        job.status = 'error';
        emit(job, 'error', { message: 'Could not read result: ' + e.message });
      }
    } else {
      job.status = 'error';
      emit(job, 'error', { message: 'Scraper exited with code ' + code });
    }
    for (const res of job.clients) { try { res.end(); } catch {} }
    job.clients.clear();
    setTimeout(() => { jobs.delete(jobId); unlink(outFile).catch(() => {}); }, 30 * 60 * 1000);
  });

  return jobId;
}

// ── Dashboard HTML (plain string — no interpolation) ──────────────────────────
const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Product Scraper</title>
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    :root{
      --bg:#0d1117;--surf:#161b22;--surf2:#1c2128;--bdr:#30363d;
      --txt:#e6edf3;--mut:#8b949e;--acc:#7c3aed;--acc2:#6d28d9;
      --grn:#3fb950;--yel:#e3b341;--red:#f85149;
    }
    body{background:var(--bg);color:var(--txt);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;min-height:100vh;padding:2.5rem 1rem;line-height:1.5}
    .wrap{max-width:840px;margin:0 auto}
    header{margin-bottom:2rem}
    header h1{font-size:1.65rem;font-weight:700;letter-spacing:-.02em}
    header h1 em{color:var(--acc);font-style:normal}
    header p{color:var(--mut);font-size:.875rem;margin-top:.3rem}
    .card{background:var(--surf);border:1px solid var(--bdr);border-radius:8px;padding:1.25rem 1.5rem;margin-bottom:.875rem}
    .lbl{display:block;font-size:.7rem;font-weight:700;color:var(--mut);text-transform:uppercase;letter-spacing:.07em;margin-bottom:.45rem}
    textarea{width:100%;background:var(--bg);border:1px solid var(--bdr);border-radius:6px;color:var(--txt);font-family:'SF Mono',ui-monospace,monospace;font-size:.8rem;line-height:1.65;padding:.6rem .875rem;min-height:132px;resize:vertical;outline:none;transition:border-color .15s}
    textarea:focus{border-color:var(--acc)}
    textarea::placeholder{color:#484f58}
    .presets{display:flex;align-items:center;gap:.5rem;margin-top:.7rem;flex-wrap:wrap}
    .presets span{font-size:.775rem;color:var(--mut)}
    .pbtn{background:var(--surf2);border:1px solid var(--bdr);border-radius:5px;color:var(--mut);cursor:pointer;font-size:.75rem;padding:.2rem .65rem;transition:all .15s}
    .pbtn:hover{border-color:var(--acc);color:var(--txt)}
    .ogrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(165px,1fr));gap:.875rem}
    .ogrp{display:flex;flex-direction:column;gap:.35rem}
    input[type=number]{background:var(--bg);border:1px solid var(--bdr);border-radius:5px;color:var(--txt);font-size:.875rem;padding:.44rem .7rem;outline:none;width:100%;transition:border-color .15s}
    input[type=number]:focus{border-color:var(--acc)}
    .toggles{display:flex;flex-direction:column;gap:.6rem;margin-top:1rem;padding-top:1rem;border-top:1px solid var(--bdr)}
    .trow{display:flex;align-items:flex-start;gap:.55rem}
    input[type=checkbox]{width:15px;height:15px;margin-top:.15rem;accent-color:var(--acc);cursor:pointer;flex-shrink:0}
    .ttxt{font-size:.875rem;color:#c9d1d9;cursor:pointer}
    .thnt{font-size:.75rem;color:var(--mut);margin-top:.2rem}
    .thnt code{color:var(--acc);background:rgba(124,58,237,.12);padding:.1rem .3rem;border-radius:3px}
    .btnrun{display:block;width:100%;padding:.75rem;background:var(--acc);border:none;border-radius:7px;color:#fff;cursor:pointer;font-size:.975rem;font-weight:700;margin-top:.875rem;transition:background .15s,transform .1s}
    .btnrun:hover{background:var(--acc2)}
    .btnrun:active{transform:scale(.99)}
    .btnrun:disabled{opacity:.4;cursor:not-allowed;transform:none}
    #results{display:none}
    .srow{display:flex;align-items:center;gap:.75rem;background:var(--surf);border:1px solid var(--bdr);border-radius:8px;padding:.875rem 1.25rem;margin-bottom:.75rem}
    .spin{width:17px;height:17px;border:2px solid var(--bdr);border-top-color:var(--acc);border-radius:50%;animation:spin .65s linear infinite;flex-shrink:0}
    @keyframes spin{to{transform:rotate(360deg)}}
    #smsg{font-size:.9rem;flex:1;color:var(--mut)}
    #smsg.done{color:var(--grn);font-weight:600}
    #smsg.err{color:var(--red)}
    .abtns{display:flex;gap:.5rem}
    .btndl{background:var(--grn);border:none;border-radius:6px;color:#0d1117;cursor:pointer;font-size:.8rem;font-weight:700;padding:.38rem 1rem;display:none;transition:opacity .15s}
    .btndl:hover{opacity:.85}
    .btnnew{background:transparent;border:1px solid var(--bdr);border-radius:6px;color:var(--mut);cursor:pointer;font-size:.8rem;padding:.38rem 1rem;display:none;transition:all .15s}
    .btnnew:hover{border-color:var(--acc);color:var(--txt)}
    .btndownload{display:none;width:100%;margin-top:.875rem;padding:.85rem;background:var(--grn);border:none;border-radius:7px;color:#0d1117;cursor:pointer;font-size:1rem;font-weight:700;letter-spacing:.01em;transition:opacity .15s,transform .1s}
    .btndownload:hover{opacity:.88}
    .btndownload:active{transform:scale(.99)}
    .logbox{background:#090d12;border:1px solid var(--bdr);border-radius:7px;font-family:'SF Mono',ui-monospace,monospace;font-size:.77rem;line-height:1.65;max-height:430px;overflow-y:auto;padding:.875rem 1rem}
    .logbox::-webkit-scrollbar{width:5px}
    .logbox::-webkit-scrollbar-thumb{background:var(--bdr);border-radius:3px}
    .ll{white-space:pre-wrap;word-break:break-all}
    .ll.w{color:var(--yel)}
    .ll.e{color:var(--red)}
    .ll.d{color:var(--grn);font-weight:600}
  </style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>Product <em>Scraper</em></h1>
    <p>Extract products from any e-commerce site and download as JSON</p>
  </header>

  <div id="form-section">
    <div class="card">
      <span class="lbl">URLs to scrape</span>
      <textarea id="url-input" placeholder="https://www.example.com/category/clothing&#10;https://www.another-shop.com/men/shoes&#10;&#10;One URL per line (or comma-separated)"></textarea>
      <div class="presets">
        <span>Presets:</span>
        <button class="pbtn" onclick="loadPreset('asda')">ASDA Groceries</button>
        <button class="pbtn" onclick="loadPreset('nto')">NTO Storefront</button>
      </div>
    </div>

    <div class="card">
      <span class="lbl">Options</span>
      <div class="ogrid">
        <div class="ogrp">
          <label class="lbl" for="opt-limit">Max products per URL</label>
          <input type="number" id="opt-limit" value="20" min="1" max="500">
        </div>
        <div class="ogrp">
          <label class="lbl" for="opt-delay">Delay between requests (ms)</label>
          <input type="number" id="opt-delay" value="300" min="0" max="30000">
        </div>
      </div>
      <div class="toggles">
        <div class="trow">
          <input type="checkbox" id="opt-browser" onchange="onBrowserToggle()">
          <div>
            <div class="ttxt" onclick="document.getElementById('opt-browser').click()">Use Playwright browser</div>
            <div class="thnt">Required for JS-heavy sites (ASDA, AllSaints, Tesco&hellip;)&ensp;&middot;&ensp;One-time setup: <code>npm i -g playwright &amp;&amp; npx playwright install chromium</code><br>Note: sites with advanced bot protection (Selfridges, ASOS, John Lewis) cannot be scraped by any automated tool.</div>
          </div>
        </div>
        <div class="trow">
          <input type="checkbox" id="opt-no-pdp">
          <div>
            <div class="ttxt" onclick="document.getElementById('opt-no-pdp').click()">Skip product-page enrichment</div>
            <div class="thnt">Faster &mdash; omits fetching individual PDPs for extra detail (description, colours, sizes)</div>
          </div>
        </div>
      </div>
    </div>

    <button class="btnrun" id="run-btn" onclick="startScrape()">Start Scraping</button>
  </div>

  <div id="results">
    <div class="srow">
      <div class="spin" id="spin"></div>
      <span id="smsg">Initialising&hellip;</span>
      <div class="abtns">
        <button class="btndl"  id="dl-btn"    onclick="downloadResult()">&#8595; Download JSON</button>
        <button class="btnnew" id="reset-btn" onclick="resetUI()">New Scrape</button>
      </div>
    </div>
    <div class="logbox" id="logbox"></div>
    <button class="btndownload" id="big-dl-btn" onclick="downloadResult()">&#8595; Download JSON</button>
  </div>
</div>

<script>
var currentJobId = null;
var PRESETS = {};

fetch('/api/presets').then(function(r){ return r.json(); }).then(function(p){ PRESETS = p; });

function onBrowserToggle() {
  document.getElementById('opt-delay').value = document.getElementById('opt-browser').checked ? 800 : 300;
}

function loadPreset(name) {
  var p = PRESETS[name];
  if (!p) return;
  document.getElementById('url-input').value = p.urls.join('\\n');
  if (p.browser) {
    document.getElementById('opt-browser').checked = true;
    onBrowserToggle();
  }
}

function startScrape() {
  var raw = document.getElementById('url-input').value.trim();
  if (!raw) { alert('Enter at least one URL.'); return; }

  var urlList = raw.split(/[\\n\\r,]+/).map(function(u) {
    u = u.trim();
    if (u && !/^https?:\\/\\//i.test(u)) u = 'https://' + u;
    return u;
  }).filter(Boolean);

  if (urlList.length === 0) { alert('Enter at least one URL.'); return; }

  var payload = {
    urls:    urlList.join(','),
    limit:   parseInt(document.getElementById('opt-limit').value, 10) || 20,
    delay:   parseInt(document.getElementById('opt-delay').value, 10) || 300,
    browser: document.getElementById('opt-browser').checked,
    noPdp:   document.getElementById('opt-no-pdp').checked
  };

  document.getElementById('form-section').style.display = 'none';
  document.getElementById('results').style.display = 'block';
  document.getElementById('logbox').innerHTML = '';
  document.getElementById('spin').style.display = '';
  document.getElementById('dl-btn').style.display = 'none';
  document.getElementById('reset-btn').style.display = 'none';
  var smsg = document.getElementById('smsg');
  smsg.className = '';
  smsg.textContent = 'Starting…';

  fetch('/api/scrape', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
  .then(function(r) { return r.json(); })
  .then(function(json) {
    if (json.error) { showError(json.error); return; }
    currentJobId = json.jobId;
    smsg.textContent = 'Scraping ' + urlList.length + ' URL' + (urlList.length !== 1 ? 's' : '') + '…';

    var es = new EventSource('/api/progress/' + currentJobId);
    es.onmessage = function(e) {
      var ev = JSON.parse(e.data);
      if (ev.type === 'done') {
        es.close();
        document.getElementById('spin').style.display = 'none';
        smsg.textContent = '✓ ' + ev.count + ' product' + (ev.count !== 1 ? 's' : '') + ' found';
        smsg.className = 'done';
        document.getElementById('dl-btn').style.display = '';
        document.getElementById('reset-btn').style.display = '';
        document.getElementById('big-dl-btn').style.display = '';
        addLog('✓ Done — ' + ev.count + ' product(s) collected', 'd');
      } else if (ev.type === 'error') {
        es.close();
        showError(ev.message);
      } else {
        addLog(ev.message, ev.type === 'warn' ? 'w' : '');
      }
    };
    es.onerror = function() { es.close(); };
  })
  .catch(function(err) { showError('Failed to start: ' + err.message); });
}

function addLog(msg, cls) {
  var box = document.getElementById('logbox');
  var d = document.createElement('div');
  d.className = 'll' + (cls ? ' ' + cls : '');
  d.textContent = msg;
  box.appendChild(d);
  box.scrollTop = box.scrollHeight;
}

function showError(msg) {
  document.getElementById('spin').style.display = 'none';
  var smsg = document.getElementById('smsg');
  smsg.textContent = '✗ ' + msg;
  smsg.className = 'err';
  document.getElementById('reset-btn').style.display = '';
  addLog('✗ ' + msg, 'e');
}

function downloadResult() {
  if (currentJobId) window.location.href = '/api/result/' + currentJobId;
}

function resetUI() {
  currentJobId = null;
  document.getElementById('form-section').style.display = '';
  document.getElementById('results').style.display = 'none';
  document.getElementById('big-dl-btn').style.display = 'none';
}
</script>
</body>
</html>`;

// ── HTTP helpers ───────────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((ok, fail) => {
    let buf = '';
    req.on('data', c => { buf += c; });
    req.on('end', () => { try { ok(JSON.parse(buf)); } catch (e) { fail(e); } });
    req.on('error', fail);
  });
}

// ── HTTP server ────────────────────────────────────────────────────────────────
const server = createServer(async (req, res) => {
  const { method } = req;
  const url = new URL(req.url, 'http://localhost:' + PORT);
  const { pathname } = url;

  try {
    if (method === 'GET' && pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(HTML);
    }

    if (method === 'GET' && pathname === '/api/presets') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(PRESETS));
    }

    if (method === 'POST' && pathname === '/api/scrape') {
      const opts = await readBody(req);
      if (!opts.urls) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'urls is required' }));
      }
      const jobId = await startJob(opts);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ jobId }));
    }

    if (method === 'GET' && pathname.startsWith('/api/progress/')) {
      const jobId = pathname.split('/').pop();
      const job   = jobs.get(jobId);
      if (!job) { res.writeHead(404); return res.end('Job not found'); }

      res.writeHead(200, {
        'Content-Type':      'text/event-stream',
        'Cache-Control':     'no-cache',
        'Connection':        'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(':\n\n');

      for (const entry of job.logs) {
        res.write('data: ' + JSON.stringify(entry) + '\n\n');
      }
      if (job.status !== 'running') return res.end();

      job.clients.add(res);
      req.on('close', () => job.clients.delete(res));
      return;
    }

    if (method === 'GET' && pathname.startsWith('/api/result/')) {
      const jobId = pathname.split('/').pop();
      const job   = jobs.get(jobId);
      if (!job || !job.result) { res.writeHead(404); return res.end('Result not ready'); }

      const date = new Date().toISOString().slice(0, 10);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': 'attachment; filename="products-' + date + '.json"',
      });
      return res.end(JSON.stringify(job.result, null, 2));
    }

    res.writeHead(404);
    res.end('Not found');
  } catch (err) {
    console.error(err);
    if (!res.headersSent) { res.writeHead(500); res.end('Internal error'); }
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n  Product Scraper Dashboard');
  console.log('  ─────────────────────────');
  console.log('  http://localhost:' + PORT + '\n');
});
