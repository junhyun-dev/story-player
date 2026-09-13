'use strict';
// 가져오기 검증(lib/import.js) 단위 테스트. 파일·서버를 쓰지 않는 순수 함수 검사다.
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateChatImport, MAX_IMPORT_BYTES, MAX_IMPORT_RECORDS, MAX_TURN_TEXT } = require('../lib/import');

const WORK = 'lighthouse-apprentice';
const META = {
  type: 'meta', id: 'chat-20260911000000-aaaaaa', workId: WORK,
  title: '등대의 견습생', character: '해원', createdAt: '2026-09-11T00:00:00.000Z',
};
const pad = (n) => String(n).padStart(2, '0');
function turn(n, role, parentId, extra = {}) {
  return {
    type: 'turn', id: `t${n}`, role, text: `${role === 'user' ? '내 말' : '해원의 말'} ${n}`,
    createdAt: `2026-09-11T00:${pad(n)}:00.000Z`, parentId, ...extra,
  };
}
const UPDATE = { type: 'meta-update', at: '2026-09-11T01:00:00.000Z', name: '첫 밤' };

const jsonl = (...recs) => recs.map((r) => JSON.stringify(r)).join('\n');
const yes = () => true;
const V = (text, opts = { workExists: yes }) => validateChatImport(text, opts);
// 오류를 '줄번호:메시지'로 펼쳐 부분 문자열로 확인한다.
const flat = (res) => res.errors.map((e) => `${e.line}:${e.message}`);
function hasError(res, line, needle) {
  return res.errors.some((e) => e.line === line && e.message.includes(needle));
}
// 위반 하나를 넣은 입력이 그 줄에서 그 이유로 걸리는지 확인한다.
function expectOne(text, line, needle, opts) {
  const res = opts ? V(text, opts) : V(text);
  assert.equal(res.ok, false, `통과해서는 안 되는 입력이 통과했다: ${needle}`);
  assert.equal(res.meta, null);
  assert.equal(res.turns, null);
  assert.ok(hasError(res, line, needle), `${line}번째 줄 '${needle}' 오류가 없다: ${flat(res).join(' | ')}`);
  return res;
}

test('정상 입력: meta + 턴 + meta-update, 마지막 줄바꿈이 있어도 없어도 통과한다', () => {
  const body = jsonl(META, turn(1, 'user', null), turn(2, 'assistant', 't1', { responder: 'recorded', scriptIndex: 0 }), UPDATE);
  for (const text of [body, `${body}\n`]) {
    const res = V(text);
    assert.deepEqual(res.errors, []);
    assert.equal(res.ok, true);
    assert.deepEqual(res.meta, META);
    assert.deepEqual(res.turns.map((t) => t.id), ['t1', 't2']);
    assert.deepEqual(res.updates, [UPDATE]);
    assert.deepEqual(res.marks, []); // mark가 없는 파일도 그대로 통과한다
    assert.deepEqual(res.stats, {
      turnCount: 2, userTurns: 1, assistantTurns: 1, markCount: 0, bytes: Buffer.byteLength(text, 'utf8'),
    });
  }
});

test('정상 입력: 분기 meta, 턴 없는 채팅, 같은 사용자 턴이 연속인 경우도 통과한다', () => {
  const branchMeta = {
    ...META,
    branchOf: { chatId: 'chat-20260910000000-bbbbbb', turnId: 't2', turnCount: 2, sourceDamagedLines: [3] },
    importedFrom: { file: 'chat-x.jsonl', at: '2026-09-11T02:00:00.000Z' },
  };
  const withBranch = V(jsonl(branchMeta, turn(1, 'user', null), turn(2, 'assistant', 't1')));
  assert.deepEqual(withBranch.errors, []);
  assert.equal(withBranch.meta.branchOf.turnCount, 2);

  const metaOnly = V(jsonl(META)); // 대화 전에 내보낸 채팅
  assert.equal(metaOnly.ok, true);
  assert.deepEqual(metaOnly.turns, []);
  assert.equal(metaOnly.stats.turnCount, 0);

  // role 교대는 요구하지 않는다: 응답 없이 사용자 말이 두 번 이어질 수 있다(pending 상태로 내보낸 채팅)
  const twoUsers = V(jsonl(META, turn(1, 'user', null), turn(2, 'user', 't1')));
  assert.deepEqual(twoUsers.errors, []);
  assert.deepEqual(twoUsers.stats, { turnCount: 2, userTurns: 2, assistantTurns: 0, markCount: 0, bytes: twoUsers.stats.bytes });
});

test('글자가 아닌 입력·빈 입력은 오류 1건이고 throw하지 않는다', () => {
  for (const bad of [null, undefined, 42, {}, [], true, Symbol('x'), () => {}]) {
    const res = V(bad);
    assert.equal(res.ok, false);
    assert.equal(res.errors.length, 1);
    assert.equal(res.errors[0].line, null);
    assert.match(res.errors[0].message, /읽지 못했습니다/);
    assert.deepEqual(res.stats, { turnCount: 0, userTurns: 0, assistantTurns: 0, markCount: 0, bytes: 0 });
    assert.equal(res.meta, null);
    assert.equal(res.turns, null);
    assert.deepEqual(res.updates, []);
    assert.deepEqual(res.marks, []);
  }
  for (const blank of ['', '   ', '\n', '\n\n  \n']) {
    const res = V(blank);
    assert.equal(res.ok, false);
    assert.equal(res.errors.length, 1);
    assert.match(res.errors[0].message, /비어 있습니다/);
    assert.equal(res.stats.bytes, Buffer.byteLength(blank, 'utf8'));
  }
});

test('줄 단위 형식 위반: JSON 아님, 객체 아님, 빈 줄', () => {
  expectOne(`${jsonl(META)}\n{"type":"turn"`, 2, 'JSON으로 읽을 수 없는');
  expectOne(`${jsonl(META)}\n[1,2]`, 2, 'JSON 객체');
  expectOne(`${jsonl(META)}\n42`, 2, 'JSON 객체');
  expectOne(`${jsonl(META)}\n\n${jsonl(turn(1, 'user', null))}`, 2, '빈 줄');
  // 마지막 줄바꿈은 하나만 허용한다: 두 번이면 빈 줄로 잡힌다
  expectOne(`${jsonl(META, turn(1, 'user', null))}\n\n`, 3, '빈 줄');
});

test('meta 규칙: 없음, 첫 줄 아님, 두 번, 작품 미설치', () => {
  const t1 = turn(1, 'user', null);
  const noMeta = V(jsonl(t1));
  assert.equal(noMeta.ok, false);
  assert.ok(hasError(noMeta, null, '채팅 정보(meta) 줄이 없습니다'));

  expectOne(jsonl(t1, META), 2, '첫 줄에 있어야');
  expectOne(jsonl(META, META), 2, '두 번 나옵니다');

  const missingWork = V(jsonl(META, t1), { workExists: () => false });
  assert.equal(missingWork.ok, false);
  assert.ok(hasError(missingWork, 1, `이 작품이 설치돼 있지 않습니다: ${WORK}`), flat(missingWork).join(' | '));
});

test('meta 필드 타입·형식 위반', () => {
  const bad = (patch) => jsonl({ ...META, ...patch }, turn(1, 'user', null));
  expectOne(bad({ id: 'chat 1' }), 1, '채팅 정보의 id');
  expectOne(bad({ id: 'x'.repeat(65) }), 1, '채팅 정보의 id');
  expectOne(bad({ workId: '../works' }), 1, '작품 id(workId)');
  expectOne(bad({ title: '' }), 1, '제목(title)');
  expectOne(bad({ title: 7 }), 1, '제목(title)');
  expectOne(bad({ character: null }), 1, '캐릭터 이름(character)');
  expectOne(bad({ createdAt: '2026-09-11' }), 1, '만든 시각(createdAt)');
  expectOne(bad({ createdAt: '어제' }), 1, '만든 시각(createdAt)');
  expectOne(bad({ importedFrom: 'chat-x.jsonl' }), 1, 'importedFrom');
  expectOne(bad({ branchOf: 'chat-x' }), 1, '분기 정보(branchOf)가 객체가 아닙니다');
  expectOne(bad({ branchOf: { chatId: 'a/b', turnId: 't1', turnCount: 1 } }), 1, '출처 채팅 id(chatId)');
  expectOne(bad({ branchOf: { chatId: 'c1', turnId: '', turnCount: 1 } }), 1, '출처 턴 id(turnId)');
  expectOne(bad({ branchOf: { chatId: 'c1', turnId: 't1', turnCount: 1.5 } }), 1, '복제 턴 수(turnCount)가 1 이상의 정수');
  expectOne(bad({ branchOf: { chatId: 'c1', turnId: 't1', turnCount: 0 } }), 1, '복제 턴 수(turnCount)가 1 이상의 정수');
  expectOne(bad({ branchOf: { chatId: 'c1', turnId: 't1', turnCount: 1, sourceDamagedLines: [0] } }), 1, 'sourceDamagedLines');
  expectOne(bad({ branchOf: { chatId: 'c1', turnId: 't1', turnCount: 1, sourceDamagedLines: 3 } }), 1, 'sourceDamagedLines');
  // 실제 턴 수보다 많은 복제 턴 수는 턴을 다 센 뒤에 meta 줄로 보고한다
  expectOne(jsonl({ ...META, branchOf: { chatId: 'c1', turnId: 't1', turnCount: 3 } }, turn(1, 'user', null)), 1, '이 파일의 턴 수(1)보다 많습니다');
});

test('턴 규칙: 사슬, id 중복, 역할, 연속 응답', () => {
  expectOne(jsonl(META, turn(1, 'user', 't0')), 2, '첫 턴의 parentId는 null');
  expectOne(jsonl(META, turn(1, 'user', null), turn(2, 'assistant', 't9')), 3, 'parentId가 바로 앞 턴의 id와 다릅니다');
  expectOne(jsonl(META, turn(1, 'user', null), { ...turn(2, 'assistant', 't1'), id: 't1' }), 3, '앞에서 이미 쓰였습니다');
  expectOne(jsonl(META, turn(1, 'assistant', null)), 2, '첫 턴은 사용자(user)의 말이어야');
  expectOne(jsonl(META, turn(1, 'user', null), turn(2, 'assistant', 't1'), turn(3, 'assistant', 't2')), 4, '캐릭터 응답이 두 번 이어집니다');
  expectOne(jsonl(META, turn(1, 'user', null), { ...turn(2, 'assistant', 't1'), parentId: 7 }), 3, 'parentId가 글자나 null이 아닙니다');
});

test('턴 필드 타입·길이 위반', () => {
  const bad = (patch) => jsonl(META, { ...turn(1, 'user', null), ...patch });
  expectOne(bad({ id: 'a b' }), 2, '턴 id가 올바르지 않습니다');
  expectOne(bad({ role: 'system' }), 2, '역할(role)은 user 또는 assistant');
  expectOne(bad({ role: undefined }), 2, '역할(role)은 user 또는 assistant');
  expectOne(bad({ text: '' }), 2, '내용(text)이 비어 있습니다');
  expectOne(bad({ text: 42 }), 2, '내용(text)이 글자가 아닙니다');
  expectOne(bad({ text: 'x'.repeat(MAX_TURN_TEXT + 1) }), 2, `${MAX_TURN_TEXT}자 이하`);
  expectOne(bad({ createdAt: '2026/09/11 09:00' }), 2, '시각(createdAt)');
  expectOne(bad({ clientTurnId: 'c 1' }), 2, 'clientTurnId');
  expectOne(bad({ responder: '' }), 2, 'responder');
  expectOne(bad({ scriptIndex: -1 }), 2, 'scriptIndex');
  expectOne(bad({ scriptIndex: '0' }), 2, 'scriptIndex');
  expectOne(bad({ scriptIndex: 1.5 }), 2, 'scriptIndex');
  // 20000자까지는 통과한다(경계)
  assert.equal(V(bad({ text: 'x'.repeat(MAX_TURN_TEXT) })).ok, true);
  // null·있어도 되는 값은 통과한다
  assert.equal(V(bad({ scriptIndex: null, clientTurnId: 'c-1', responder: 'recorded' })).ok, true);
});

test('meta-update 규칙', () => {
  const bad = (patch) => jsonl(META, turn(1, 'user', null), { ...UPDATE, ...patch });
  expectOne(bad({ at: 'today' }), 3, '시각(at)');
  expectOne(bad({ name: '' }), 3, '이름(name)은 1~80자');
  expectOne(bad({ name: '   ' }), 3, '이름(name)은 1~80자');
  expectOne(bad({ name: '가'.repeat(81) }), 3, '이름(name)은 1~80자');
  expectOne(bad({ name: 9 }), 3, '이름(name)은 1~80자');
  expectOne(bad({ archived: 'true' }), 3, 'archived');
  expectOne(jsonl(META, { type: 'meta-update', at: UPDATE.at }), 2, 'name도 archived도 없습니다');
  // 보관만 담은 기록, 이름 80자 경계는 통과한다
  assert.equal(V(bad({ name: undefined, archived: true })).ok, true);
  assert.equal(V(bad({ name: '가'.repeat(80) })).ok, true);
});

test('알 수 없는 레코드 종류는 거부한다', () => {
  expectOne(jsonl(META, { type: 'summary', text: '요약' }), 2, '알 수 없는 종류(type)입니다');
  expectOne(jsonl(META, { id: 't1', role: 'user' }), 2, '알 수 없는 종류(type)입니다');
  const res = V(jsonl(META, { type: 'TURN', id: 't1' }));
  assert.ok(hasError(res, 2, '"TURN"'), flat(res).join(' | ')); // 값을 문장에 넣어 보여준다
});

test('여러 위반을 줄 번호와 함께 모아서 돌려준다', () => {
  const text = jsonl(
    { ...META, title: '' },                                  // 1줄: 제목
    turn(1, 'assistant', 't0'),                              // 2줄: 첫 턴 역할 + parentId
    { ...turn(2, 'user', 't1'), text: '', createdAt: 'x' },   // 3줄: text + createdAt
    { type: 'meta-update', at: '2026-09-11T01:00:00.000Z', name: '가'.repeat(81) }, // 4줄: 이름
  );
  const res = V(text);
  assert.equal(res.ok, false);
  assert.ok(hasError(res, 1, '제목(title)'));
  assert.ok(hasError(res, 2, '첫 턴은 사용자(user)의 말이어야'));
  assert.ok(hasError(res, 2, '첫 턴의 parentId는 null'));
  assert.ok(hasError(res, 3, '내용(text)이 비어 있습니다'));
  assert.ok(hasError(res, 3, '시각(createdAt)'));
  assert.ok(hasError(res, 4, '이름(name)'));
  assert.ok(res.errors.length >= 6, flat(res).join(' | '));
  assert.deepEqual([...new Set(res.errors.map((e) => e.line))], [1, 2, 3, 4]);
  // 오류가 있어도 stats는 채워서 돌려준다
  assert.equal(res.stats.turnCount, 2);
  assert.equal(res.stats.bytes, Buffer.byteLength(text, 'utf8'));
});

test('오류는 20개까지만 모은다', () => {
  const broken = [];
  for (let i = 1; i <= 25; i++) broken.push({ type: 'turn', id: `t${i}`, role: 'nope', text: '', createdAt: 'x', parentId: null });
  const res = V(jsonl(META, ...broken));
  assert.equal(res.ok, false);
  assert.equal(res.errors.length, 20);
  assert.ok(res.errors.every((e) => typeof e.message === 'string' && e.message.length > 0));
});

test('크기·줄 수 상한을 넘으면 오류 1건으로 끝낸다', () => {
  const big = 'x'.repeat(MAX_IMPORT_BYTES + 1);
  const tooBig = V(big);
  assert.equal(tooBig.ok, false);
  assert.equal(tooBig.errors.length, 1);
  assert.equal(tooBig.errors[0].line, null);
  assert.match(tooBig.errors[0].message, /4MB 이하/);
  assert.equal(tooBig.stats.bytes, MAX_IMPORT_BYTES + 1);

  const lines = [JSON.stringify(META)];
  for (let i = 1; i <= MAX_IMPORT_RECORDS; i++) lines.push(JSON.stringify({ type: 'turn', id: `t${i}` }));
  const tooMany = V(lines.join('\n'));
  assert.equal(tooMany.errors.length, 1);
  assert.equal(tooMany.errors[0].line, null);
  assert.match(tooMany.errors[0].message, new RegExp(`${MAX_IMPORT_RECORDS}줄까지만`));
  // 상한 안(5000줄)이면 줄 단위 검사로 들어간다
  const atLimit = V(lines.slice(0, MAX_IMPORT_RECORDS).join('\n'));
  assert.ok(atLimit.errors.length > 1);
});

test('한글·이모지·따옴표·개행이 담긴 턴을 글자 수와 바이트 수로 구분해 센다', () => {
  const text = '해원은 말했다 "불이 꺼지면 누군가는 죽는다"\n…그리고 🕯️';
  const res = V(jsonl(META, { ...turn(1, 'user', null), text }));
  assert.equal(res.ok, true);
  assert.equal(res.turns[0].text, text);
  assert.ok(res.stats.bytes > text.length); // UTF-8 바이트는 글자 수보다 크다
});

test('workExists가 없거나 던져도 안전하다(옵션이 무엇이든 throw하지 않는다)', () => {
  const text = jsonl(META, turn(1, 'user', null));
  // 확인 함수를 주지 않으면 작품 설치 검사를 건너뛴다(계약에서 벗어난 점으로 보고함)
  for (const opts of [undefined, null, {}, 'x', 42, { workExists: 'yes' }]) {
    const res = validateChatImport(text, opts);
    assert.equal(res.ok, true, `옵션 ${String(opts)} 에서 실패했다: ${flat(res).join(' | ')}`);
  }
  const thrown = V(text, { workExists: () => { throw new Error('디스크 오류'); } });
  assert.equal(thrown.ok, false);
  assert.ok(hasError(thrown, 1, '확인하지 못했습니다'));
  // false 말고 다른 falsy를 돌려줘도 '설치돼 있지 않다'로 본다
  for (const falsy of [false, undefined, null, 0, '']) {
    const res = V(text, { workExists: () => falsy });
    assert.ok(hasError(res, 1, `이 작품이 설치돼 있지 않습니다: ${WORK}`));
  }
  // 검증 결과가 입력을 바꾸지 않는다(순수 함수)
  const before = jsonl(META, turn(1, 'user', null));
  V(before);
  assert.equal(before, jsonl(META, turn(1, 'user', null)));
});

// ---- 장면 표시(mark): "이 턴을 다시 읽을 장면으로 표시/해제"한 기록 ----
const mark = (turnId, marked, at = '2026-09-11T02:00:00.000Z') => ({ type: 'mark', at, turnId, marked });

test('장면 표시: 표시 2개와 해제 1개가 섞인 파일이 통과하고 marks는 파일 순서를 지킨다', () => {
  const text = jsonl(
    META,
    turn(1, 'user', null),
    turn(2, 'assistant', 't1'),
    mark('t2', true, '2026-09-11T02:00:00.000Z'),   // 캐릭터 말을 장면으로 표시
    turn(3, 'user', 't2'),
    mark('t3', true, '2026-09-11T02:01:00.000Z'),
    UPDATE,                                         // 이름 바꾸기와 섞여도 된다
    mark('t2', false, '2026-09-11T02:02:00.000Z'),  // 앞의 표시를 해제
  );
  const res = V(text);
  assert.deepEqual(res.errors, []);
  assert.equal(res.ok, true);
  assert.deepEqual(res.marks.map((m) => [m.turnId, m.marked]), [['t2', true], ['t3', true], ['t2', false]]);
  assert.equal(res.stats.markCount, 3);
  assert.deepEqual(res.stats, { turnCount: 3, userTurns: 2, assistantTurns: 1, markCount: 3, bytes: Buffer.byteLength(text, 'utf8') });
  assert.deepEqual(res.turns.map((t) => t.id), ['t1', 't2', 't3']); // 턴 목록에는 mark가 섞이지 않는다
  assert.deepEqual(res.updates, [UPDATE]);
  // 같은 턴을 여러 번 표시·해제하는 것은 정상(이력), 접기는 store가 한다
  const repeated = V(jsonl(META, turn(1, 'user', null), mark('t1', true), mark('t1', false), mark('t1', true)));
  assert.equal(repeated.ok, true);
  assert.equal(repeated.stats.markCount, 3);
  // 모르는 필드는 거부하지 않는다(기존 관대함 유지)
  assert.equal(V(jsonl(META, turn(1, 'user', null), { ...mark('t1', true), note: '나중에 쓸 메모' })).ok, true);
});

test('장면 표시 오류: 뒤에 나오는 턴·없는 턴·잘못된 marked·잘못된 at·턴 없는 파일', () => {
  // 뒤에 나오는 턴을 가리키면 안 된다(다시 열었을 때 아직 없는 턴이다)
  const forward = expectOne(jsonl(META, turn(1, 'user', null), mark('t2', true), turn(2, 'assistant', 't1')), 3, '뒤에 나오는 턴을 가리킵니다: t2');
  assert.equal(forward.marks.length, 0); // ok=false면 marks는 비운다
  assert.equal(forward.stats.markCount, 1); // 세기는 센다
  // 이 파일에 아예 없는 턴
  expectOne(jsonl(META, turn(1, 'user', null), mark('없는턴', true)), 3, '턴 id(turnId)가 올바르지 않습니다'); // 한글 id는 형식부터 걸린다
  expectOne(jsonl(META, turn(1, 'user', null), mark('t9', true)), 3, '표시한 장면이 가리키는 턴이 이 파일에 없습니다: t9');
  // marked는 true/false만
  for (const bad of ['true', 1, null, undefined]) {
    expectOne(jsonl(META, turn(1, 'user', null), { ...mark('t1', true), marked: bad }), 3, 'marked는 true 또는 false여야 합니다');
  }
  // at은 기존 meta-update와 같은 ISO 검사
  expectOne(jsonl(META, turn(1, 'user', null), mark('t1', true, '2026-09-11')), 3, '장면 표시(mark)의 시각(at)');
  expectOne(jsonl(META, turn(1, 'user', null), { type: 'mark', turnId: 't1', marked: true }), 3, '장면 표시(mark)의 시각(at)');
  // 턴이 하나도 없는 파일의 표시는 가리킬 곳이 없다
  const noTurns = V(jsonl(META, mark('t1', true)));
  assert.equal(noTurns.ok, false);
  assert.ok(hasError(noTurns, 2, '이 파일에 없습니다: t1'), flat(noTurns).join(' | '));
  // 한 줄에 여러 위반이 있으면 모두 쌓인다
  const many = V(jsonl(META, turn(1, 'user', null), { type: 'mark', at: '어제', turnId: 't9', marked: 'yes' }));
  assert.equal(many.errors.filter((e) => e.line === 3).length, 3);
});

test('장면 표시 호환성: mark가 없는 옛 파일은 그대로 통과하고 marks는 빈 배열이다', () => {
  const old = jsonl(META, turn(1, 'user', null), turn(2, 'assistant', 't1'), UPDATE);
  const res = V(old);
  assert.equal(res.ok, true);
  assert.deepEqual(res.marks, []);
  assert.equal(res.stats.markCount, 0);
  assert.deepEqual(res.turns.map((t) => t.id), ['t1', 't2']);
  assert.deepEqual(res.updates, [UPDATE]);
});
