const http = require('http');
const https = require('https');
const crypto = require('crypto');

const KEY = process.env.PROXY_KEY || '';
const ALLOWED = ['servicios1.afip.gov.ar', 'wswhomo.afip.gov.ar'];

const same = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

http.createServer((req, res) => {
  if (!KEY || req.method !== 'POST' || !same(req.headers['x-api-key'] || '', KEY)) {
    res.writeHead(401); return res.end();
  }
  let target;
  try { target = new URL(req.headers['x-target-url']); } catch { res.writeHead(400); return res.end(); }
  if (target.protocol !== 'https:' || !ALLOWED.includes(target.hostname)) {
    res.writeHead(403); return res.end();
  }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const out = https.request({
      hostname: target.hostname,
      path: target.pathname + target.search,
      method: 'POST',
      ciphers: 'DEFAULT@SECLEVEL=0',
      headers: {
        'Content-Type': 'text/xml; charset=UTF-8',
        'SOAPAction': req.headers['soapaction'] || '',
        'Content-Length': body.length,
      },
    }, (r) => {
      const parts = [];
      r.on('data', (c) => parts.push(c));
      r.on('end', () => {
        res.writeHead(r.statusCode || 502, { 'Content-Type': 'text/xml; charset=utf-8' });
        res.end(Buffer.concat(parts));
      });
    });
    out.on('error', (e) => { res.writeHead(502); res.end(String(e.message)); });
    out.write(body);
    out.end();
  });
}).listen(process.env.PORT || 3000);
