'use strict';
// 로컬 전용 작은 서버. 127.0.0.1에만 바인딩하며 외부 호출·모델 호출이 없다.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { Store } = require('./lib/store');
const { RecordedResponder } = require('./lib/responder');
const { ModelResponder } = require('./lib/model-responder');
const { ChatService } = require('./lib/chat-service');

const VERSION = require('./package.json').version;
const MAX_BODY = 64 * 1024;
const IMPORT_BODY = 5 * 1024 * 1024; // 검증기의 4MB 한도 + JSON 감싸기 여유
const DRAIN_LIMIT = 1024 * 1024; // 한도 초과 뒤 이만큼까지는 읽어 버리고 413을 정상 응답한다
const STATUS_BY_CODE = {
  BAD_ID: 400, BAD_INPUT: 400, BAD_JSON: 400, FORBIDDEN: 403, NOT_FOUND: 404, PENDING: 409, BUSY: 409,
  TOO_LARGE: 413, UNSUPPORTED_TYPE: 415, BAD_WORK: 422, ARCHIVED: 409, ENDED: 409, BAD_IMPORT: 422,
};
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

function sendJson(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

function sendError(res, err) {
  const code = err && err.code && STATUS_BY_CODE[err.code] ? err.code : 'INTERNAL';
  const status = STATUS_BY_CODE[code] || 500;
  const message = status === 500 ? '서버 내부 오류' : err.message;
  if (status === 500) console.error(err);
  const body = { error: { code, message } };
  if (Array.isArray(err.details)) body.error.details = err.details;
  sendJson(res, status, body);
}

function readJsonBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = Number(req.headers['content-length'] || 0) > limit;
    req.on('data', (c) => {
      size += c.length;
      if (tooLarge || size > limit) {
        tooLarge = true;
        chunks.length = 0;
        // 413을 제대로 돌려주기 위해 본문을 버리며 끝까지 읽는다. 너무 크면 그때 끊는다.
        if (size > limit + DRAIN_LIMIT) req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooLarge) {
        const err = new Error(`요청 본문은 ${limit} 바이트 이하여야 합니다`); err.code = 'TOO_LARGE';
        return reject(err);
      }
      if (!chunks.length) return resolve({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('bad');
        resolve(parsed);
      } catch {
        const err = new Error('JSON 본문을 읽을 수 없습니다'); err.code = 'BAD_JSON';
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(res, publicDir, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.resolve(publicDir, rel);
  if (!file.startsWith(path.resolve(publicDir) + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: '없는 경로입니다' } });
  }
  const type = MIME[path.extname(file)] || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'",
    'Referrer-Policy': 'no-referrer',
  });
  fs.createReadStream(file).pipe(res);
}

// 브라우저에서 온 요청이 이 서버 자신의 출처인지 확인한다(다른 사이트의 CSRF·DNS rebinding 차단).
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
function hostAllowed(req) {
  const host = String(req.headers.host || '');
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
  return LOCAL_HOSTS.has(name);
}
function originAllowed(req) {
  const origin = req.headers.origin;
  if (origin === undefined) return true; // curl 등 브라우저 밖 요청
  if (origin === 'null') return false;
  try {
    const u = new URL(origin);
    return u.protocol === 'http:' && LOCAL_HOSTS.has(u.hostname === '::1' ? '[::1]' : u.hostname)
      && `${u.host}` === String(req.headers.host || '');
  } catch { return false; }
}
function guardMutation(req) {
  if (!originAllowed(req)) throw Object.assign(new Error('다른 출처의 변경 요청은 거부합니다'), { code: 'FORBIDDEN' });
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') throw Object.assign(new Error('다른 사이트에서 온 변경 요청은 거부합니다'), { code: 'FORBIDDEN' });
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') throw Object.assign(new Error('변경 요청은 Content-Type: application/json 이어야 합니다'), { code: 'UNSUPPORTED_TYPE' });
}

function createApp({ dataDir, publicDir, responder } = {}) {
  const store = new Store(dataDir || path.join(__dirname, 'data'));
  const service = new ChatService(store, responder || new RecordedResponder());
  const pub = publicDir || path.join(__dirname, 'public');

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const p = url.pathname;
    try {
      if (!hostAllowed(req)) return sendJson(res, 403, { error: { code: 'FORBIDDEN', message: '이 서버는 127.0.0.1/localhost 로만 접근할 수 있습니다' } });
      if (!p.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: { code: 'METHOD', message: '허용되지 않는 메서드' } });
        return serveStatic(res, pub, p);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') guardMutation(req);
      const seg = p.split('/').filter(Boolean); // ['api', ...]
      if (req.method === 'GET' && p === '/api/meta') {
        const r = service.responder;
        const model = r.kind === 'model' ? { baseUrl: r.opts.baseUrl, name: r.opts.model, timeoutMs: r.opts.timeoutMs, maxTurns: r.opts.maxTurns, maxHistoryChars: r.opts.maxHistoryChars, maxTokens: r.opts.maxTokens } : null;
        return sendJson(res, 200, { version: VERSION, ...service.decorateMeta(), model });
      }
      if (req.method === 'GET' && p === '/api/works') return sendJson(res, 200, { works: service.listWorks() });
      if (req.method === 'GET' && seg[1] === 'works' && seg.length === 3) return sendJson(res, 200, { work: service.getWork(seg[2]) });
      if (req.method === 'GET' && p === '/api/chats') {
        const workId = url.searchParams.get('work') || undefined;
        return sendJson(res, 200, { chats: service.listChats(workId) });
      }
      if (req.method === 'POST' && p === '/api/chats/import') {
        const body = await readJsonBody(req, IMPORT_BODY); // 채팅 파일은 일반 요청보다 클 수 있다
        return sendJson(res, 201, { chat: service.importChat(body.jsonl) });
      }
      if (req.method === 'POST' && p === '/api/chats') {
        const body = await readJsonBody(req);
        return sendJson(res, 201, { chat: service.createChat(body.workId, body.startId) });
      }
      if (seg[1] === 'chats' && seg.length === 3 && req.method === 'GET') return sendJson(res, 200, { chat: service.getChat(seg[2]) });
      if (seg[1] === 'chats' && seg.length === 4 && seg[3] === 'export' && req.method === 'GET') {
        const { raw, filename } = service.exportChat(seg[2]);
        res.writeHead(200, {
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Content-Disposition': `attachment; filename="chat-${seg[2]}.jsonl"; filename*=UTF-8''${encodeURIComponent(filename)}`,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        return res.end(raw);
      }
      if (seg[1] === 'chats' && seg.length === 3 && req.method === 'PATCH') {
        const body = await readJsonBody(req);
        return sendJson(res, 200, { chat: service.update(seg[2], body) });
      }
      if (seg[1] === 'chats' && seg.length === 4 && seg[3] === 'turns' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const chat = await service.send(seg[2], { text: body.text, clientTurnId: body.clientTurnId });
        return sendJson(res, 200, { chat });
      }
      if (seg[1] === 'chats' && seg.length === 4 && seg[3] === 'branch' && req.method === 'POST') {
        const body = await readJsonBody(req);
        return sendJson(res, 201, { chat: service.branch(seg[2], body.turnId) });
      }
      if (seg[1] === 'chats' && seg.length === 4 && seg[3] === 'marks' && req.method === 'POST') {
        const body = await readJsonBody(req);
        return sendJson(res, 200, { chat: service.mark(seg[2], body.turnId, body.marked) });
      }
      if (seg[1] === 'chats' && seg.length === 4 && seg[3] === 'cancel' && req.method === 'POST') {
        await readJsonBody(req);
        return sendJson(res, 200, { chat: service.cancel(seg[2]) });
      }
      if (seg[1] === 'chats' && seg.length === 4 && seg[3] === 'retry' && req.method === 'POST') {
        await readJsonBody(req);
        const chat = await service.retry(seg[2]);
        return sendJson(res, 200, { chat });
      }
      return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: '없는 API 경로입니다' } });
    } catch (err) {
      return sendError(res, err);
    }
  });
  server.service = service;
  return server;
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3737);
  const host = '127.0.0.1';
  const delayMs = Number(process.env.RESPONDER_DELAY_MS || 0); // 느린 응답 재현용(예: RESPONDER_DELAY_MS=1500)
  const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : undefined; // 검사용 임시 데이터 경로
  // 응답기 선택. 기본은 기록 응답기. RESPONDER=model 은 로컬 모델 서버를 직접 띄우고 사용자가 켜기로 한 뒤에만 쓴다.
  const responder = process.env.RESPONDER === 'model'
    ? new ModelResponder({
      baseUrl: process.env.MODEL_BASE_URL || undefined,
      model: process.env.MODEL_NAME || undefined,
      timeoutMs: process.env.MODEL_TIMEOUT_MS ? Number(process.env.MODEL_TIMEOUT_MS) : undefined,
      maxTurns: process.env.MODEL_MAX_TURNS ? Number(process.env.MODEL_MAX_TURNS) : undefined,
      maxHistoryChars: process.env.MODEL_MAX_CHARS ? Number(process.env.MODEL_MAX_CHARS) : undefined,
      ctxSize: process.env.MODEL_CTX ? Number(process.env.MODEL_CTX) : undefined, // 소유자가 LLM_CTX=8192 창을 열어 준 경우에만 맞춘다
      precheck: process.env.MODEL_PRECHECK === '0' ? false : undefined,
      label: process.env.MODEL_LABEL || undefined,
    })
    : new RecordedResponder({ delayMs });
  const server = createApp({ dataDir, responder });
  const shutdown = (sig) => {
    // 진행 중 모델 요청은 취소하고(사용자 턴은 이미 저장됨 → pending) 서버를 닫는다. 모델 서버 자체는 건드리지 않는다.
    server.service.abortAll(sig);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`포트 ${port}에 이미 다른 서버가 있습니다. 그 서버를 쓰거나 PORT=다른번호 로 다시 실행하세요.`);
    } else {
      console.error(`서버를 열지 못했습니다: ${err.message}`);
    }
    process.exit(1);
  });
  server.listen(port, host, () => {
    const actual = server.address().port; // PORT=0이면 OS가 고른 포트
    console.log(`Private Story Player 로컬 v1 · http://${host}:${actual}/ · 응답기: ${server.service.responder.label}${delayMs ? ` · 지연 ${delayMs}ms` : ''}`);
    console.log(responder.kind === 'model'
      ? `모델 호출: ${responder.opts.baseUrl} (${responder.opts.model}, timeout ${responder.opts.timeoutMs}ms). 서버 기동/종료는 소유 프로젝트가 맡습니다. 데이터: ${server.service.store.dataDir} · 종료: Ctrl+C`
      : `이 서버는 loopback(127.0.0.1)에만 열리며 외부·모델 호출이 없습니다. 데이터: ${server.service.store.dataDir} · 종료: Ctrl+C`);
  });
}

module.exports = { createApp };
