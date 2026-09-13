'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { createApp } = require('../server');
const { tempDataDir, WORK_ID } = require('./helpers');

function listen(dataDir) {
  return new Promise((resolve) => {
    const server = createApp({ dataDir });
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}
function close(server) { return new Promise((r) => server.close(r)); }
async function call(base, method, p, body) {
  const res = await fetch(base + p, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, headers: res.headers, json, text };
}

test('정적 화면과 보안 헤더, 경로 이탈 거부', async () => {
  const { server, base } = await listen(tempDataDir());
  try {
    const home = await call(base, 'GET', '/');
    assert.equal(home.status, 200);
    assert.match(home.headers.get('content-type'), /text\/html/);
    assert.match(home.headers.get('content-security-policy'), /default-src 'self'/);
    assert.match(home.text, /임시 응답|응답기 확인/);
    assert.equal((await call(base, 'GET', '/app.js')).status, 200);
    assert.equal((await call(base, 'GET', '/../server.js')).status, 404);
    assert.equal((await call(base, 'GET', '/%2e%2e/server.js')).status, 404);
    assert.equal((await call(base, 'GET', '/nope.html')).status, 404);
    assert.equal((await call(base, 'POST', '/')).status, 405);
  } finally { await close(server); }
});

test('화면 코드는 HTML 삽입 API를 쓰지 않는다(안전한 입력 표시)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|setHTMLUnsafe|createContextualFragment|document\.write/.test(src));
});

test('API 흐름: 작품 → 채팅 생성 → 보내기 → 재열람, 그리고 서버 재시작 후 동일', async () => {
  const dataDir = tempDataDir();
  let { server, base } = await listen(dataDir);
  let chatId;
  try {
    const meta = await call(base, 'GET', '/api/meta');
    assert.equal(meta.json.responder, 'recorded');
    assert.equal(meta.json.model, null);
    const works = await call(base, 'GET', '/api/works');
    assert.equal(works.json.works[0].id, WORK_ID);
    const created = await call(base, 'POST', '/api/chats', { workId: WORK_ID });
    assert.equal(created.status, 201);
    chatId = created.json.chat.id;
    const evil = '<script>alert(1)</script><img src=x onerror=alert(2)> "따옴표" \\역슬래시';
    const sent = await call(base, 'POST', `/api/chats/${chatId}/turns`, { text: evil, clientTurnId: 'c-1' });
    assert.equal(sent.status, 200);
    assert.equal(sent.json.chat.replied, true);
    assert.equal(sent.json.chat.turns[0].text, evil); // 원문 그대로 저장, JSON으로만 반환
    assert.match(sent.headers.get('content-type'), /application\/json/);
    const list = await call(base, 'GET', `/api/chats?work=${WORK_ID}`);
    assert.equal(list.json.chats[0].id, chatId);
    assert.equal(list.json.chats[0].turnCount, 2);
  } finally { await close(server); }

  ({ server, base } = await listen(dataDir)); // 재시작
  try {
    const reopened = await call(base, 'GET', `/api/chats/${chatId}`);
    assert.equal(reopened.status, 200);
    assert.equal(reopened.json.chat.turns.length, 2);
    assert.equal(reopened.json.chat.turns[1].scriptIndex, 0);
  } finally { await close(server); }
});

test('API 오류 응답: 잘못된 JSON, 없는 채팅, pending 충돌, 없는 경로', async () => {
  const { server, base } = await listen(tempDataDir());
  try {
    assert.equal((await call(base, 'POST', '/api/chats', '{not json')).status, 400);
    assert.equal((await call(base, 'POST', '/api/chats', { workId: 'ghost' })).status, 404);
    assert.equal((await call(base, 'GET', '/api/chats/ghost')).status, 404);
    assert.equal((await call(base, 'GET', '/api/chats/..%2Fx')).status, 400);
    assert.equal((await call(base, 'GET', '/api/nothing')).status, 404);
    const created = await call(base, 'POST', '/api/chats', { workId: WORK_ID });
    const id = created.json.chat.id;
    const failed = await call(base, 'POST', `/api/chats/${id}/turns`, { text: '[[실패]] 열쇠는요?' });
    assert.equal(failed.status, 200);
    assert.equal(failed.json.chat.pending, true);
    const blocked = await call(base, 'POST', `/api/chats/${id}/turns`, { text: '다시' });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.json.error.code, 'PENDING');
    const big = await call(base, 'POST', `/api/chats/${id}/turns`, { text: 'x'.repeat(70 * 1024) });
    assert.equal(big.status, 413);
  } finally { await close(server); }
});

test('다른 출처·잘못된 Host·JSON 아닌 변경 요청은 거부한다(CSRF·rebinding 방어)', async () => {
  const { server, base } = await listen(tempDataDir());
  try {
    const port = server.address().port;
    const raw = (headers, body) => fetch(`${base}/api/chats`, { method: 'POST', headers, body });
    // 단순 요청(text/plain)은 preflight 없이 도달하므로 서버가 415로 막아야 한다.
    assert.equal((await raw({ 'Content-Type': 'text/plain' }, `{"workId":"${WORK_ID}"}`)).status, 415);
    // 다른 출처의 JSON POST
    assert.equal((await raw({ 'Content-Type': 'application/json', Origin: 'http://evil.example' }, `{"workId":"${WORK_ID}"}`)).status, 403);
    assert.equal((await raw({ 'Content-Type': 'application/json', Origin: 'null' }, `{"workId":"${WORK_ID}"}`)).status, 403);
    assert.equal((await raw({ 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' }, `{"workId":"${WORK_ID}"}`)).status, 403);
    // 자기 출처는 통과
    const ok = await raw({ 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin' }, `{"workId":"${WORK_ID}"}`);
    assert.equal(ok.status, 201);
    // DNS rebinding: Host가 우리 주소가 아니면 읽기도 거부 (fetch는 Host를 못 바꾸므로 http.request 사용)
    const withHost = (host) => new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/api/chats', headers: { Host: host } }, (r) => { r.resume(); resolve(r.statusCode); }).on('error', reject);
    });
    assert.equal(await withHost('attacker.example'), 403);
    assert.equal(await withHost(`attacker.example:${port}`), 403);
    assert.equal(await withHost(`localhost:${port}`), 200);
    assert.equal(await withHost(`127.0.0.1:${port}`), 200);
    // 파일이 실제로 늘지 않았는지
    const list = await call(base, 'GET', '/api/chats');
    assert.equal(list.json.chats.length, 1);
  } finally { await close(server); }
});

test('깨진 작품 파일이 있어도 /api/works는 200이고 해당 항목만 unreadable', async () => {
  const dataDir = tempDataDir();
  fs.writeFileSync(path.join(dataDir, 'works', 'zz-broken.json'), '{}');
  const { server, base } = await listen(dataDir);
  try {
    const works = await call(base, 'GET', '/api/works');
    assert.equal(works.status, 200);
    assert.equal(works.json.works.length, 2);
    assert.equal(works.json.works[1].unreadable, true);
    assert.equal((await call(base, 'GET', '/api/works/zz-broken')).status, 422);
  } finally { await close(server); }
});

test('POST /api/chats/:id/branch 는 복제된 새 채팅을 201로 돌려주고 출처는 바꾸지 않는다', async () => {
  const { server, base } = await listen(tempDataDir());
  try {
    const created = await call(base, 'POST', '/api/chats', { workId: WORK_ID });
    const id = created.json.chat.id;
    const sent = await call(base, 'POST', `/api/chats/${id}/turns`, { text: '첫 말' });
    const userTurn = sent.json.chat.turns[0];
    const br = await call(base, 'POST', `/api/chats/${id}/branch`, { turnId: userTurn.id });
    assert.equal(br.status, 201);
    assert.equal(br.json.chat.branchOf.chatId, id);
    assert.equal(br.json.chat.turns.length, 1);
    assert.equal(br.json.chat.pending, true);
    assert.equal((await call(base, 'GET', `/api/chats/${id}`)).json.chat.turns.length, 2);
    assert.equal((await call(base, 'POST', `/api/chats/${id}/branch`, { turnId: 'ghost' })).status, 404);
    assert.equal((await call(base, 'POST', `/api/chats/${id}/branch`, {})).status, 400);
    assert.equal((await call(base, 'POST', `/api/chats/ghost/branch`, { turnId: 'x' })).status, 404);
  } finally { await close(server); }
});

test('PATCH /api/chats/:id 로 이름·보관을 바꾸고 잘못된 입력은 400', async () => {
  const { server, base } = await listen(tempDataDir());
  try {
    const created = await call(base, 'POST', '/api/chats', { workId: WORK_ID });
    const id = created.json.chat.id;
    const renamed = await fetch(`${base}/api/chats/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '새 이름' }) });
    assert.equal(renamed.status, 200);
    assert.equal((await renamed.json()).chat.name, '새 이름');
    const archived = await fetch(`${base}/api/chats/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ archived: true }) });
    assert.equal((await archived.json()).chat.archived, true);
    const bad = await fetch(`${base}/api/chats/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '' }) });
    assert.equal(bad.status, 400);
    const plain = await fetch(`${base}/api/chats/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'text/plain' }, body: '{"name":"x"}' });
    assert.equal(plain.status, 415); // 변경 요청 가드는 PATCH에도 적용
  } finally { await close(server); }
});

test('GET export 는 저장 파일 그대로, POST import 는 검증 실패 시 422와 details', async () => {
  const { server, base } = await listen(tempDataDir());
  try {
    const created = await call(base, 'POST', '/api/chats', { workId: WORK_ID });
    const id = created.json.chat.id;
    await call(base, 'POST', `/api/chats/${id}/turns`, { text: '한 마디' });
    const res = await fetch(`${base}/api/chats/${id}/export`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition'), /attachment; filename="chat-.*\.jsonl"; filename\*=UTF-8''/);
    const raw = await res.text();
    assert.equal(raw.split('\n').filter(Boolean).length, 3);
    const ok = await call(base, 'POST', '/api/chats/import', { jsonl: raw });
    assert.equal(ok.status, 201);
    assert.equal(ok.json.chat.importedFrom.originalId, id);
    const bad = await call(base, 'POST', '/api/chats/import', { jsonl: 'not json\n' });
    assert.equal(bad.status, 422);
    assert.equal(bad.json.error.code, 'BAD_IMPORT');
    assert.ok(bad.json.error.details.length >= 1);
    assert.equal(bad.json.error.details[0].line, 1);
    const big = await call(base, 'POST', '/api/chats/import', { jsonl: 'x'.repeat(5 * 1024 * 1024 + 10) });
    assert.equal(big.status, 413);
    assert.equal((await call(base, 'GET', '/api/chats/ghost/export')).status, 404);
  } finally { await close(server); }
});

test('POST /api/chats/:id/cancel: 진행 중이 아니면 cancelled=false, meta에 canCancel', async () => {
  const { server, base } = await listen(tempDataDir());
  try {
    const meta = await call(base, 'GET', '/api/meta');
    assert.equal(meta.json.canCancel, false); // 기록 응답기는 취소 대상이 없다
    const created = await call(base, 'POST', '/api/chats', { workId: WORK_ID });
    const r = await call(base, 'POST', `/api/chats/${created.json.chat.id}/cancel`, {});
    assert.equal(r.status, 200);
    assert.equal(r.json.chat.cancelled, false);
    assert.equal((await call(base, 'POST', '/api/chats/ghost/cancel', {})).status, 404);
  } finally { await close(server); }
});

test('POST /api/chats/:id/marks: 200/404/400/409', async () => {
  const { server, base } = await listen(tempDataDir());
  try {
    const created = await call(base, 'POST', '/api/chats', { workId: WORK_ID });
    const id = created.json.chat.id;
    const sent = await call(base, 'POST', `/api/chats/${id}/turns`, { text: '표시할 말' });
    const turnId = sent.json.chat.turns[0].id;
    const ok = await call(base, 'POST', `/api/chats/${id}/marks`, { turnId, marked: true });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json.chat.marks.map((m) => m.turnId), [turnId]);
    assert.equal((await call(base, 'POST', `/api/chats/${id}/marks`, { turnId: 'ghost', marked: true })).status, 404);
    assert.equal((await call(base, 'POST', `/api/chats/${id}/marks`, { turnId, marked: 'yes' })).status, 400);
    assert.equal((await call(base, 'POST', `/api/chats/ghost/marks`, { turnId, marked: true })).status, 404);
    await fetch(`${base}/api/chats/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ archived: true }) });
    assert.equal((await call(base, 'POST', `/api/chats/${id}/marks`, { turnId, marked: false })).status, 409);
  } finally { await close(server); }
});

test('POST /api/chats {startId}: 지정 시작으로 만들고, 없는 시작은 400, 작품 목록에 시작 수·이름', async () => {
  const { server, base } = await listen(tempDataDir());
  try {
    const works = await call(base, 'GET', '/api/works');
    assert.equal(works.json.works[0].startCount, 3);
    assert.equal(works.json.works[0].starts[1].name, '폭풍 다음 날 아침');
    const ok = await call(base, 'POST', '/api/chats', { workId: WORK_ID, startId: 'first-solo-night' });
    assert.equal(ok.status, 201);
    assert.equal(ok.json.chat.startId, 'first-solo-night');
    assert.equal((await call(base, 'POST', '/api/chats', { workId: WORK_ID, startId: 'nope' })).status, 400);
    assert.equal((await call(base, 'POST', '/api/chats', { workId: WORK_ID })).json.chat.startId, 'first-night');
  } finally { await close(server); }
});

test('끝난 이야기에 보내면 409 ENDED', async () => {
  const { server, base } = await listen(tempDataDir());
  try {
    const created = await call(base, 'POST', '/api/chats', { workId: WORK_ID, startId: 'first-solo-night' });
    const id = created.json.chat.id;
    for (let i = 0; i < 6; i += 1) await call(base, 'POST', `/api/chats/${id}/turns`, { text: `말 ${i}` });
    const ended = await call(base, 'GET', `/api/chats/${id}`);
    assert.equal(ended.json.chat.ended, true);
    assert.equal(ended.json.chat.endingName, '혼자 지킨 밤');
    const blocked = await call(base, 'POST', `/api/chats/${id}/turns`, { text: '더' });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.json.error.code, 'ENDED');
  } finally { await close(server); }
});
