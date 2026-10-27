import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const publicDir = fileURLToPath(new URL('./public/', import.meta.url));
const files = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8']
};

export function createServer({ gasUrl, secret, origin, fetchImpl = fetch, now = Date.now }) {
  let windowStart = now();
  let requests = 0;
  let inFlight = 0;
  const json = (res, status, value) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(value));
  };
  return http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; style-src 'self'; connect-src 'self'; img-src 'self' data:; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    try {
      if (req.method === 'GET' && files[req.url]) {
        const [file, type] = files[req.url];
        res.writeHead(200, { 'Content-Type': type });
        return res.end(await readFile(resolve(publicDir, file)));
      }
      if (req.url !== '/api' || req.method !== 'POST') {
        return json(res, 404, { ok: false, error: '찾을 수 없는 경로입니다.' });
      }
      if (req.headers.origin !== origin || !String(req.headers['content-type']).startsWith('application/json')) {
        return json(res, 403, { ok: false, error: '허용하지 않는 요청입니다.' });
      }
      if (!secret || !/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(gasUrl || '')) {
        return json(res, 503, { ok: false, error: '서버의 GAS 연결 설정을 완료해 주세요.' });
      }
      if (now() - windowStart >= 60000) { windowStart = now(); requests = 0; }
      if (++requests > 60 || inFlight >= 4) {
        return json(res, 429, { ok: false, error: '요청이 많습니다. 잠시 후 다시 시도해 주세요.' });
      }
      let raw = '';
      for await (const chunk of req) {
        raw += chunk.toString('utf8');
        if (Buffer.byteLength(raw) > 4096) {
          return json(res, 413, { ok: false, error: '요청이 너무 큽니다.' });
        }
      }
      let input;
      try { input = JSON.parse(raw); } catch { return json(res, 400, { ok: false, error: '요청 형식 오류입니다.' }); }
      if (!input || !['lookup', 'submit'].includes(input.action)) {
        return json(res, 400, { ok: false, error: '허용하지 않는 작업입니다.' });
      }
      // 브라우저가 secret, timestamp 또는 다른 GAS 기능을 지정할 수 없게 재구성합니다.
      const payload = input.action === 'lookup'
        ? { qr: input.qr }
        : { scanToken: input.scanToken, code: input.code, requestId: input.requestId };
      inFlight++;
      try {
        const upstream = await fetchImpl(gasUrl, {
          method: 'POST', redirect: 'follow',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify({ action: input.action, payload, secret, timestamp: now() }),
          signal: AbortSignal.timeout(25000)
        });
        if (!upstream.ok) throw new Error('upstream');
        const result = await upstream.json();
        if (typeof result.ok !== 'boolean') throw new Error('format');
        return json(res, result.ok ? 200 : 400, result);
      } catch {
        // 저장 직후 응답이 끊겼을 수도 있습니다. 같은 요청ID로 재시도해야 합니다.
        return json(res, 502, { ok: false, retryable: true, error: 'GAS 응답을 확인하지 못했습니다. 같은 요청으로 다시 시도해 주세요.' });
      } finally { inFlight--; }
    } catch {
      if (!res.headersSent) json(res, 500, { ok: false, error: '서버 처리 중 오류가 발생했습니다.' });
      else res.end();
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const origin = process.env.APP_ORIGIN || 'http://localhost:3000';
  createServer({ gasUrl: process.env.GAS_URL, secret: process.env.GAS_SECRET, origin })
    .listen(Number(process.env.PORT) || 3000, '0.0.0.0', () => console.log(`QR 테스트 서버 시작: ${origin}`));
}
