/**
 * Local dev server for flent-dashboards.
 * - Stubs auth-gate.js so pages load without a Supabase session
 * - Proxies POST /api/hw-count    → Twenty CRM GraphQL totalCount
 * - Proxies POST /api/hw-utm-agg  → Twenty CRM cursor-paginated, aggregate by field
 * - Proxies POST /api/hw-weekly   → Twenty CRM cursor-paginated, group by week
 * - Proxies POST /api/meta-ads-insights → Meta Ads API
 * - Proxies POST /api/google-ads-spend  → Google Ads API
 * - Serves all other static files from this directory
 *
 * Usage: HAWKEYE_TOKEN=<jwt> node server.js
 */

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const PORT      = process.env.PORT || 4000;
const DIR       = __dirname;
const HW_TOKEN  = process.env.HAWKEYE_TOKEN || '';
const HW_HOST   = 'crm.flent.in';
const HW_PATH   = '/graphql';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript',
  '.css':  'text/css',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
  '.svg':  'image/svg+xml',
  '.json': 'application/json',
};

const GQL_TIMEOUT_MS = 30_000; // 30 s per page request

// ── Twenty CRM GraphQL helper ─────────────────────────────────────────────────
function hwGql(query) {
  return new Promise((resolve, reject) => {
    const buf = Buffer.from(JSON.stringify({ query }));
    const req = https.request({
      hostname: HW_HOST,
      path:     HW_PATH,
      method:   'POST',
      headers: {
        'Authorization':  'Bearer ' + HW_TOKEN,
        'Content-Type':   'application/json',
        'Content-Length': buf.length,
      },
      timeout: GQL_TIMEOUT_MS,
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Twenty CRM parse error: ' + data.slice(0, 300))); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Twenty CRM request timed out')); });
    req.on('error', reject);
    req.write(buf);
    req.end();
  });
}

// Allowlists for enum fields — only these values are forwarded to GQL.
const VALID_LEADSTATUS     = new Set(['NEW', 'OPEN', 'QUALIFIED', 'UNQUALIFIED', 'ATTEMPTED_TO_CONTACT', 'CONNECTED', 'BAD_TIMING']);
const VALID_LIFECYCLE      = new Set(['LEAD', 'PROSPECT', 'ACTIVE', 'CONVERTED', 'CHURNED']);
const VALID_INQUIRY_CH     = new Set(['DIRECT_CALL', 'WHATSAPP', 'WEB_FORM', 'REFERRAL', 'WALK_IN', 'EMAIL']);
const VALID_PROPERTIES     = new Set(['utmSource', 'utmContent', 'utmTerm', 'preferredMicromarkets', 'createdAt']);
const DATE_RE              = /^\d{4}-\d{2}-\d{2}$/;
// Allow only safe characters in user-supplied string-match values (no GQL metacharacters).
const SAFE_STR_RE          = /^[a-zA-Z0-9 _\-./+@]+$/;

function sanitizeStr(s) {
  if (typeof s !== 'string') return '';
  const t = s.trim().slice(0, 200);
  return SAFE_STR_RE.test(t) ? t : '';
}

// Build a Twenty CRM GraphQL filter literal from the flat filter spec sent by the frontend.
// Field mapping (Hawkeye → HubSpot equivalents):
//   createdAt             ← createdate
//   leadstatus            ← hs_lead_status
//   tenantLifecycle       ← customer_type (CONVERTED = move-in)
//   firstInquiryChannel   ← dw_callback_requested channel
//   utmSource/Content/Term← utm_source/content/term
//   preferredMicromarkets ← preferred_area
function buildFilter(f) {
  // Twenty CRM only allows one operator per field per filter block.
  // Date ranges (gte + lte) must be expressed as two separate `and` conditions.
  const andParts  = [];
  const topParts  = [];

  // createDate is the actual lead submission date (what Twenty UI shows as "Create Date").
  // createdAt is when the sync job wrote the record to Twenty — always at :31 minutes, wrong for filtering.
  if (f.startDate && DATE_RE.test(f.startDate)) {
    andParts.push(`{ createDate: { gte: "${f.startDate}" } }`);
  }
  if (f.endDate && DATE_RE.test(f.endDate)) {
    andParts.push(`{ createDate: { lte: "${f.endDate}" } }`);
  }

  // Enum filters — values validated against allowlists; appear without quotes in GQL literals
  if (f.leadstatus          && VALID_LEADSTATUS.has(f.leadstatus))         topParts.push(`leadstatus: { eq: ${f.leadstatus} }`);
  if (f.tenantLifecycle     && VALID_LIFECYCLE.has(f.tenantLifecycle))     topParts.push(`tenantLifecycle: { eq: ${f.tenantLifecycle} }`);
  if (f.firstInquiryChannel && VALID_INQUIRY_CH.has(f.firstInquiryChannel)) topParts.push(`firstInquiryChannel: { eq: ${f.firstInquiryChannel} }`);

  // UTM source "contains" filter — sanitized to safe characters only
  const utmContains = sanitizeStr(f.utmContains);
  if (utmContains) topParts.push(`utmSource: { like: "%${utmContains}%" }`);

  // Visit-count filters (fields exist on tenant but may be null for older records)
  if (f.hasVisits)          topParts.push(`totalVisitsCount: { gt: 0 }`);
  if (f.hasVisitsCompleted) topParts.push(`visitsCompleted: { gt: 0 }`);

  // Boolean visit flags backfilled from HubSpot
  if (f.visitCompleted) topParts.push(`visitCompleted: { eq: true }`);
  if (f.visitCancelled) topParts.push(`visitCancelled: { eq: true }`);

  // OR filter for inorganic move-in (meta + google combined in one query)
  if (Array.isArray(f.orUtmSources) && f.orUtmSources.length) {
    const safe = f.orUtmSources.map(sanitizeStr).filter(Boolean).slice(0, 10);
    if (safe.length) {
      const orParts = safe.map(s => `{ utmSource: { like: "%${s}%" } }`);
      topParts.push(`or: [${orParts.join(', ')}]`);
    }
  }

  if (andParts.length) topParts.push(`and: [${andParts.join(', ')}]`);

  return topParts.length ? '{ ' + topParts.join(', ') + ' }' : '';
}

// ── /api/hw-count ─────────────────────────────────────────────────────────────
// Returns { total: N } for a given filter spec.
async function hwCount(bodyStr, res) {
  if (!HW_TOKEN) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'HAWKEYE_TOKEN not set' }));
    return;
  }

  const f = JSON.parse(bodyStr);
  const filterStr = buildFilter(f);
  const query = filterStr
    ? `{ tenants(filter: ${filterStr}) { totalCount } }`
    : `{ tenants { totalCount } }`;

  const result = await hwGql(query);
  if (result.errors) throw new Error(result.errors[0]?.message || 'Twenty CRM GQL error');

  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify({ total: result.data?.tenants?.totalCount || 0 }));
}

// ── /api/hw-utm-agg ───────────────────────────────────────────────────────────
// Cursor-paginated scan of all matching tenants; counts by the requested property.
// For isArrayField=true the property is a string array (e.g. preferredMicromarkets)
// and each element is counted separately (one tenant can appear in multiple buckets).
const PAGE_SIZE = 500;

async function hwUtmAgg(bodyStr, res) {
  if (!HW_TOKEN) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'HAWKEYE_TOKEN not set' }));
    return;
  }

  const body     = JSON.parse(bodyStr);
  const property = body.property   || 'utmSource';
  if (!VALID_PROPERTIES.has(property)) {
    res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Invalid property: ' + property }));
    return;
  }
  const isArray  = body.isArrayField === true;
  const filterStr = buildFilter(body);

  const counts = {};
  let cursor  = null;
  let hasMore = true;
  let total   = 0;

  while (hasMore) {
    const afterPart  = cursor    ? `, after: "${cursor}"` : '';
    const filterPart = filterStr ? `, filter: ${filterStr}` : '';
    const query = `{
      tenants(first: ${PAGE_SIZE}${afterPart}${filterPart}) {
        totalCount
        pageInfo { hasNextPage endCursor }
        edges { node { ${property} } }
      }
    }`;

    const result = await hwGql(query);
    if (result.errors) throw new Error(result.errors[0]?.message || 'Twenty CRM GQL error');

    const data = result.data?.tenants || {};
    if (!cursor) total = data.totalCount || 0;

    for (const { node } of (data.edges || [])) {
      const raw = node[property];
      let keys;
      if (isArray) {
        keys = (Array.isArray(raw) ? raw : (raw ? [raw] : [])).filter(Boolean);
      } else {
        const s = (raw || '').trim();
        keys = s ? [s] : (property === 'utmSource' ? ['Organic'] : []);
      }
      for (const k of keys) counts[k] = (counts[k] || 0) + 1;
    }

    hasMore = data.pageInfo?.hasNextPage || false;
    cursor  = data.pageInfo?.endCursor   || null;
  }

  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify({ counts, total }));
}

// ── /api/hw-weekly ────────────────────────────────────────────────────────────
// Cursor-paginated scan; groups tenant createdAt timestamps by ISO week (Mon start).
async function hwWeekly(bodyStr, res) {
  if (!HW_TOKEN) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'HAWKEYE_TOKEN not set' }));
    return;
  }

  const body      = JSON.parse(bodyStr);
  const filterStr = buildFilter(body);

  function monStart(ts) {
    const d = new Date(ts);
    const day = d.getUTCDay();
    const diff = day === 0 ? -6 : 1 - day;
    d.setUTCDate(d.getUTCDate() + diff);
    return d.toISOString().slice(0, 10);
  }

  const weeks = {};
  let cursor  = null;
  let hasMore = true;
  let total   = 0;

  while (hasMore) {
    const afterPart  = cursor    ? `, after: "${cursor}"` : '';
    const filterPart = filterStr ? `, filter: ${filterStr}` : '';
    const query = `{
      tenants(first: ${PAGE_SIZE}${afterPart}${filterPart}) {
        totalCount
        pageInfo { hasNextPage endCursor }
        edges { node { createDate } }
      }
    }`;

    const result = await hwGql(query);
    if (result.errors) throw new Error(result.errors[0]?.message || 'Twenty CRM GQL error');

    const data = result.data?.tenants || {};
    if (!cursor) total = data.totalCount || 0;

    for (const { node } of (data.edges || [])) {
      if (!node.createDate) continue;
      const wk = monStart(node.createDate);
      weeks[wk] = (weeks[wk] || 0) + 1;
    }

    hasMore = data.pageInfo?.hasNextPage || false;
    cursor  = data.pageInfo?.endCursor   || null;
  }

  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify({ weeks, total }));
}

// ── Meta Ads API ─────────────────────────────────────────────────────────────
const META_TOKEN   = process.env.META_TOKEN     || '';
const META_ACCOUNT = process.env.META_ACCOUNT_ID || '';
const META_API_VER = 'v21.0';

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
  const qs   = `fields=${fields}&level=${level}&${timeParam}&access_token=${META_TOKEN}`;
  const reqPath = `/${META_API_VER}/act_${META_ACCOUNT}/insights?${qs}`;

  await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'graph.facebook.com',
      path: reqPath,
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
  clientId:        process.env.GADS_CLIENT_ID        || '',
  clientSecret:    process.env.GADS_CLIENT_SECRET    || '',
  refreshToken:    process.env.GADS_REFRESH_TOKEN    || '',
  developerToken:  process.env.GADS_DEVELOPER_TOKEN  || '',
  customerId:      process.env.GADS_CUSTOMER_ID      || '',
  loginCustomerId: process.env.GADS_LOGIN_CUSTOMER_ID || '',
};

let _gadsToken = null, _gadsExpiry = 0;

async function getGadsToken() {
  if (_gadsToken && Date.now() < _gadsExpiry) return _gadsToken;
  const body = new URLSearchParams({
    client_id:     GADS.clientId,
    client_secret: GADS.clientSecret,
    refresh_token: GADS.refreshToken,
    grant_type:    'refresh_token',
  }).toString();
  const r = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': body.length },
    }, res => { let d = ''; res.on('data', c => { d += c; }); res.on('end', () => resolve(JSON.parse(d))); });
    req.on('error', reject); req.write(body); req.end();
  });
  if (!r.access_token) throw new Error('Google token error: ' + JSON.stringify(r));
  _gadsToken  = r.access_token;
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

  const token   = await getGadsToken();
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

// ── HTTP server ───────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const urlPath = new URL(req.url, 'http://localhost').pathname;

  if (req.method === 'POST') {
    const BODY_LIMIT = 64 * 1024; // 64 KB — more than enough for any filter payload
    let body = '', bodyLen = 0;
    req.on('data', c => {
      bodyLen += c.length;
      if (bodyLen > BODY_LIMIT) { req.destroy(); return; }
      body += c;
    });
    req.on('end', () => {
      if (bodyLen > BODY_LIMIT) {
        res.writeHead(413, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ error: 'Request body too large' }));
        return;
      }

      // Validate JSON before passing to any handler
      try { JSON.parse(body || '{}'); } catch (_) {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ error: 'Invalid JSON body' }));
        return;
      }
      const safeBody = body || '{}';

      const wrap = fn => fn(safeBody, res).catch(e => {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });

      if (urlPath === '/api/hw-count')          { wrap(hwCount);         return; }
      if (urlPath === '/api/hw-utm-agg')         { wrap(hwUtmAgg);        return; }
      if (urlPath === '/api/hw-weekly')          { wrap(hwWeekly);        return; }
      if (urlPath === '/api/meta-ads-insights')  { wrap(metaAdsInsights); return; }
      if (urlPath === '/api/google-ads-spend')   { wrap(googleAdsSpend);  return; }

      res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'Unknown API route' }));
    });
    return;
  }

  // Stub auth-gate so pages don't redirect to /login on localhost
  if (urlPath === '/auth-gate.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript' });
    res.end('/* auth-gate disabled in local dev */\nwindow.flentSignOut=function(){location.href="/login";};');
    return;
  }

  // Static files — /flent-growth-funnel (and any unknown extensionless route) → index.html
  let file = urlPath === '/' ? '/index.html' : urlPath;
  if (!path.extname(file)) file += '.html';
  // Fall back to index.html if the specific HTML file doesn't exist (SPA-style routing)
  let abs = path.join(DIR, file);

  fs.readFile(abs, (err, data) => {
    if (err) {
      // Try index.html as fallback for dashboard sub-routes
      const fallback = path.join(DIR, 'index.html');
      fs.readFile(fallback, (err2, data2) => {
        if (err2) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found: ' + file); return; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(data2);
      });
      return;
    }
    const ct = MIME[path.extname(abs)] || 'text/plain';
    const cc = ct.startsWith('text/html') ? 'no-store' : 'max-age=60';
    res.writeHead(200, { 'Content-Type': ct, 'Cache-Control': cc });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log('\n\x1b[32m✓\x1b[0m Flent dev server → \x1b[36mhttp://localhost:' + PORT + '/flent-growth-funnel\x1b[0m\n');
  if (!HW_TOKEN) {
    console.log('\x1b[33m⚠  No HAWKEYE_TOKEN — restart with: HAWKEYE_TOKEN=<jwt> node server.js\x1b[0m\n');
  } else {
    console.log('   Hawkeye (Twenty CRM) token: \x1b[32mset ✓\x1b[0m\n');
  }
});
