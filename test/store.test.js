'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Store } = require('../lib/store');
const { tempDataDir, WORK_ID } = require('./helpers');

test('작품 목록과 작품 읽기', () => {
  const store = new Store(tempDataDir());
  const works = store.listWorks();
  assert.equal(works.length, 1);
  assert.equal(works[0].id, WORK_ID);
  assert.equal(works[0].scriptCount, 8);
  assert.equal(store.getWork('no-such-work'), null);
});

test('잘못된 id(경로 이탈 포함)는 거부한다', () => {
  const store = new Store(tempDataDir());
  for (const bad of ['../x', 'a/b', '', 'x'.repeat(65), 'a b', null, 42]) {
    assert.throws(() => store.getWork(bad), (e) => e.code === 'BAD_ID');
    assert.throws(() => store.readChat(bad), (e) => e.code === 'BAD_ID');
  }
});

test('채팅 생성 → 턴 추가 → 다시 읽기 순서 보존', () => {
  const store = new Store(tempDataDir());
  const chat = store.createChat(WORK_ID);
  assert.equal(chat.turns.length, 0);
  assert.equal(chat.pending, false);
  store.appendTurn(chat.id, { id: 't1', role: 'user', text: '안녕', createdAt: '2026-09-10T01:00:00.000Z', parentId: null });
  store.appendTurn(chat.id, { id: 't2', role: 'assistant', text: '…', createdAt: '2026-09-10T01:00:01.000Z', parentId: 't1' });
  const again = store.readChat(chat.id);
  assert.deepEqual(again.turns.map((t) => t.id), ['t1', 't2']);
  assert.equal(again.turnCount, 2);
  assert.equal(again.lastSavedAt, '2026-09-10T01:00:01.000Z');
  assert.equal(again.pending, false);
  assert.deepEqual(again.damagedLines, []);
});

test('마지막 줄이 끊긴 파일도 읽히고, 이후 추가 저장이 그 줄에 붙지 않는다', () => {
  const store = new Store(tempDataDir());
  const chat = store.createChat(WORK_ID);
  store.appendTurn(chat.id, { id: 't1', role: 'user', text: '첫 줄', createdAt: '2026-09-10T01:00:00.000Z', parentId: null });
  // 쓰는 도중 끊긴 것처럼 줄바꿈 없는 조각을 남긴다.
  fs.appendFileSync(store.chatFile(chat.id), '{"type":"turn","id":"t2","role":"assis');
  const damaged = store.readChat(chat.id);
  assert.deepEqual(damaged.turns.map((t) => t.id), ['t1']);
  assert.deepEqual(damaged.damagedLines, [3]);
  assert.equal(damaged.pending, true);
  store.appendTurn(chat.id, { id: 't3', role: 'assistant', text: '복구 후', createdAt: '2026-09-10T01:00:02.000Z', parentId: 't1' });
  const repaired = store.readChat(chat.id);
  assert.deepEqual(repaired.turns.map((t) => t.id), ['t1', 't3']);
  assert.deepEqual(repaired.damagedLines, [3]);
  assert.equal(repaired.pending, false);
});

test('채팅 목록은 마지막 저장 시각 내림차순이며 pending을 표시한다', () => {
  const store = new Store(tempDataDir());
  const a = store.createChat(WORK_ID);
  const b = store.createChat(WORK_ID);
  store.appendTurn(a.id, { id: 'a1', role: 'user', text: 'x', createdAt: '2026-09-10T02:00:00.000Z', parentId: null });
  store.appendTurn(b.id, { id: 'b1', role: 'user', text: 'y', createdAt: '2026-09-10T03:00:00.000Z', parentId: null });
  store.appendTurn(b.id, { id: 'b2', role: 'assistant', text: 'z', createdAt: '2026-09-10T03:00:01.000Z', parentId: 'b1' });
  const list = store.listChats(WORK_ID);
  assert.deepEqual(list.map((c) => c.id), [b.id, a.id]);
  assert.equal(list[0].pending, false);
  assert.equal(list[1].pending, true);
  assert.equal(list[0].turns, undefined);
  assert.equal(store.listChats('other-work').length, 0);
});

test('meta가 없는 파일은 목록에서 읽을 수 없음으로 표시된다', () => {
  const store = new Store(tempDataDir());
  fs.writeFileSync(path.join(store.chatsDir, 'broken.jsonl'), 'not json\n');
  const list = store.listChats();
  assert.equal(list.length, 1);
  assert.equal(list[0].unreadable, true);
});

test('parentId 사슬이 어긋난 턴은 chainBreaks로 알리되 버리지 않는다', () => {
  const store = new Store(tempDataDir());
  const chat = store.createChat(WORK_ID);
  store.appendTurn(chat.id, { id: 't1', role: 'user', text: 'a', createdAt: '2026-09-10T01:00:00.000Z', parentId: null });
  store.appendTurn(chat.id, { id: 't2', role: 'assistant', text: 'b', createdAt: '2026-09-10T01:00:01.000Z', parentId: 't1' });
  assert.deepEqual(store.readChat(chat.id).chainBreaks, []);
  // 같은 부모를 가리키는 두 번째 assistant 줄(분기를 한 파일에 섞은 경우)
  store.appendTurn(chat.id, { id: 't3', role: 'assistant', text: 'c', createdAt: '2026-09-10T01:00:02.000Z', parentId: 't1' });
  const chat2 = store.readChat(chat.id);
  assert.deepEqual(chat2.turns.map((t) => t.id), ['t1', 't2', 't3']);
  assert.deepEqual(chat2.chainBreaks, ['t3']);
});

test('깨진 작품 파일은 목록에서 개별 격리되고 나머지 작품은 살아 있다', () => {
  const dir = tempDataDir();
  const store = new Store(dir);
  fs.writeFileSync(path.join(dir, 'works', 'broken.json'), '{}');
  fs.writeFileSync(path.join(dir, 'works', 'notjson.json'), '{');
  const works = store.listWorks();
  assert.deepEqual(works.map((w) => [w.id, Boolean(w.unreadable)]), [['broken', true], [WORK_ID, false], ['notjson', true]]);
  assert.throws(() => store.getWork('broken'), (e) => e.code === 'BAD_WORK');
});

test('분기: 출처 턴까지 복제한 새 파일을 만들고 출처는 그대로다', () => {
  const store = new Store(tempDataDir());
  const src = store.createChat(WORK_ID);
  store.appendTurn(src.id, { id: 't1', role: 'user', text: 'a', createdAt: '2026-09-11T01:00:00.000Z', parentId: null });
  store.appendTurn(src.id, { id: 't2', role: 'assistant', text: 'b', createdAt: '2026-09-11T01:00:01.000Z', parentId: 't1' });
  store.appendTurn(src.id, { id: 't3', role: 'user', text: 'c', createdAt: '2026-09-11T01:00:02.000Z', parentId: 't2' });
  store.appendTurn(src.id, { id: 't4', role: 'assistant', text: 'd', createdAt: '2026-09-11T01:00:03.000Z', parentId: 't3' });
  const br = store.branchChat(src.id, 't2');
  assert.notEqual(br.id, src.id);
  assert.deepEqual(br.branchOf, { chatId: src.id, turnId: 't2', turnCount: 2, sourceDamagedLines: [] });
  assert.deepEqual(br.turns, store.readChat(src.id).turns.slice(0, 2)); // 복제 충실도: 필드 단위로 같다
  assert.equal(br.branchIncomplete, false);
  assert.deepEqual(fs.readdirSync(store.chatsDir).filter((f) => f.startsWith('.')), []); // 임시 파일이 남지 않는다
  assert.deepEqual(br.chainBreaks, []);
  assert.equal(br.pending, false);
  assert.equal(br.workId, src.workId);
  assert.deepEqual(store.readChat(src.id).turns.map((t) => t.id), ['t1', 't2', 't3', 't4']); // 출처 불변
  assert.equal(store.readChat(src.id).branchOf, undefined);
  const atUser = store.branchChat(src.id, 't3'); // 사용자 턴에서 갈라지면 응답이 필요한 상태
  assert.equal(atUser.pending, true);
  assert.equal(atUser.turns.length, 3);
  assert.throws(() => store.branchChat(src.id, 'nope'), (e) => e.code === 'NOT_FOUND');
  assert.throws(() => store.branchChat(src.id, undefined), (e) => e.code === 'BAD_INPUT');
  assert.throws(() => store.branchChat('chat-none', 't1'), (e) => e.code === 'NOT_FOUND');
  assert.equal(store.listChats(WORK_ID).filter((c) => c.branchOf).length, 2);
});

test('분기: 손상 구간을 포함한 분기는 거부하고, 손상 앞에서는 근거를 남기며 허용한다', () => {
  const store = new Store(tempDataDir());
  const src = store.createChat(WORK_ID);
  store.appendTurn(src.id, { id: 't1', role: 'user', text: 'a', createdAt: '2026-09-11T01:00:00.000Z', parentId: null });
  store.appendTurn(src.id, { id: 't2', role: 'assistant', text: 'b', createdAt: '2026-09-11T01:00:01.000Z', parentId: 't1' });
  fs.appendFileSync(store.chatFile(src.id), '{"type":"turn","id":"t3","role":"user","text":"끊\n'); // 3번째 턴 줄 손상
  store.appendTurn(src.id, { id: 't4', role: 'assistant', text: 'd', createdAt: '2026-09-11T01:00:03.000Z', parentId: 't3' });
  const read = store.readChat(src.id);
  assert.deepEqual(read.damagedLines, [4]);
  assert.deepEqual(read.chainBreaks, ['t4']);
  assert.throws(() => store.branchChat(src.id, 't4'), (e) => e.code === 'BAD_INPUT'); // 손실 승계 거부
  const ok = store.branchChat(src.id, 't2');
  assert.deepEqual(ok.turns.map((t) => t.id), ['t1', 't2']);
  assert.deepEqual(ok.chainBreaks, []);
  assert.deepEqual(ok.branchOf.sourceDamagedLines, [4]); // 출처에 손상이 있었다는 근거는 남는다
});

test('분기: 잘린 분기 파일은 branchIncomplete로 알린다', () => {
  const store = new Store(tempDataDir());
  const src = store.createChat(WORK_ID);
  for (let i = 1; i <= 4; i += 1) {
    store.appendTurn(src.id, { id: `t${i}`, role: i % 2 ? 'user' : 'assistant', text: String(i), createdAt: `2026-09-11T01:00:0${i}.000Z`, parentId: i === 1 ? null : `t${i - 1}` });
  }
  const br = store.branchChat(src.id, 't4');
  const lines = fs.readFileSync(store.chatFile(br.id), 'utf8').trim().split('\n');
  fs.writeFileSync(store.chatFile(br.id), lines.slice(0, 3).join('\n') + '\n'); // meta + 2턴만 남긴다(중단·외부 편집 재현)
  const cut = store.readChat(br.id);
  assert.equal(cut.turns.length, 2);
  assert.equal(cut.branchIncomplete, true);
  assert.equal(store.listChats(WORK_ID).find((c) => c.id === br.id).branchIncomplete, true);
});

test('채팅 목록은 마지막 내 말과 분기점 뒤 첫 내 말을 미리보기로 준다', () => {
  const store = new Store(tempDataDir());
  const src = store.createChat(WORK_ID);
  store.appendTurn(src.id, { id: 't1', role: 'user', text: '첫 말', createdAt: '2026-09-11T01:00:00.000Z', parentId: null });
  store.appendTurn(src.id, { id: 't2', role: 'assistant', text: 'b', createdAt: '2026-09-11T01:00:01.000Z', parentId: 't1' });
  const br1 = store.branchChat(src.id, 't2');
  const br2 = store.branchChat(src.id, 't2');
  store.appendTurn(br2.id, { id: 't3', role: 'user', text: '다른 길', createdAt: '2026-09-11T01:00:02.000Z', parentId: 't2' });
  const list = store.listChats(WORK_ID);
  assert.equal(list.find((c) => c.id === src.id).lastUserText, '첫 말');
  assert.equal(list.find((c) => c.id === br1.id).firstTextAfterBranch, '');
  assert.equal(list.find((c) => c.id === br2.id).firstTextAfterBranch, '다른 길');
});

test('이름 바꾸기·보관·복구는 meta-update 레코드로 덧붙이고 첫 줄·턴은 그대로다', () => {
  const store = new Store(tempDataDir());
  const chat = store.createChat(WORK_ID);
  store.appendTurn(chat.id, { id: 't1', role: 'user', text: 'a', createdAt: '2026-09-11T01:00:00.000Z', parentId: null });
  assert.equal(store.readChat(chat.id).name, '등대의 견습생'); // 기본 이름은 작품 제목
  assert.equal(store.readChat(chat.id).archived, false);
  const renamed = store.updateChat(chat.id, { name: '  폭풍 밤의 약속  ' });
  assert.equal(renamed.name, '폭풍 밤의 약속');
  assert.equal(renamed.title, '등대의 견습생'); // 작품 제목은 그대로
  const archived = store.updateChat(chat.id, { archived: true });
  assert.equal(archived.archived, true);
  assert.ok(archived.archivedAt);
  const restored = store.updateChat(chat.id, { archived: false });
  assert.equal(restored.archived, false);
  assert.equal(restored.archivedAt, null);
  assert.equal(restored.name, '폭풍 밤의 약속'); // 복구해도 이름은 유지
  const lines = fs.readFileSync(store.chatFile(chat.id), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.type), ['meta', 'turn', 'meta-update', 'meta-update', 'meta-update']);
  assert.equal(lines[0].title, '등대의 견습생'); // 첫 줄은 수정되지 않는다
  assert.deepEqual(restored.turns.map((t) => t.id), ['t1']);
  assert.deepEqual(restored.damagedLines, []);
  assert.ok(restored.lastSavedAt >= '2026-09-11T01:00:00.000Z');
  for (const bad of [{ name: '' }, { name: '   ' }, { name: 'x'.repeat(81) }, { name: 3 }, { archived: 'yes' }, {}]) {
    assert.throws(() => store.updateChat(chat.id, bad), (e) => e.code === 'BAD_INPUT');
  }
  assert.throws(() => store.updateChat('chat-none', { name: 'x' }), (e) => e.code === 'NOT_FOUND');
  const list = store.listChats(WORK_ID);
  assert.equal(list[0].name, '폭풍 밤의 약속');
  assert.equal(list[0].archived, false);
});

test('분기 출처의 존재 여부를 읽을 때 계산한다(가져온 분기·옮겨진 출처)', () => {
  const store = new Store(tempDataDir());
  const src = store.createChat(WORK_ID);
  store.appendTurn(src.id, { id: 't1', role: 'user', text: 'a', createdAt: '2026-09-11T01:00:00.000Z', parentId: null });
  const br = store.branchChat(src.id, 't1');
  assert.equal(store.readChat(br.id).branchSourceExists, true);
  assert.equal(store.readChat(src.id).branchSourceExists, null); // 분기가 아니면 해당 없음
  fs.renameSync(store.chatFile(src.id), path.join(store.chatsDir, 'moved-away.jsonl.bak'));
  assert.equal(store.readChat(br.id).branchSourceExists, false);
});

test('장면 표시: mark 레코드 접기(마지막 레코드 유효), 실제 턴만, 원문 불변, 목록 markCount', () => {
  const store = new Store(tempDataDir());
  const chat = store.createChat(WORK_ID);
  for (let i = 1; i <= 4; i += 1) {
    store.appendTurn(chat.id, { id: `t${i}`, role: i % 2 ? 'user' : 'assistant', text: `말 ${i}`, createdAt: `2026-09-11T01:00:0${i}.000Z`, parentId: i === 1 ? null : `t${i - 1}` });
  }
  assert.deepEqual(store.readChat(chat.id).marks, []);
  store.setMark(chat.id, 't2', true);
  store.setMark(chat.id, 't4', true);
  store.setMark(chat.id, 't1', true);
  let c = store.readChat(chat.id);
  assert.deepEqual(c.marks.map((m) => m.turnId), ['t1', 't2', 't4']); // 턴 순서로 정렬
  assert.equal(c.markCount, 3);
  store.setMark(chat.id, 't2', false); // 해제는 새 레코드
  c = store.readChat(chat.id);
  assert.deepEqual(c.marks.map((m) => m.turnId), ['t1', 't4']);
  assert.deepEqual(c.turns.map((t) => t.text), ['말 1', '말 2', '말 3', '말 4']); // 원문 불변
  const lines = fs.readFileSync(store.chatFile(chat.id), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.filter((l) => l.type === 'mark').map((l) => [l.turnId, l.marked]), [['t2', true], ['t4', true], ['t1', true], ['t2', false]]);
  assert.throws(() => store.setMark(chat.id, 'no-such-turn', true), (e) => e.code === 'NOT_FOUND');
  assert.throws(() => store.setMark(chat.id, 't1', 'yes'), (e) => e.code === 'BAD_INPUT');
  assert.throws(() => store.setMark(chat.id, '../x', true), (e) => e.code === 'BAD_INPUT');
  const other = store.createChat(WORK_ID);
  assert.throws(() => store.setMark(other.id, 't1', true), (e) => e.code === 'NOT_FOUND'); // 다른 채팅의 턴 참조 불가
  assert.equal(store.listChats(WORK_ID).find((x) => x.id === chat.id).markCount, 2);
  // 존재하지 않는 턴을 가리키는 mark 줄이 파일에 있어도(외부 편집) 접기에서 무시된다
  fs.appendFileSync(store.chatFile(chat.id), JSON.stringify({ type: 'mark', at: '2026-09-11T02:00:00.000Z', turnId: 'ghost', marked: true }) + '\n');
  assert.deepEqual(store.readChat(chat.id).marks.map((m) => m.turnId), ['t1', 't4']);
  assert.deepEqual(store.readChat(chat.id).damagedLines, []);
});

test('분기는 복제 턴에 대응하는 현재 유효 표시만 이어받고, 이후 부모/자식 표시는 독립이다', () => {
  const store = new Store(tempDataDir());
  const src = store.createChat(WORK_ID);
  for (let i = 1; i <= 4; i += 1) {
    store.appendTurn(src.id, { id: `t${i}`, role: i % 2 ? 'user' : 'assistant', text: `말 ${i}`, createdAt: `2026-09-11T01:00:0${i}.000Z`, parentId: i === 1 ? null : `t${i - 1}` });
  }
  store.setMark(src.id, 't3', true); // 분기점(t2) 뒤 → 따라가면 안 됨
  store.setMark(src.id, 't2', true);
  store.setMark(src.id, 't2', false); // 해제됨 → 따라가면 안 됨
  store.setMark(src.id, 't1', true); // 뒤늦게 표시한 앞 장면 → 따라가야 함(레코드 위치가 아니라 유효 상태 기준)
  const br = store.branchChat(src.id, 't2');
  assert.deepEqual(br.turns.map((t) => t.id), ['t1', 't2']);
  assert.deepEqual(br.marks.map((m) => m.turnId), ['t1']);
  const carried = fs.readFileSync(store.chatFile(br.id), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((l) => l.type === 'mark');
  assert.deepEqual(carried.map((l) => [l.turnId, l.marked, l.carriedFrom]), [['t1', true, src.id]]);
  // 이후 독립: 자식에서 해제·표시해도 부모 불변, 부모에서 바꿔도 자식 불변
  store.setMark(br.id, 't1', false);
  store.setMark(br.id, 't2', true);
  assert.deepEqual(store.readChat(src.id).marks.map((m) => m.turnId), ['t1', 't3']);
  store.setMark(src.id, 't1', false);
  assert.deepEqual(store.readChat(br.id).marks.map((m) => m.turnId), ['t2']);
  // 옛 파일(mark 없음)은 그대로 읽힌다
  const plain = store.createChat(WORK_ID);
  assert.deepEqual(store.readChat(plain.id).marks, []);
});

test('작품 선택 필드: playGuide·suggestedReplies는 있으면 정리해 주고, 형식이 어긋나면 그 필드만 비운다', () => {
  const dir = tempDataDir();
  const store = new Store(dir);
  const w = store.getWork(WORK_ID);
  assert.equal(w.suggestedReplies.length, 3);
  assert.match(w.playGuide, /해원에게는 전달되지 않습니다/);
  const { writeWork } = require('./helpers');
  writeWork(dir, 'plain', { title: '옛 형식', character: { name: '갑' }, opening: '시작', script: [] });
  assert.deepEqual(store.getWork('plain').suggestedReplies, []);
  assert.equal(store.getWork('plain').playGuide, '');
  writeWork(dir, 'odd', { title: '이상한 형식', character: { name: '갑' }, opening: '시작', script: [], playGuide: 42, suggestedReplies: ['하나', '', 7, '둘', '셋', '넷'] });
  const odd = store.getWork('odd');
  assert.equal(odd.playGuide, '');
  assert.deepEqual(odd.suggestedReplies, ['하나', '둘', '셋']); // 빈 값·비문자열 제외, 최대 3개
  assert.equal(store.listWorks().length, 3); // 작품 목록은 그대로 읽힌다
});

test('시작 설정: 옛 형식은 시작 하나로, starts는 정리·중복 제거·불량 항목 제외, createChat(startId) 검증', () => {
  const dir = tempDataDir();
  const store = new Store(dir);
  const w = store.getWork(WORK_ID);
  assert.equal(w.starts.length, 3);
  assert.deepEqual(w.starts.map((st) => st.id), ['first-night', 'morning-after', 'first-solo-night']);
  assert.equal(w.opening, w.starts[0].opening); // 호환: 최상위는 첫 시작
  assert.equal(w.starts[1].script.length, 6);
  const { writeWork } = require('./helpers');
  writeWork(dir, 'legacy', { title: '옛 형식', character: { name: '갑' }, opening: '옛 시작', script: ['a'], suggestedReplies: ['x'] });
  const legacy = store.getWork('legacy');
  assert.deepEqual(legacy.starts.map((st) => [st.id, st.name, st.opening, st.script.length, st.suggestedReplies.length]), [['default', '기본 시작', '옛 시작', 1, 1]]);
  writeWork(dir, 'messy', { title: '엉킨 형식', character: { name: '갑' }, opening: '최상위', script: ['공통'], starts: [
    { id: 'a', name: 'A', opening: 'A 시작' }, // script 없음 → 최상위 script 상속
    { id: 'a', name: '중복', opening: '중복' }, // 같은 id → 제외
    { name: '이름만', opening: '' }, // opening 없음 → 제외
    { id: 'bad id!', name: 'B', opening: 'B 시작', script: ['b1', 3, 'b2'], suggestedReplies: ['r1', '', 'r2', 'r3', 'r4'] },
    'not-an-object',
  ] });
  const messy = store.getWork('messy');
  assert.deepEqual(messy.starts.map((st) => [st.id, st.name, st.script, st.suggestedReplies]), [['a', 'A', ['공통'], []], ['start-3', 'B', ['b1', 'b2'], ['r1', 'r2', 'r3']]]); // 번호는 유효 항목 기준
  const chat = store.createChat(WORK_ID, 'morning-after');
  assert.equal(chat.startId, 'morning-after');
  assert.equal(chat.startName, '폭풍 다음 날 아침');
  assert.equal(store.createChat(WORK_ID).startId, 'first-night'); // 기본은 첫 시작
  assert.throws(() => store.createChat(WORK_ID, 'no-such-start'), (e) => e.code === 'BAD_INPUT');
  assert.throws(() => store.createChat(WORK_ID, 42), (e) => e.code === 'BAD_INPUT');
  assert.deepEqual(Store.startFor(w, 'ghost'), { start: w.starts[0], startMissing: true });
  assert.equal(store.listWorks().find((x) => x.id === WORK_ID).startCount, 3); // 목록은 파일명순이라 id로 찾는다
});

test('엔딩: 시작별로 정규화하고(이름 20자·본문 필수), 마지막 턴이 엔딩이면 ended로 접는다', () => {
  const dir = tempDataDir();
  const store = new Store(dir);
  const w = store.getWork(WORK_ID);
  assert.deepEqual(w.starts.map((st) => st.ending.name), ['열쇠를 받은 새벽', '창을 닦은 하루', '혼자 지킨 밤']);
  assert.match(w.starts[0].ending.text, /첫 밤을 넘긴 견습생은/);
  assert.match(w.starts[0].ending.hint, /해원이 먼저 약속을/);
  const { writeWork } = require('./helpers');
  writeWork(dir, 'odd', { title: '엔딩 형식', character: { name: '갑' }, opening: '시작', script: [], starts: [
    { id: 'a', name: 'A', opening: 'A', ending: { text: '끝났다', name: '이름이 아주 긴 엔딩 이름 스물한자넘김' } },
    { id: 'b', name: 'B', opening: 'B', ending: { name: '본문 없음' } },
    { id: 'c', name: 'C', opening: 'C', ending: '문자열' },
  ] });
  const odd = store.getWork('odd');
  assert.equal(odd.starts[0].ending.name.length, 20);
  assert.equal(odd.starts[0].ending.hint, '');
  assert.equal(odd.starts[1].ending, null); // 본문 없으면 엔딩 아님
  assert.equal(odd.starts[2].ending, null);
  writeWork(dir, 'plain', { title: '엔딩 없음', character: { name: '갑' }, opening: '시작', script: ['한 줄'] });
  assert.equal(store.getWork('plain').starts[0].ending, null);
  // ended 접기: 마지막 assistant 턴에 ending 이름이 있어야 끝
  const chat = store.createChat(WORK_ID);
  store.appendTurn(chat.id, { id: 't1', role: 'user', text: 'a', createdAt: '2026-09-12T01:00:00.000Z', parentId: null });
  store.appendTurn(chat.id, { id: 't2', role: 'assistant', text: 'b', createdAt: '2026-09-12T01:00:01.000Z', parentId: 't1' });
  assert.equal(store.readChat(chat.id).ended, false);
  store.appendTurn(chat.id, { id: 't3', role: 'user', text: 'c', createdAt: '2026-09-12T01:00:02.000Z', parentId: 't2' });
  store.appendTurn(chat.id, { id: 't4', role: 'assistant', text: '마지막 장면', createdAt: '2026-09-12T01:00:03.000Z', parentId: 't3', ending: '열쇠를 받은 새벽' });
  const ended = store.readChat(chat.id);
  assert.equal(ended.ended, true);
  assert.equal(ended.endingName, '열쇠를 받은 새벽');
  assert.equal(store.listChats(WORK_ID).find((c) => c.id === chat.id).ended, true);
});

test('원고 정합: 첫 홀로 밤 근무의 대본이 자기 엔딩을 부정하지 않는다(2026-09-12 교정한 결함의 회귀 검사)', () => {
  const store = new Store(tempDataDir());
  const st = store.getWork(WORK_ID).starts.find((x) => x.id === 'first-solo-night');
  const script = st.script.join('\n');
  // 결함이었던 문장: 해원이 밤을 다시 가져가면 '혼자 지킨 밤' 엔딩이 거짓이 된다
  assert.doesNotMatch(script, /오늘 밤은 내가 마무리한다/);
  assert.doesNotMatch(script, /내려가 봐라/);
  // 엔딩이 회수하는 두 가지(종소리를 들은 배, 계단에서 잠든 해원)가 대본에 미리 심겨 있다
  assert.match(script, /기적이 울렸다|종소리/);
  assert.match(script, /계단에 앉아 눈만/);
  assert.match(st.ending.text, /종소리를 들은 배/);
  assert.match(st.ending.text, /계단 중간에 앉아 잠들어/);
  // 열쇠는 프롤로그에서 한 번만 건네고 대본에서 다시 건네지 않는다
  assert.match(st.opening, /열쇠를 당신 손에 쥐여 주고/);
  assert.doesNotMatch(script, /열쇠는 네 것이다/);
  assert.equal(st.script.length, 5); // 대사 수는 그대로(저장 형식·기존 채팅 영향 없음)
});

test('읽기 전용 Store: create:false 는 폴더를 만들지 않고, 기본값은 예전처럼 만든다(미리보기 도구용)', () => {
  const os = require('node:os');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'psp-readonly-'));
  const worksOnly = path.join(base, 'works-only');
  fs.mkdirSync(path.join(worksOnly, 'works'), { recursive: true });
  const readOnly = new Store(worksOnly, { create: false });
  assert.deepEqual(fs.readdirSync(worksOnly), ['works']); // chats 를 만들지 않는다
  assert.deepEqual(readOnly.listWorks(), []);
  const fresh = path.join(base, 'fresh');
  new Store(fresh); // 기본값은 예전 동작(제품 경로)
  assert.deepEqual(fs.readdirSync(fresh).sort(), ['chats', 'works']);
  fs.rmSync(base, { recursive: true, force: true });
});

test('원고 정합: 첫 밤의 대본은 열쇠를 건네지 않고 엔딩이 한 번만 건넨다(2026-09-13 교정의 회귀 검사)', () => {
  const store = new Store(tempDataDir());
  const st = store.getWork(WORK_ID).starts.find((x) => x.id === 'first-night');
  const script = st.script.join('\n');
  assert.doesNotMatch(script, /약속한 열쇠다/); // 결함이었던 문장: 대사8이 엔딩보다 먼저 열쇠를 건넸다
  assert.match(st.script[7], /곧 새벽이다/); // 대사8은 새벽과 '줄 것'을 예고만 한다
  assert.match(st.script[3], /열쇠를 네게 맡기겠다/); // 약속(대사4)은 그대로
  assert.match(st.ending.text, /열쇠를 당신 손바닥에 올리고/); // 전달은 엔딩에서 한 번
  assert.equal(st.script.length, 8); // 대사 수 유지: 저장된 턴은 보존, 앞으로 받는 대사8만 달라진다
});
