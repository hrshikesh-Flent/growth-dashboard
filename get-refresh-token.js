/**
 * Run once to get a Google Ads refresh token.
 * Usage: node get-refresh-token.js
 */
const http  = require('http');
const https = require('https');
const url   = require('url');
const { exec } = require('child_process');

const CLIENT_ID     = process.env.GADS_CLIENT_ID     || '';
const CLIENT_SECRET = process.env.GADS_CLIENT_SECRET || '';
const REDIRECT_URI  = 'http://localhost:8080';
const SCOPE         = 'https://www.googleapis.com/auth/adwords';

const authUrl =
  'https://accounts.google.com/o/oauth2/auth' +
  '?client_id='     + encodeURIComponent(CLIENT_ID) +
  '&redirect_uri='  + encodeURIComponent(REDIRECT_URI) +
  '&response_type=code' +
  '&scope='         + encodeURIComponent(SCOPE) +
  '&access_type=offline' +
  '&prompt=consent';

const server = http.createServer((req, res) => {
  const params = new url.URL(req.url, 'http://localhost:8080').searchParams;
  const code = params.get('code');

  if (!code) {
    res.writeHead(400); res.end('No code received.'); return;
  }

  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<h2>✅ Authorized! Check your terminal for the refresh token.</h2>');
  server.close();

  // Exchange auth code → refresh token
  const body = new URLSearchParams({
    code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
    redirect_uri: REDIRECT_URI, grant_type: 'authorization_code',
  }).toString();

  const req2 = https.request({
    hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': body.length },
  }, res2 => {
    let data = '';
    res2.on('data', c => { data += c; });
    res2.on('end', () => {
      const json = JSON.parse(data);
      if (json.refresh_token) {
        console.log('\n\x1b[32m✅ Refresh token:\x1b[0m');
        console.log('\x1b[36m' + json.refresh_token + '\x1b[0m\n');
      } else {
        console.log('\n\x1b[31m❌ Error:\x1b[0m', JSON.stringify(json, null, 2));
      }
    });
  });
  req2.write(body); req2.end();
});

server.listen(8080, () => {
  console.log('Opening browser for Google authorization...');
  exec('open "' + authUrl + '"');
  console.log('Waiting for callback on http://localhost:8080 ...\n');
});
