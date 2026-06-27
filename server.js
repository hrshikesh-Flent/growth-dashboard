/**
 * Local dev server for flent-dashboards.
 * - Stubs auth-gate.js so pages load without a Supabase session
 * - Proxies POST /api/hs-search  → HubSpot CRM v3 search (single query)
 * - Handles POST /api/hs-utm-agg → paginates HubSpot and returns utm_source counts
 * - Serves all other static files from this directory
 *
 * Usage:  HUBSPOT_TOKEN=pat-na1-xxx node server.js
 */

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const PORT     = 3000;
const DIR      = __dirname;
const HS_TOKEN = process.env.HUBSPOT_TOKEN || '';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript',
  '.css':  'text/css',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
  '.svg':  'image/svg+xml',
  '.json': 'application/json',
};

// ── HubSpot helper ────────────────────────────────────────────────────────────
function hsPost(body) {
  return new Promise((resolve, reject) => {
    const buf = Buffer.from(JSON.stringify(body));
    const req = https.request({
      hostname: 'api.hubapi.com',
      path:     '/crm/v3/objects/contacts/search',
      method:   'POST',
      headers: {
        'Authorization':  'Bearer ' + HS_TOKEN,
        'Content-Type':   'application/json',
        'Content-Length': buf.length,
      },
    }, hsRes => {
      let data = '';
      hsRes.on('data', c => { data += c; });
      hsRes.on('end', () => {
        try { resolve({ status: hsRes.statusCode, body: JSON.parse(data) }); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(buf);
    req.end();
  });
}

// ── Generic HubSpot GET proxy ─────────────────────────────────────────────────
function proxyHsGet(bodyStr, res) {
  if (!HS_TOKEN) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'HUBSPOT_TOKEN not set' }));
    return;
  }
  try {
    const base = JSON.parse(bodyStr);
    const params = base.params || {};
    const qs = Object.entries(params)
      .flatMap(([k, v]) => (Array.isArray(v) ? v : [v])
        .map(i => encodeURIComponent(k) + '=' + encodeURIComponent(i)))
      .join('&');
    const fullPath = base.path + (qs ? '?' + qs : '');
    const req = https.request({
      hostname: 'api.hubapi.com',
      path: fullPath,
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + HS_TOKEN },
    }, hsRes => {
      let data = '';
      hsRes.on('data', c => { data += c; });
      hsRes.on('end', () => {
        res.writeHead(hsRes.statusCode, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(data);
      });
    });
    req.on('error', e => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    });
    req.end();
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

// ── Single search proxy ───────────────────────────────────────────────────────
function proxySearch(bodyStr, res) {
  if (!HS_TOKEN) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'HUBSPOT_TOKEN not set' }));
    return;
  }
  hsPost(JSON.parse(bodyStr))
    .then(({ status, body }) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(body));
    })
    .catch(e => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    });
}

// ── UTM aggregation (batched parallel pages, counts by utm_source) ────────────
// Fetches page 1 to get total, then fans out remaining pages in batches of 4
// (300 ms apart). HubSpot search accepts integer after-offsets and has a strict
// per-second rate limit — batch-4 + 300 ms gap is empirically zero rate-limits
// and finishes ~44 pages (8 000+ contacts) in ~9 s vs ~30 s sequential.
async function aggregateUTM(bodyStr, res) {
  if (!HS_TOKEN) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'HUBSPOT_TOKEN not set' }));
    return;
  }

  const base = JSON.parse(bodyStr); // expects { filterGroups: [...], property?, splitBy? }
  const property = base.property || 'utm_source';
  const splitBy  = base.splitBy  || null; // e.g. ';' for HubSpot multi-value properties
  const LIMIT = 200;
  const BATCH = 4;         // pages per batch
  const GAP_MS = 500;      // ms between batches (keeps us under HubSpot's secondly limit)
  const baseQuery = { filterGroups: base.filterGroups, properties: [property], limit: LIMIT };

  // Page 1 — fetched first to obtain total
  const { status: s1, body: b1 } = await hsPost(baseQuery);
  if (s1 !== 200) {
    res.writeHead(s1, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(b1));
    return;
  }

  const total = b1.total || 0;
  const counts = {};

  function tally(results) {
    for (const c of results) {
      const src = ((c.properties && c.properties[property]) || '').trim();
      // For multi-value properties (splitBy set), split and count each value separately.
      // For utm_source, empty = organic traffic. For other single-value properties: skip empty.
      const keys = splitBy && src
        ? src.split(splitBy).map(s => s.trim()).filter(Boolean)
        : [src || (property === 'utm_source' ? 'Organic' : null)].filter(Boolean);
      for (const key of keys) counts[key] = (counts[key] || 0) + 1;
    }
  }

  tally(b1.results || []);

  if (total > LIMIT) {
    // max HubSpot offset is 10 000; cap at 49 more pages (page 1 already done)
    const pageCount = Math.min(Math.ceil(total / LIMIT) - 1, 49);
    const offsets = Array.from({ length: pageCount }, (_, i) => (i + 1) * LIMIT);

    for (let i = 0; i < offsets.length; i += BATCH) {
      const batch = offsets.slice(i, i + BATCH);
      const pages = await Promise.all(
        batch.map(after =>
          hsPost({ ...baseQuery, after })
            .then(r => (r.status === 200 ? r.body.results : []) || [])
            .catch(() => [])
        )
      );
      for (const results of pages) tally(results);
      // pause between batches to stay within HubSpot's per-second request limit
      if (i + BATCH < offsets.length)
        await new Promise(r => setTimeout(r, GAP_MS));
    }
  }

  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify({ counts, total }));
}

// ── Meta Ads API ─────────────────────────────────────────────────────────────
const META_TOKEN     = process.env.META_TOKEN || '';
const META_ACCOUNT   = process.env.META_ACCOUNT_ID || '';
const META_API_VER   = 'v21.0';

async function metaAdsInsights(bodyStr, res) {
  if (!META_TOKEN) {
    res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'META_TOKEN not set' }));
    return;
  }
  const { startDate, endDate, datePreset, level = 'campaign' } = JSON.parse(bodyStr);
  const timeParam = startDate && endDate
    ? `time_range=${encodeURIComponent(JSON.stringify({ since: startDate, until: endDate }))}`
    : `date_preset=${datePreset || 'this_month'}`;

  const fields = level === 'ad'
    ? 'ad_name,spend,clicks,cpc'
    : 'spend,impressions,clicks,cpc,cpm,reach,campaign_name';
  const qs = `fields=${fields}&level=${level}&${timeParam}&access_token=${META_TOKEN}`;
  const path = `/${META_API_VER}/act_${META_ACCOUNT}/insights?${qs}`;

  await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'graph.facebook.com',
      path,
      method: 'GET',
    }, metaRes => {
      let d = '';
      metaRes.on('data', c => { d += c; });
      metaRes.on('end', () => {
        res.writeHead(metaRes.statusCode, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(d);
        resolve();
      });
    });
    req.on('error', e => { reject(e); });
    req.end();
  });
}

// ── Google Ads API ────────────────────────────────────────────────────────────
const GADS = {
  clientId:       process.env.GADS_CLIENT_ID       || '',
  clientSecret:   process.env.GADS_CLIENT_SECRET   || '',
  refreshToken:   process.env.GADS_REFRESH_TOKEN   || '',
  developerToken: process.env.GADS_DEVELOPER_TOKEN || '',
  customerId:     process.env.GADS_CUSTOMER_ID     || '',
  loginCustomerId:process.env.GADS_LOGIN_CUSTOMER_ID || '',
};

let _gadsToken = null, _gadsExpiry = 0;

async function getGadsToken() {
  if (_gadsToken && Date.now() < _gadsExpiry) return _gadsToken;
  const body = new URLSearchParams({
    client_id: GADS.clientId, client_secret: GADS.clientSecret,
    refresh_token: GADS.refreshToken, grant_type: 'refresh_token',
  }).toString();
  const r = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': body.length },
    }, res => { let d = ''; res.on('data', c => { d += c; }); res.on('end', () => resolve(JSON.parse(d))); });
    req.on('error', reject); req.write(body); req.end();
  });
  if (!r.access_token) throw new Error('Google token error: ' + JSON.stringify(r));
  _gadsToken = r.access_token;
  _gadsExpiry = Date.now() + (r.expires_in - 60) * 1000;
  return _gadsToken;
}

async function googleAdsSpend(bodyStr, res) {
  const { startDate, endDate } = JSON.parse(bodyStr);
  const dateClause = startDate && endDate
    ? `segments.date BETWEEN '${startDate}' AND '${endDate}'`
    : `segments.date DURING LAST_30_DAYS`;

  const query = `
    SELECT campaign.name, metrics.cost_micros, metrics.clicks,
           metrics.impressions, metrics.average_cpc
    FROM campaign
    WHERE ${dateClause}
    ORDER BY metrics.cost_micros DESC`;

  const token = await getGadsToken();
  const payload = JSON.stringify({ query });
  await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'googleads.googleapis.com',
      path: `/v21/customers/${GADS.customerId}/googleAds:search`,
      method: 'POST',
      headers: {
        'Authorization':    'Bearer ' + token,
        'developer-token':  GADS.developerToken,
        'login-customer-id': GADS.loginCustomerId,
        'Content-Type':     'application/json',
        'Content-Length':   Buffer.byteLength(payload),
      },
    }, adsRes => {
      let d = '';
      adsRes.on('data', c => { d += c; });
      adsRes.on('end', () => {
        res.writeHead(adsRes.statusCode, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(d);
        resolve();
      });
    });
    req.on('error', e => { reject(e); });
    req.write(payload); req.end();
  });
}

// ── Weekly trend (group contacts by createdate week) ─────────────────────────
async function weeklyTrend(bodyStr, res) {
  if (!HS_TOKEN) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'HUBSPOT_TOKEN not set' }));
    return;
  }
  const base = JSON.parse(bodyStr);
  const LIMIT = 200, BATCH = 4, GAP_MS = 500;
  const baseQuery = { filterGroups: base.filterGroups, properties: ['createdate'], limit: LIMIT };

  function monStart(ts) {
    // HubSpot v3 returns createdate as ISO string ("2026-06-14T08:30:00Z");
    // numeric ms timestamps are > 1e11, so we can distinguish from a bare year like 2025.
    const n = parseFloat(ts);
    const d = (!isNaN(n) && n > 1e11) ? new Date(n) : new Date(ts);
    const day = d.getUTCDay();
    const diff = day === 0 ? -6 : 1 - day;
    d.setUTCDate(d.getUTCDate() + diff);
    return d.toISOString().slice(0, 10);
  }

  const weeks = {};
  function tally(results) {
    for (const c of results) {
      const ts = c.properties && c.properties.createdate;
      if (!ts) continue;
      const key = monStart(ts);
      weeks[key] = (weeks[key] || 0) + 1;
    }
  }

  const { status: s1, body: b1 } = await hsPost(baseQuery);
  if (s1 !== 200) {
    res.writeHead(s1, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(b1));
    return;
  }
  const total = b1.total || 0;
  tally(b1.results || []);

  if (total > LIMIT) {
    const pageCount = Math.min(Math.ceil(total / LIMIT) - 1, 49);
    const offsets = Array.from({ length: pageCount }, (_, i) => (i + 1) * LIMIT);
    for (let i = 0; i < offsets.length; i += BATCH) {
      const batch = offsets.slice(i, i + BATCH);
      const pages = await Promise.all(
        batch.map(after =>
          hsPost({ ...baseQuery, after })
            .then(r => (r.status === 200 ? r.body.results : []) || [])
            .catch(() => [])
        )
      );
      for (const results of pages) tally(results);
      if (i + BATCH < offsets.length) await new Promise(r => setTimeout(r, GAP_MS));
    }
  }

  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify({ weeks, total }));
}

// ── HTTP server ───────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const urlPath = new URL(req.url, 'http://localhost').pathname;

  if (req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      if (urlPath === '/api/hs-search')    { proxySearch(body, res); return; }
      if (urlPath === '/api/hs-get')       { proxyHsGet(body, res); return; }
      if (urlPath === '/api/meta-ads-insights') { metaAdsInsights(body, res).catch(e => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }); return; }
      if (urlPath === '/api/google-ads-spend') { googleAdsSpend(body, res).catch(e => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }); return; }
      if (urlPath === '/api/hs-utm-agg') { aggregateUTM(body, res).catch(e => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }); return; }
      if (urlPath === '/api/hs-weekly') { weeklyTrend(body, res).catch(e => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }); return; }
      res.writeHead(404); res.end('Unknown API route');
    });
    return;
  }

  // Stub auth-gate so pages don't redirect to /login on localhost
  if (urlPath === '/auth-gate.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript' });
    res.end('/* auth-gate disabled in local dev */\nwindow.flentSignOut=function(){location.href="/login";};');
    return;
  }

  // Static files
  let file = urlPath === '/' ? '/index.html' : urlPath;
  if (!path.extname(file)) file += '.html';
  const abs = path.join(DIR, file);

  fs.readFile(abs, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found: ' + file); return; }
    const ct = MIME[path.extname(abs)] || 'text/plain';
    // Never cache HTML so JS changes always reach the browser immediately
    const cc = ct.startsWith('text/html') ? 'no-store' : 'max-age=60';
    res.writeHead(200, { 'Content-Type': ct, 'Cache-Control': cc });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log('\n\x1b[32m✓\x1b[0m Flent dev server → \x1b[36mhttp://localhost:' + PORT + '/flent-growth-funnel\x1b[0m\n');
  if (!HS_TOKEN) {
    console.log('\x1b[33m⚠  No HUBSPOT_TOKEN — restart with: HUBSPOT_TOKEN=pat-na1-xxx node server.js\x1b[0m\n');
  } else {
    console.log('   HubSpot token: \x1b[32mset ✓\x1b[0m\n');
  }
});
