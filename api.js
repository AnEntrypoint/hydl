/**
 * Hunyuan 3D API client — pure HTTP, no browser
 *
 * Auth:  cookies from browser-session.json
 * Sign:  HMAC-SHA256(nonce=N&timestamp=T, derivedKey) in query params
 */

const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SESSION_FILE = path.join(__dirname, 'browser-session.json');
const BASE = 'https://3d.hunyuan.tencent.com';

// Key derivation from bundle constants (module 47436)
function deriveSignKey() {
  const c = new Uint8Array([122,59,92,165,30,79,166,139,142,129,139,89,219,131,101,204]);
  const d = new Uint8Array([122,59,92,45,30,79,106,139,156,13,46,63,74,91,108,125]);
  const u = new Uint8Array([3,5,2,7,1,4,6,2,5,3,1,4,2,6,3,5]);
  const m = [14,11,13,9,15,10,12,8,6,3,5,1,7,2,4,0];
  const t = new Uint8Array(16);
  for (let i = 0; i < 16; i++) t[i] = c[i] ^ d[i];
  const r = new Uint8Array(16);
  for (let i = 0; i < 16; i++) { const n = u[i]; r[i] = 0xFF & (t[i] << n | t[i] >>> (8 - n)); }
  const p = new Uint8Array(16);
  for (let i = 0; i < 16; i++) p[i] = r[m[i]];
  let z = p.indexOf(0); if (z === -1) z = 16;
  return Buffer.from(p.slice(0, z)).toString('utf-8');
}

const SIGN_KEY = deriveSignKey();

function randomNonce(len = 16) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * 62)];
  return s;
}

function signParams(extraParams = {}) {
  const ts = Math.floor(Date.now() / 1000);
  const nonce = randomNonce(16);
  const params = { ...extraParams, timestamp: ts, nonce };
  const qs = Object.entries(params)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => [k, String(v)])
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const sign = crypto.createHmac('sha256', SIGN_KEY).update(qs).digest('hex');
  return { timestamp: ts, nonce, sign };
}

function loadCookies() {
  if (!fs.existsSync(SESSION_FILE)) throw new Error('No session file — run node downloader.js first to log in');
  const session = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'));
  return session.cookies
    .filter(c => {
      const now = Date.now() / 1000;
      return !c.expires || c.expires > now;
    })
    .map(c => `${c.name}=${c.value}`)
    .join('; ');
}

function request(method, pathname, body = null, queryParams = {}) {
  return new Promise((resolve, reject) => {
    const cookie = loadCookies();
    const signed = signParams(queryParams);
    const qs = new URLSearchParams(signed).toString();
    const fullPath = `${pathname}?${qs}`;
    const bodyStr = body ? JSON.stringify(body) : null;

    const options = {
      hostname: '3d.hunyuan.tencent.com',
      path: fullPath,
      method,
      headers: {
        'accept': 'application/json, text/plain, */*',
        'content-type': 'application/json',
        'cookie': cookie,
        'origin': BASE,
        'referer': `${BASE}/lowpoly`,
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
        'x-product': 'hunyuan3d',
        'x-source': 'web',
      },
    };
    if (bodyStr) options.headers['content-length'] = Buffer.byteLength(bodyStr);

    const req = https.request(options, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        if (res.statusCode === 401) return reject(new Error('Session expired — re-run downloader.js to log in'));
        try { resolve({ status: res.statusCode, data: JSON.parse(text) }); }
        catch { resolve({ status: res.statusCode, data: text }); }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function generate({ prompt, style = '', polygonType = 'triangle', modelType = 'modelDitMeshV3' }) {
  const body = {
    sceneType: 'lowPoly',
    count: 4,
    modelType,
    title: prompt,
    style,
    prompt,
    enable_pbr: true,
    enableLowPoly: false,
    polygon_type: polygonType,
  };
  return request('POST', '/api/3d/creations/generations', body);
}

async function listCreations({ pageIndex = 1, pageSize = 20, sceneType = 'lowPoly' } = {}) {
  return request('POST', '/api/3d/creations/list', { pageIndex, pageSize, sceneType });
}

async function deleteCreation(id) {
  return request('POST', '/api/3d/creations/delete', { creationsIdList: [id] });
}

async function pollUntilDone(creationId, timeoutMs = 300000, intervalMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { data } = await listCreations({ pageSize: 50 });
    const creations = data?.creations || data?.data || [];
    const found = creations.find(c => c.id === creationId);
    if (found) {
      const results = found.result || [];
      const done = results.filter(r => r.status === 'success');
      const failed = results.filter(r => r.status === 'fail' || r.status === 'failed');
      if (done.length > 0) return { status: 'done', creation: found };
      if (failed.length > 0) return { status: 'failed', creation: found };
    }
    const elapsed = ((Date.now() - start) / 1000).toFixed(0);
    process.stdout.write(`\r[Poll] ${elapsed}s — waiting for ${creationId.slice(0, 8)}...`);
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return { status: 'timeout' };
}

module.exports = { generate, listCreations, deleteCreation, pollUntilDone, request };
