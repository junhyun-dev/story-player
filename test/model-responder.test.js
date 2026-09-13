'use strict';
// 실제 모델 없이 검사하는 모델 응답기: 가짜 OpenAI 호환 서버(fixture)로 문맥 조립·실패·시간 초과·취소·재시도를 확인한다.
// 여기서 통과해도 실제 Qwen3-4B의 대화 품질·지연은 증명되지 않는다.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Store } = require('../lib/store');
const { ChatService } = require('../lib/chat-service');
const { ModelResponder, stripThink } = require('../lib/model-responder');
const { tempDataDir, WORK_ID } = require('./helpers');

// 가짜 llama-server: 요청 본문을 기록하고 behavior에 따라 응답한다.
function fakeModelServer(behavior = {}, options = {}) {
  const requests = [];
  const tokenizeCalls = [];
  const charsPerToken = options.charsPerToken || 2; // 가짜 토크나이저: 글자 수 / 2
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url === '/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"status":"ok"}'); }
      const parsed = JSON.parse(body);
      if (req.url === '/tokenize') {
        tokenizeCalls.push(parsed);
        if (options.noTokenize) { res.writeHead(404); return res.end('not found'); }
        if (options.tokenizeHang) return; // 사전 확인 단계가 멎는 서버 대기열 재현(응답하지 않음)
        const n = Math.ceil(String(parsed.content || '').length / charsPerToken);
        const answer = () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ tokens: Array.from({ length: n }, (_, i) => i) })); };
        if (options.tokenizeDelayMs) setTimeout(answer, options.tokenizeDelayMs); else answer();
        return;
      }
      requests.push({ url: req.url, body: parsed });
      const b = typeof behavior === 'function' ? behavior(parsed, requests.length) : behavior;
      const send = () => {
        if (b.status && b.status !== 200) { res.writeHead(b.status, { 'Content-Type': 'text/plain' }); return res.end(b.text || 'error'); }
        if (b.raw !== undefined) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(b.raw); }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ model: 'qwen3-4b', truncated: Boolean(b.truncated), choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: b.content === undefined ? '해원이 램프를 든다.' : b.content } }], usage: { prompt_tokens: b.promptTokens || 100, completion_tokens: 20 } }));
      };
      if (b.delayMs) setTimeout(send, b.delayMs); else send();
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    server, requests, tokenizeCalls, base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  })));
}

function setup(base, extra = {}) {
  const dir = tempDataDir();
  const responder = new ModelResponder({ baseUrl: base, model: 'qwen3-4b', timeoutMs: 2000, ...extra });
  return { dir, responder, service: new ChatService(new Store(dir), responder) };
}

test('성공: 시스템+경로 턴을 보내고 응답을 모델 턴으로 저장한다(ctx·model 기록, thinking 끔)', async () => {
  const fake = await fakeModelServer({ content: '<think>속으로</think>…이름은 됐다. 손이 먼저다.' });
  try {
    const { service } = setup(fake.base);
    const chat = service.createChat(WORK_ID);
    const r = await service.send(chat.id, { text: '이름은 진이에요' });
    assert.equal(r.replied, true);
    const bot = r.turns[1];
    assert.equal(bot.responder, 'model');
    assert.equal(bot.model, 'qwen3-4b');
    assert.equal(bot.text, '…이름은 됐다. 손이 먼저다.'); // <think>는 사용자에게 보이지 않는다
    assert.equal(bot.scriptIndex, null);
    assert.deepEqual(bot.ctx.includedTurns, 1);
    assert.equal(bot.ctx.firstTurnId, r.turns[0].id);
    assert.equal(r.responderLabel, '모델 응답(qwen3-4b)');
    const req = fake.requests[0].body;
    assert.equal(req.model, 'qwen3-4b');
    assert.equal(req.stream, false);
    assert.equal(req.max_tokens, 320);
    assert.deepEqual(req.chat_template_kwargs, { enable_thinking: false });
    assert.equal(req.messages[0].role, 'system');
    assert.match(req.messages[0].content, /해원/);
    assert.match(req.messages[0].content, /폭풍이 몰려오는 저녁/); // 시작 장면이 설정으로 들어간다
    assert.deepEqual(req.messages.slice(1), [{ role: 'user', content: '이름은 진이에요' }]);
  } finally { await fake.close(); }
});

test('분기 경로 문맥: 분기 채팅의 요청에는 출처의 분기점 이후 턴이 절대 들어가지 않는다(부재 테스트)', async () => {
  const fake = await fakeModelServer((body, n) => ({ content: `응답 ${n}` }));
  try {
    const { service } = setup(fake.base);
    const chat = service.createChat(WORK_ID);
    await service.send(chat.id, { text: '첫째 말' });
    await service.send(chat.id, { text: '둘째 말 — 열쇠 약속' });
    const src = service.getChat(chat.id); // user1, bot1, user2, bot2
    const br = service.branch(chat.id, src.turns[1].id); // bot1까지 복제
    await service.send(br.id, { text: '갈라진 길의 말' });
    const req = fake.requests[fake.requests.length - 1].body;
    const texts = req.messages.map((m) => m.content).join('\n');
    assert.match(texts, /첫째 말/);
    assert.match(texts, /갈라진 길의 말/);
    assert.doesNotMatch(texts, /둘째 말/); // 출처의 분기점 이후 사용자 턴
    assert.doesNotMatch(texts, /응답 2/); // 출처의 분기점 이후 캐릭터 턴
    assert.deepEqual(req.messages.slice(1).map((m) => m.role), ['user', 'assistant', 'user']);
    // 출처 채팅에 이어 보내면 분기의 말은 들어가지 않는다
    await service.send(chat.id, { text: '출처에서 계속' });
    const req2 = fake.requests[fake.requests.length - 1].body;
    assert.doesNotMatch(req2.messages.map((m) => m.content).join('\n'), /갈라진 길의 말/);
  } finally { await fake.close(); }
});

test('문맥 예산: 최근 N턴·문자 상한만 넣고 생략 수를 ctx에 남긴다. 마지막 사용자 턴은 항상 포함', async () => {
  const fake = await fakeModelServer({ content: '짧은 답' });
  try {
    const { service } = setup(fake.base, { maxTurns: 4, maxHistoryChars: 60 });
    const chat = service.createChat(WORK_ID);
    for (let i = 1; i <= 5; i += 1) await service.send(chat.id, { text: `${i}번째 말은 스무 글자쯤 되는 문장입니다.` });
    const last = service.getChat(chat.id).turns.at(-1);
    assert.equal(last.ctx.includedTurns <= 4, true);
    assert.equal(last.ctx.droppedTurns >= 5, true);
    const req = fake.requests[fake.requests.length - 1].body;
    assert.equal(req.messages.at(-1).content, '5번째 말은 스무 글자쯤 되는 문장입니다.');
    assert.ok(req.messages.slice(1).reduce((n, m) => n + m.content.length, 0) <= 60 + 40); // 마지막 턴은 상한을 넘어도 포함
    // 아주 긴 마지막 말 하나만 있어도 보낸다
    const long = 'ㄱ'.repeat(500);
    const r = await service.send(chat.id, { text: long });
    assert.equal(r.replied, true);
    assert.equal(fake.requests.at(-1).body.messages.at(-1).content, long);
    assert.equal(fake.requests.at(-1).body.messages.length, 2); // system + 마지막 사용자 턴만
  } finally { await fake.close(); }
});

test('실패 갈래: 연결 불가·시간 초과·HTTP 오류·깨진 JSON·빈 응답은 모두 pending으로 남고 사용자 턴은 저장된다', async () => {
  // 연결 불가(닫힌 포트)
  const closed = await fakeModelServer({});
  const closedBase = closed.base;
  await closed.close();
  {
    const { service } = setup(closedBase, { timeoutMs: 1000 });
    const chat = service.createChat(WORK_ID);
    const r = await service.send(chat.id, { text: '아무 말' });
    assert.equal(r.replied, false);
    assert.equal(r.pending, true);
    assert.match(r.replyError, /연결할 수 없습니다/);
    assert.equal(r.turns.length, 1);
  }
  // 시간 초과
  const slow = await fakeModelServer({ delayMs: 1500, content: '늦은 답' });
  try {
    const { service } = setup(slow.base, { timeoutMs: 300 });
    const chat = service.createChat(WORK_ID);
    const r = await service.send(chat.id, { text: '느린 서버' });
    assert.equal(r.replied, false);
    assert.match(r.replyError, /초 안에 답하지 않았습니다/);
    assert.equal(service.getChat(chat.id).inflight, false);
  } finally { await slow.close(); }
  // HTTP 500 / 깨진 JSON / 빈 응답
  for (const [behavior, pattern] of [
    [{ status: 500, text: 'slot busy' }, /HTTP 500.*slot busy/],
    [{ raw: '{not json' }, /JSON으로 읽을 수 없습니다/],
    [{ content: '' }, /빈 응답/],
    [{ content: '<think>생각만 하고 끝</think>' }, /빈 응답/],
  ]) {
    const fake = await fakeModelServer(behavior);
    try {
      const { service } = setup(fake.base);
      const chat = service.createChat(WORK_ID);
      const r = await service.send(chat.id, { text: '테스트' });
      assert.equal(r.replied, false, JSON.stringify(behavior));
      assert.match(r.replyError, pattern);
      assert.equal(r.turns.length, 1);
    } finally { await fake.close(); }
  }
});

test('재시도: 서버가 돌아오면 다시 생성이 응답을 한 번만 추가한다', async () => {
  let fail = true;
  const fake = await fakeModelServer(() => (fail ? { status: 503, text: 'Loading model' } : { content: '이제 답한다' }));
  try {
    const { service } = setup(fake.base);
    const chat = service.createChat(WORK_ID);
    const r1 = await service.send(chat.id, { text: '아직 안 켜졌을 때' });
    assert.equal(r1.replied, false);
    assert.match(r1.replyError, /HTTP 503/);
    fail = false;
    const r2 = await service.retry(chat.id);
    assert.equal(r2.replied, true);
    assert.deepEqual(r2.turns.map((t) => t.role), ['user', 'assistant']);
    assert.equal(r2.turns[1].text, '이제 답한다');
    assert.equal(fake.requests.length, 2);
  } finally { await fake.close(); }
});

test('취소: 진행 중 요청을 abortAll 하면 취소 실패로 남고, 다시 생성이 이어진다', async () => {
  const fake = await fakeModelServer({ delayMs: 1500, content: '취소 뒤 답' });
  try {
    const { service, responder } = setup(fake.base, { timeoutMs: 5000 });
    const chat = service.createChat(WORK_ID);
    const p = service.send(chat.id, { text: '취소될 요청' });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(service.getChat(chat.id).inflight, true);
    service.abortAll('SIGTERM'); // 서버 종료 흐름과 같다
    const r = await p;
    assert.equal(r.replied, false);
    assert.match(r.replyError, /취소됐습니다/);
    assert.equal(r.pending, true);
    assert.equal(responder.inflight.size, 0);
    const r2 = await service.retry(chat.id);
    assert.equal(r2.replied, true);
    assert.deepEqual(r2.turns.map((t) => t.role), ['user', 'assistant']);
  } finally { await fake.close(); }
});

test('health: 200 ok 면 준비됨, 닫힌 포트면 ok=false', async () => {
  const fake = await fakeModelServer({});
  const responder = new ModelResponder({ baseUrl: fake.base });
  assert.deepEqual(await responder.health(), { ok: true, status: 200 });
  const base = fake.base;
  await fake.close();
  const down = await new ModelResponder({ baseUrl: base }).health();
  assert.equal(down.ok, false);
  assert.equal(stripThink('<think>a</think>  본문'), '본문');
});

test('토큰 사전 확인: /tokenize 로 예산을 넘으면 히스토리를 줄여서 보내고, /tokenize 가 없으면 생략한다', async () => {
  // 문맥 400·응답 예약 100 → 프롬프트 예산 300토큰(가짜 토크나이저 2자/토큰 → 약 600자)
  const fake = await fakeModelServer({ content: '줄인 답' });
  try {
    const { service } = setup(fake.base, { ctxSize: 400, maxTokens: 100, maxTurns: 12, maxHistoryChars: 3600 });
    const chat = service.createChat(WORK_ID);
    for (let i = 1; i <= 6; i += 1) await service.send(chat.id, { text: `${i}번째 말입니다. `.repeat(10) }); // 턴마다 약 110자
    const last = service.getChat(chat.id).turns.at(-1);
    assert.ok(last.ctx.shrinkSteps >= 1, JSON.stringify(last.ctx));
    assert.ok(last.ctx.promptTokensEstimate <= 300, JSON.stringify(last.ctx));
    assert.ok(last.ctx.includedTurns < 11);
    assert.ok(fake.tokenizeCalls.length >= 2);
    const req = fake.requests.at(-1).body;
    assert.equal(req.messages.at(-1).content.startsWith('6번째 말입니다.'), true); // 마지막 사용자 턴은 항상 포함
  } finally { await fake.close(); }
  const noTok = await fakeModelServer({ content: '그냥 답' }, { noTokenize: true });
  try {
    const { service } = setup(noTok.base);
    const chat = service.createChat(WORK_ID);
    const r = await service.send(chat.id, { text: '사전 확인 없는 서버' });
    assert.equal(r.replied, true);
    assert.equal(r.turns[1].ctx.promptTokensEstimate, null); // 생략됐음을 남긴다
    assert.equal(r.turns[1].ctx.shrinkSteps, 0);
  } finally { await noTok.close(); }
});

test('문맥 초과 400: 서버가 exceed_context_size_error 를 돌려주면 예산을 줄여 한 번 재시도하고, 그래도 넘으면 사용자 문장으로 실패한다', async () => {
  const exceed = { status: 400, text: JSON.stringify({ error: { code: 400, message: 'the request exceeds the available context size', type: 'exceed_context_size_error', n_prompt_tokens: 4200, n_ctx: 4096 } }) };
  let calls = 0;
  const once = await fakeModelServer(() => { calls += 1; return calls === 2 ? exceed : { content: '줄여서 성공' }; }, { noTokenize: true });
  try {
    const { service } = setup(once.base);
    const chat = service.createChat(WORK_ID);
    await service.send(chat.id, { text: '첫 말' }); // 호출 1: 성공
    const r = await service.send(chat.id, { text: '둘째 말' }); // 호출 2: 초과 → 호출 3: 줄여서 성공
    assert.equal(r.replied, true);
    assert.equal(r.turns.at(-1).text, '줄여서 성공');
    assert.equal(r.turns.at(-1).ctx.retriedAfterContextError, true);
    assert.equal(r.turns.at(-1).ctx.shrinkSteps, 1);
    assert.equal(once.requests.length, 3); // 첫 send 1 + 둘째 send 2(초과→재시도)
    assert.ok(once.requests[2].body.messages.length <= once.requests[1].body.messages.length);
  } finally { await once.close(); }
  const always = await fakeModelServer(exceed, { noTokenize: true });
  try {
    const { service } = setup(always.base);
    const chat = service.createChat(WORK_ID);
    const r = await service.send(chat.id, { text: '한 턴인데도 넘침' });
    assert.equal(r.replied, false);
    assert.match(r.replyError, /문맥 한도를 넘었습니다\(4200\/4096 토큰\)/);
    assert.equal(r.pending, true);
    assert.equal(always.requests.length, 1); // 턴이 하나뿐이면 줄일 것이 없어 재시도하지 않는다
  } finally { await always.close(); }
});

test('사전 확인 단계에서 멎어도 전체 타임아웃·취소가 적용되고 inflight가 남지 않는다(검토 반례 1)', async () => {
  const hang = await fakeModelServer({ content: '오지 않을 답' }, { tokenizeHang: true });
  try {
    const { service, responder } = setup(hang.base, { timeoutMs: 400 });
    const chat = service.createChat(WORK_ID);
    const r = await service.send(chat.id, { text: '대기열에 걸린 요청' });
    assert.equal(r.replied, false);
    assert.match(r.replyError, /초 안에 답하지 않았습니다/);
    assert.equal(service.getChat(chat.id).inflight, false);
    assert.equal(responder.inflight.size, 0);
    assert.equal(hang.requests.length, 0); // 완성 요청은 보내지도 않았다
    // 사용자 취소도 사전 확인 중에 먹는다
    const p = service.send(chat.id, { text: '취소할 요청' }).catch((e) => ({ error: e }));
    await new Promise((r2) => setTimeout(r2, 50));
    // 첫 요청은 pending이라 두 번째 send는 PENDING으로 거절된다 → retry로 재현
    const first = await p;
    assert.equal(first.error && first.error.code, 'PENDING');
    const p2 = service.retry(chat.id);
    await new Promise((r2) => setTimeout(r2, 50));
    assert.equal(service.getChat(chat.id).inflight, true);
    assert.equal(service.cancel(chat.id).cancelled, true);
    const r2 = await p2;
    assert.equal(r2.replied, false);
    assert.match(r2.replyError, /취소됐습니다/);
    assert.equal(responder.inflight.size, 0);
  } finally { await hang.close(); }
});

test('줄일 히스토리가 없는데 예산을 넘으면 보내지 않고 사용자 문장으로 실패한다(검토 반례 2·4: 시스템 상한 포함)', async () => {
  const fake = await fakeModelServer({ content: '오면 안 되는 답' });
  try {
    const { service, responder } = setup(fake.base, { ctxSize: 400, maxTokens: 100 }); // 예산 300토큰 = 약 600자
    // 긴 작품: 설정·시작 장면이 아주 길어도 시스템 메시지는 maxSystemChars 안으로 잘린다
    const { writeWork } = require('./helpers');
    writeWork(service.store.dataDir, 'long-work', { title: '긴 작품', character: { name: '갑', description: '설'.repeat(3000) }, opening: '장'.repeat(4000), script: [] });
    const sys = responder.buildSystem(service.getWork('long-work'));
    assert.ok(sys.length <= responder.opts.maxSystemChars, `system ${sys.length}`);
    assert.match(sys, /…/);
    const chat = service.createChat('long-work');
    const r = await service.send(chat.id, { text: '한 턴' });
    assert.equal(r.replied, false);
    assert.match(r.replyError, /문맥 예산을 넘습니다\(약 \d+\/300 토큰\)/);
    assert.equal(fake.requests.length, 0); // 전송 자체를 하지 않았다
    assert.equal(r.turns[0].text, '한 턴'); // 사용자 턴은 저장됨
  } finally { await fake.close(); }
});

test('응답이 truncated 면 잘린 문맥의 답을 저장하지 않고 축소 재시도하며, 그래도 잘리면 실패한다(검토 반례 2)', async () => {
  let calls = 0;
  const once = await fakeModelServer(() => { calls += 1; return calls === 2 ? { truncated: true, content: '앞을 잊은 답', promptTokens: 4000 } : { content: '줄여서 성공' }; }, { noTokenize: true });
  try {
    const { service } = setup(once.base);
    const chat = service.createChat(WORK_ID);
    await service.send(chat.id, { text: '첫 말' });
    const r = await service.send(chat.id, { text: '둘째 말' });
    assert.equal(r.replied, true);
    assert.equal(r.turns.at(-1).text, '줄여서 성공');
    assert.equal(r.turns.at(-1).ctx.retriedAfterContextError, true);
    assert.ok(!r.turns.some((t) => t.text === '앞을 잊은 답'));
  } finally { await once.close(); }
  const always = await fakeModelServer({ truncated: true, content: '잘린 답', promptTokens: 4100 }, { noTokenize: true });
  try {
    const { service } = setup(always.base);
    const chat = service.createChat(WORK_ID);
    const r = await service.send(chat.id, { text: '한 턴' });
    assert.equal(r.replied, false);
    assert.match(r.replyError, /문맥을 잘라 앞 이야기를 보지 못한 상태로 답했습니다\(4100\/4096 토큰\)/);
    assert.equal(r.turns.length, 1);
  } finally { await always.close(); }
});

test('사슬이 끊긴 파일은 마지막으로 이어진 구간만 문맥에 넣는다(검토 반례 3)', async () => {
  const fake = await fakeModelServer({ content: '답' });
  try {
    const { service } = setup(fake.base);
    const chat = service.createChat(WORK_ID);
    const st = service.store;
    st.appendTurn(chat.id, { id: 'a1', role: 'user', text: '원래 경로의 첫 말', createdAt: '2026-09-11T01:00:00.000Z', parentId: null });
    st.appendTurn(chat.id, { id: 'a2', role: 'assistant', text: '원래 경로의 답', createdAt: '2026-09-11T01:00:01.000Z', parentId: 'a1' });
    st.appendTurn(chat.id, { id: 'x9', role: 'user', text: '다른 경로에서 섞여 들어온 말', createdAt: '2026-09-11T01:00:02.000Z', parentId: 'zz' }); // 사슬 끊김
    st.appendTurn(chat.id, { id: 'x10', role: 'assistant', text: '섞인 경로의 답', createdAt: '2026-09-11T01:00:03.000Z', parentId: 'x9' });
    assert.deepEqual(service.getChat(chat.id).chainBreaks, ['x9']);
    const r = await service.send(chat.id, { text: '지금 이어 쓰는 말' });
    assert.equal(r.replied, true);
    const texts = fake.requests[0].body.messages.map((m) => m.content).join('\n');
    assert.doesNotMatch(texts, /원래 경로의 첫 말|원래 경로의 답/); // 끊긴 지점 앞은 제외
    assert.match(texts, /다른 경로에서 섞여 들어온 말/); // 끊긴 지점부터의 연속 구간은 현재 경로로 본다
    assert.match(texts, /지금 이어 쓰는 말/);
    assert.equal(r.turns.at(-1).ctx.chainBreakCut, 2);
  } finally { await fake.close(); }
});

test('환경변수가 비어 undefined 로 넘어온 옵션은 기본값을 덮어쓰지 않는다(실제 실행에서 발견한 결함)', async () => {
  const r = new ModelResponder({ baseUrl: undefined, model: undefined, timeoutMs: undefined, maxTurns: undefined, maxHistoryChars: undefined, ctxSize: undefined, precheck: undefined, label: undefined, fetch: undefined });
  assert.equal(r.opts.maxTurns, 12);
  assert.equal(r.opts.maxHistoryChars, 3000);
  assert.equal(r.opts.ctxSize, 4096);
  assert.equal(r.opts.precheck, true);
  assert.equal(r.opts.timeoutMs, 120000);
  assert.equal(r.opts.baseUrl, 'http://127.0.0.1:8081');
  assert.equal(r.label, '모델 응답(qwen3-4b)');
  const r2 = new ModelResponder({ maxTurns: Number('abc'), ctxSize: Number(undefined) }); // NaN도 기본값 유지
  assert.equal(r2.opts.maxTurns, 12);
  assert.equal(r2.opts.ctxSize, 4096);
  // 실제 서버가 돌려준 /tokenize 형태 {"tokens":[정수…]} 를 세는지
  const fake = await fakeModelServer({ content: '답' });
  try {
    const { service } = setup(fake.base);
    const chat = service.createChat(WORK_ID);
    const res = await service.send(chat.id, { text: '사전 확인이 실제로 도는지' });
    assert.ok(res.turns[1].ctx.promptTokensEstimate > 0);
    assert.equal(res.turns[1].ctx.budget.maxTurns, 12);
  } finally { await fake.close(); }
});

test('플레이 가이드·시작 추천 답변은 모델 프롬프트에 들어가지 않는다(사용자 전용)', async () => {
  const fake = await fakeModelServer({ content: '답' });
  try {
    const { service } = setup(fake.base);
    const work = service.getWork(WORK_ID);
    assert.ok(work.playGuide && work.suggestedReplies.length);
    const chat = service.createChat(WORK_ID);
    await service.send(chat.id, { text: '안녕' });
    const sent = fake.requests[0].body.messages.map((m) => m.content).join('\n');
    assert.doesNotMatch(sent, /플레이 가이드|해원에게는 전달되지 않습니다|램프실은 어디죠/);
    assert.doesNotMatch(sent, new RegExp(work.playGuide.slice(0, 20)));
  } finally { await fake.close(); }
});

test('모델 프롬프트의 시작 장면은 그 채팅의 시작 설정 것이고 다른 시작의 프롤로그·대본은 들어가지 않는다', async () => {
  const fake = await fakeModelServer({ content: '답' });
  try {
    const { service } = setup(fake.base);
    const chat = service.createChat(WORK_ID, 'first-solo-night');
    await service.send(chat.id, { text: '안개가 짙어요' });
    const sys = fake.requests[0].body.messages[0].content;
    assert.match(sys, /한 달이 지났다/);
    assert.doesNotMatch(sys, /폭풍이 몰려오는 저녁|폭풍이 지나간 아침/);
    assert.doesNotMatch(sys, /종을 세 번/); // 대본은 프롬프트에 넣지 않는다
  } finally { await fake.close(); }
});
