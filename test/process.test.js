'use strict';
// 실제 진입점(node server.js)을 자식 프로세스로 띄워 확인한다: 기동 로그의 주소, 강제 종료(SIGKILL) 뒤 저장 내구성, 포트 충돌 안내.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { tempDataDir, WORK_ID } = require('./helpers');

const SERVER = path.join(__dirname, '..', 'server.js');

function startProcess(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], { env: { ...process.env, PORT: '0', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`기동 로그 없음: ${out} ${err}`)); }, 8000);
    child.stdout.on('data', (d) => {
      out += d.toString();
      const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)\//);
      if (m) { clearTimeout(timer); resolve({ child, base: `http://127.0.0.1:${m[1]}`, out: () => out, err: () => err }); }
    });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('exit', (code) => { clearTimeout(timer); resolve({ child, exited: code, out: () => out, err: () => err }); });
  });
}
function waitExit(child) { return new Promise((r) => (child.exitCode !== null ? r(child.exitCode) : child.on('exit', r))); }
async function api(base, method, p, body) {
  const res = await fetch(base + p, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json() };
}
function turnsOnDisk(dataDir, chatId) {
  const raw = fs.readFileSync(path.join(dataDir, 'chats', `${chatId}.jsonl`), 'utf8');
  return { raw, turns: raw.trim().split('\n').map((l) => JSON.parse(l)).filter((l) => l.type === 'turn') };
}

test('진입점: 실제 주소를 로그로 알리고 loopback에서 API가 응답한다', async () => {
  const dataDir = tempDataDir();
  const proc = await startProcess({ DATA_DIR: dataDir });
  try {
    assert.ok(proc.base, proc.err());
    const until = Date.now() + 2000; // 두 번째 로그 줄은 첫 줄과 다른 chunk로 올 수 있다
    while (Date.now() < until && !proc.out().includes('데이터:')) await new Promise((r) => setTimeout(r, 20));
    assert.match(proc.out(), /loopback\(127\.0\.0\.1\)/);
    assert.match(proc.out(), new RegExp(`데이터: ${dataDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    const meta = await api(proc.base, 'GET', '/api/meta');
    assert.equal(meta.json.responder, 'recorded');
    const works = await api(proc.base, 'GET', '/api/works');
    assert.equal(works.json.works[0].id, WORK_ID);
  } finally {
    proc.child.kill('SIGTERM');
    await waitExit(proc.child);
  }
});

test('강제 종료(SIGKILL) 내구성: 응답 생성 중 죽어도 저장된 사용자 턴은 온전하고, 재기동 뒤 다시 생성이 이어진다', async () => {
  const dataDir = tempDataDir();
  const first = await startProcess({ DATA_DIR: dataDir, RESPONDER_DELAY_MS: '3000' });
  let chatId;
  try {
    const created = await api(first.base, 'POST', '/api/chats', { workId: WORK_ID });
    chatId = created.json.chat.id;
    // 응답을 3초 기다리는 요청을 보내 두고, 사용자 턴이 디스크에 닿은 뒤 프로세스를 즉시 죽인다
    const inflight = fetch(`${first.base}/api/chats/${chatId}/turns`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '죽기 직전에 보낸 말', clientTurnId: 'kill-1' }),
    }).catch(() => null);
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && turnsOnDisk(dataDir, chatId).turns.length < 1) await new Promise((r) => setTimeout(r, 20));
    assert.equal(turnsOnDisk(dataDir, chatId).turns.length, 1);
    first.child.kill('SIGKILL');
    await waitExit(first.child);
    await inflight;
  } finally {
    if (first.child.exitCode === null) first.child.kill('SIGKILL');
  }
  const { raw, turns } = turnsOnDisk(dataDir, chatId);
  assert.ok(raw.endsWith('\n'), '마지막 줄이 줄바꿈으로 끝나야 한다(반쪽 줄 없음)');
  assert.deepEqual(turns.map((t) => t.role), ['user']);
  assert.equal(turns[0].text, '죽기 직전에 보낸 말');

  const second = await startProcess({ DATA_DIR: dataDir });
  try {
    const reopened = await api(second.base, 'GET', `/api/chats/${chatId}`);
    assert.equal(reopened.json.chat.pending, true); // 응답은 프로세스와 함께 사라졌고 사용자 턴만 남았다
    assert.equal(reopened.json.chat.inflight, false); // 새 프로세스는 '만드는 중'이라고 거짓말하지 않는다
    assert.deepEqual(reopened.json.chat.damagedLines, []);
    const dup = await api(second.base, 'POST', `/api/chats/${chatId}/turns`, { text: '죽기 직전에 보낸 말', clientTurnId: 'kill-1' });
    assert.equal(dup.json.chat.duplicate, true); // 같은 id 재전송은 중복 저장하지 않는다
    const retried = await api(second.base, 'POST', `/api/chats/${chatId}/retry`, {});
    assert.equal(retried.json.chat.replied, true);
    assert.deepEqual(turnsOnDisk(dataDir, chatId).turns.map((t) => t.role), ['user', 'assistant']);
  } finally {
    second.child.kill('SIGTERM');
    await waitExit(second.child);
  }
});

test('포트 충돌: 같은 포트로 두 번 띄우면 두 번째는 안내 후 종료한다', async () => {
  const dataDir = tempDataDir();
  const first = await startProcess({ DATA_DIR: dataDir });
  try {
    const port = new URL(first.base).port;
    const second = await startProcess({ DATA_DIR: dataDir, PORT: port });
    assert.equal(second.exited, 1);
    assert.match(second.err(), /이미 다른 서버가 있습니다/);
  } finally {
    first.child.kill('SIGTERM');
    await waitExit(first.child);
  }
});

test('RESPONDER=model 배선: meta에 모델 설정이 보이고, 가짜 모델 서버로 응답이 저장되며, 진행 중 SIGTERM은 요청을 취소하고 사용자 턴만 남긴다', async () => {
  const http = require('node:http');
  // 가짜 OpenAI 호환 서버: 첫 요청은 즉시, 둘째 요청은 오래 걸린다
  let calls = 0;
  const fake = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url === '/tokenize') { res.writeHead(404); return res.end('no tokenize'); } // 사전 확인은 생략되게 한다
      calls += 1;
      const reply = () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ model: 'qwen3-4b', choices: [{ message: { role: 'assistant', content: `모델 답 ${calls}` }, finish_reason: 'stop' }] })); };
      if (calls === 1) reply(); else setTimeout(reply, 5000);
    });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const modelBase = `http://127.0.0.1:${fake.address().port}`;
  const dataDir = tempDataDir();
  const proc = await startProcess({ DATA_DIR: dataDir, RESPONDER: 'model', MODEL_BASE_URL: modelBase, MODEL_NAME: 'qwen3-4b', MODEL_TIMEOUT_MS: '20000' });
  let chatId;
  try {
    const meta = await api(proc.base, 'GET', '/api/meta');
    assert.equal(meta.json.responder, 'model');
    assert.equal(meta.json.model.baseUrl, modelBase);
    assert.equal(meta.json.model.maxTokens, 320);
    assert.match(meta.json.responderLabel, /모델 응답\(qwen3-4b\)/);
    const created = await api(proc.base, 'POST', '/api/chats', { workId: WORK_ID });
    chatId = created.json.chat.id;
    const first = await api(proc.base, 'POST', `/api/chats/${chatId}/turns`, { text: '첫 말' });
    assert.equal(first.json.chat.replied, true);
    assert.equal(first.json.chat.turns[1].responder, 'model');
    assert.equal(first.json.chat.turns[1].text, '모델 답 1');
    // 둘째 요청은 느리다 → 진행 중에 SIGTERM
    const inflight = fetch(`${proc.base}/api/chats/${chatId}/turns`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '느린 둘째 말' }) }).catch(() => null);
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && turnsOnDisk(dataDir, chatId).turns.length < 3) await new Promise((r) => setTimeout(r, 20));
    assert.equal(turnsOnDisk(dataDir, chatId).turns.length, 3);
    proc.child.kill('SIGTERM');
    const code = await waitExit(proc.child);
    assert.equal(code, 0); // 정상 종료(요청 취소 후 close)
    await inflight;
  } finally {
    if (proc.child.exitCode === null) proc.child.kill('SIGKILL');
    await new Promise((r) => { fake.closeAllConnections?.(); fake.close(() => r()); });
  }
  const { raw, turns } = turnsOnDisk(dataDir, chatId);
  assert.ok(raw.endsWith('\n'));
  assert.deepEqual(turns.map((t) => t.role), ['user', 'assistant', 'user']); // 취소된 요청의 응답은 저장되지 않았다
  assert.equal(turns[2].text, '느린 둘째 말');
});
