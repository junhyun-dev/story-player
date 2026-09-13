'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Store } = require('../lib/store');
const { RecordedResponder, FAIL_TOKEN } = require('../lib/responder');
const { ChatService } = require('../lib/chat-service');
const { tempDataDir, writeWork, WORK_ID } = require('./helpers');

function setup(dir = tempDataDir(), responder = new RecordedResponder()) {
  return { dir, service: new ChatService(new Store(dir), responder) };
}

test('보내기: 사용자 턴 저장 후 기록 대사를 순서대로 돌려준다', async () => {
  const { service } = setup();
  const chat = service.createChat(WORK_ID);
  const r1 = await service.send(chat.id, { text: '이름은 진이에요', clientTurnId: 'c1' });
  assert.equal(r1.replied, true);
  assert.equal(r1.turns.length, 2);
  assert.equal(r1.turns[0].role, 'user');
  assert.equal(r1.turns[0].clientTurnId, 'c1');
  assert.equal(r1.turns[1].role, 'assistant');
  assert.equal(r1.turns[1].scriptIndex, 0);
  assert.equal(r1.turns[1].responder, 'recorded');
  assert.equal(r1.turns[1].parentId, r1.turns[0].id);
  const r2 = await service.send(chat.id, { text: '바람이 무서워요' });
  assert.equal(r2.turns[3].scriptIndex, 1);
  assert.equal(r2.responderLabel, '임시 응답(모델 없음)');
});

test('같은 clientTurnId 재전송은 중복 저장하지 않는다', async () => {
  const { service } = setup();
  const chat = service.createChat(WORK_ID);
  await service.send(chat.id, { text: '안녕', clientTurnId: 'same' });
  const again = await service.send(chat.id, { text: '안녕', clientTurnId: 'same' });
  assert.equal(again.duplicate, true);
  assert.equal(again.turns.length, 2);
});

test('응답 실패 → 사용자 턴만 남음 → 새 입력 거부 → 다시 생성 → 재시도 무동작', async () => {
  const { service } = setup();
  const chat = service.createChat(WORK_ID);
  const failed = await service.send(chat.id, { text: `열쇠 주세요 ${FAIL_TOKEN}` });
  assert.equal(failed.replied, false);
  assert.equal(failed.pending, true);
  assert.equal(failed.turns.length, 1);
  assert.match(failed.replyError, /실패 스위치/);
  await assert.rejects(service.send(chat.id, { text: '또 보냄' }), (e) => e.code === 'PENDING');
  const retried = await service.retry(chat.id);
  assert.equal(retried.replied, true);
  assert.equal(retried.pending, false);
  assert.equal(retried.turns.length, 2);
  assert.equal(retried.turns[1].parentId, retried.turns[0].id);
  const noop = await service.retry(chat.id);
  assert.equal(noop.noop, true);
  assert.equal(noop.turns.length, 2);
});

test('입력 검증', async () => {
  const { service } = setup();
  const chat = service.createChat(WORK_ID);
  for (const text of ['', '   ', 42, null, 'x'.repeat(2001)]) {
    await assert.rejects(service.send(chat.id, { text }), (e) => e.code === 'BAD_INPUT');
  }
  await assert.rejects(service.send(chat.id, { text: 'ok', clientTurnId: 'bad id!' }), (e) => e.code === 'BAD_INPUT');
  await assert.rejects(service.send('chat-none', { text: 'ok' }), (e) => e.code === 'NOT_FOUND');
  assert.throws(() => service.createChat('no-such-work'), (e) => e.code === 'NOT_FOUND');
  assert.throws(() => service.createChat(undefined), (e) => e.code === 'BAD_INPUT');
  assert.equal(service.getChat(chat.id).turns.length, 0);
});

test('기록 대사가 끝나면 fallback을 돌려주고 scriptIndex는 null', async () => {
  const dir = tempDataDir();
  writeWork(dir, 'tiny', { title: '작은 작품', character: { name: '갑' }, opening: '시작', script: ['하나'], fallback: '끝' });
  const { service } = setup(dir);
  const chat = service.createChat('tiny');
  await service.send(chat.id, { text: 'a' });
  const r = await service.send(chat.id, { text: 'b' });
  assert.equal(r.turns[3].text, '끝');
  assert.equal(r.turns[3].scriptIndex, null);
});

test('같은 채팅에 동시 다시 생성이 와도 응답 턴은 하나만 저장된다', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const slow = {
    kind: 'slow', label: '느린 테스트 응답기',
    async reply() { await gate; return { text: '늦은 답', responder: 'slow', scriptIndex: null }; },
  };
  const { service } = setup(tempDataDir(), slow);
  const chat = service.createChat(WORK_ID);
  const p1 = service.send(chat.id, { text: '첫 입력' });
  await new Promise((r) => setImmediate(r));
  assert.equal(service.getChat(chat.id).inflight, true); // 처리 중임을 화면에 알릴 수 있다
  await assert.rejects(service.retry(chat.id), (e) => e.code === 'BUSY');
  await assert.rejects(service.send(chat.id, { text: '두 번째' }), (e) => e.code === 'PENDING');
  release();
  const done = await p1;
  assert.equal(done.turns.length, 2);
  assert.equal(done.inflight, false);
  assert.equal(service.getChat(chat.id).turns.filter((t) => t.role === 'assistant').length, 1);
});

test('응답 중 작품 파일이 깨지면 응답 실패로 남고, 고친 뒤 다시 생성하면 성공한다', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = tempDataDir();
  const { service } = setup(dir);
  const chat = service.createChat(WORK_ID);
  const workFile = path.join(dir, 'works', `${WORK_ID}.json`);
  const good = fs.readFileSync(workFile, 'utf8');
  fs.writeFileSync(workFile, '{');
  const failed = await service.send(chat.id, { text: '안녕' });
  assert.equal(failed.replied, false);
  assert.equal(failed.pending, true);
  assert.match(failed.replyError, /작품 파일/);
  fs.writeFileSync(workFile, good);
  const retried = await service.retry(chat.id);
  assert.equal(retried.replied, true);
  assert.equal(retried.turns.length, 2);
});

test('분기 뒤 기록 응답기는 분기 안의 응답 수를 기준으로 이어 간다', async () => {
  const { service } = setup();
  const chat = service.createChat(WORK_ID);
  await service.send(chat.id, { text: '하나' });
  await service.send(chat.id, { text: '둘' }); // 출처: script 0, 1
  const firstReply = service.getChat(chat.id).turns[1];
  const br = service.branch(chat.id, firstReply.id); // 첫 응답까지 복제
  assert.equal(br.turns.length, 2);
  assert.equal(br.responderLabel, '임시 응답(모델 없음)');
  const r = await service.send(br.id, { text: '다른 말' });
  assert.equal(r.turns.length, 4);
  assert.equal(r.turns[3].scriptIndex, 1); // 분기의 두 번째 응답 = script 1 (출처의 두 번째 응답과 같은 대사)
  assert.equal(r.turns[2].parentId, firstReply.id);
  assert.equal(service.getChat(chat.id).turns.length, 4); // 출처는 4턴 그대로
  assert.throws(() => service.branch('chat-none', 'x'), (e) => e.code === 'NOT_FOUND');
});

test('출처에서 한 번 실패한 턴에서 분기해도 분기의 첫 시도는 독립적으로 판정된다', async () => {
  const { service } = setup();
  const chat = service.createChat(WORK_ID);
  const failed = await service.send(chat.id, { text: `${FAIL_TOKEN} 열쇠` });
  assert.equal(failed.pending, true);
  const br = service.branch(chat.id, failed.turns[0].id);
  const brTry = await service.retry(br.id);
  assert.equal(brTry.replied, false); // 분기에서도 첫 시도는 실패(채팅 경계를 넘어 기억하지 않는다)
  const brTry2 = await service.retry(br.id);
  assert.equal(brTry2.replied, true);
  assert.equal(service.getChat(chat.id).pending, true); // 출처는 여전히 응답 없음
});

test('내보내기 → 가져오기: 새 id의 별도 채팅으로 저장되고 턴·이름·보관 기록이 그대로 복원된다', async () => {
  const { service } = setup();
  const chat = service.createChat(WORK_ID);
  await service.send(chat.id, { text: '내보낼 말' });
  service.update(chat.id, { name: '보관할 이야기' });
  service.update(chat.id, { archived: true });
  const { raw, filename } = service.exportChat(chat.id);
  assert.match(filename, /^보관할 이야기-chat-.*\.jsonl$/);
  const imported = service.importChat(raw);
  assert.notEqual(imported.id, chat.id);
  assert.equal(imported.importedFrom.originalId, chat.id);
  assert.deepEqual(imported.turns, service.getChat(chat.id).turns); // 턴은 필드 단위로 같다
  assert.equal(imported.name, '보관할 이야기');
  assert.equal(imported.archived, false); // 가져오기는 복원 동작: 활성으로 들어온다
  assert.equal(imported.importedFrom.wasArchived, true); // 보관 상태였다는 기록은 남는다
  const twice = service.importChat(service.exportChat(imported.id).raw);
  assert.equal(twice.importedFrom.previous.originalId, chat.id); // 두 번 가져오면 이전 출처가 중첩된다
  assert.equal(imported.importStats.turnCount, 2);
  assert.equal(service.listChats(WORK_ID).length, 3); // 원본 + 가져온 것 + 다시 가져온 것
  const again = service.importChat(raw); // 같은 파일을 두 번 가져오면 두 개의 별도 채팅
  assert.notEqual(again.id, imported.id);
  assert.equal(service.listChats(WORK_ID).length, 4);
  assert.equal(service.getChat(chat.id).turns.length, 2); // 원본 불변
});

test('가져오기 실패: 오류 목록이 줄 번호와 함께 돌아오고 아무것도 저장되지 않는다', async () => {
  const { service } = setup();
  const good = service.exportChat(service.createChat(WORK_ID).id).raw;
  const broken = good.replace('"workId":"lighthouse-apprentice"', '"workId":"no-such-work"') + '{"type":"turn","id":"x","role":"assistant","text":"","createdAt":"bad","parentId":null}\n';
  let caught;
  try { service.importChat(broken); } catch (e) { caught = e; }
  assert.equal(caught.code, 'BAD_IMPORT');
  assert.ok(Array.isArray(caught.details) && caught.details.length >= 3);
  assert.ok(caught.details.some((d) => d.line === 1 && /설치돼 있지 않습니다/.test(d.message)));
  assert.ok(caught.details.some((d) => d.line === 2 && /첫 턴은 사용자/.test(d.message)));
  assert.equal(service.listChats(WORK_ID).length, 1); // 원래 있던 하나만
  assert.throws(() => service.importChat(42), (e) => e.code === 'BAD_IMPORT');
});

test('보관된 채팅에는 같은 clientTurnId 재전송도 ARCHIVED로 막힌다(거짓 저장됨 방지)', async () => {
  const { service } = setup();
  const chat = service.createChat(WORK_ID);
  await service.send(chat.id, { text: '보관 전 말', clientTurnId: 'c-1' });
  service.update(chat.id, { archived: true });
  await assert.rejects(service.send(chat.id, { text: '보관 전 말', clientTurnId: 'c-1' }), (e) => e.code === 'ARCHIVED');
  await assert.rejects(service.retry(chat.id), (e) => e.code === 'ARCHIVED');
  service.update(chat.id, { archived: false });
  const dup = await service.send(chat.id, { text: '보관 전 말', clientTurnId: 'c-1' });
  assert.equal(dup.duplicate, true); // 복구 뒤에는 중복 판정이 정상 동작
});

test('장면 표시: 보관된 채팅은 거부, 내보내기→가져오기에서 표시가 유효한 참조로 복원된다', async () => {
  const { service } = setup();
  const chat = service.createChat(WORK_ID);
  await service.send(chat.id, { text: '첫 말' });
  await service.send(chat.id, { text: '둘째 말' });
  const turns = service.getChat(chat.id).turns;
  const marked = service.mark(chat.id, turns[1].id, true);
  assert.deepEqual(marked.marks.map((m) => m.turnId), [turns[1].id]);
  service.update(chat.id, { archived: true });
  assert.throws(() => service.mark(chat.id, turns[0].id, true), (e) => e.code === 'ARCHIVED');
  service.update(chat.id, { archived: false });
  const { raw } = service.exportChat(chat.id);
  assert.match(raw, /"type":"mark"/);
  // 가져오기: 검증기가 marks를 돌려주면 복사된다(Worker 계약). 아직 marks를 안 돌려주면 표시 없이 통과해야 한다(호환).
  const imported = service.importChat(raw);
  assert.equal(imported.turns.length, 4); // 보내기 2회 = 사용자 2 + 캐릭터 2
  assert.deepEqual(imported.marks.map((m) => m.turnId), [turns[1].id]); // 표시가 같은 턴 id로 복원(검증기가 앞선 턴 참조를 확인)
  assert.equal(imported.markCount, 1);
  assert.equal(service.getChat(chat.id).marks.length, 1); // 원본 불변
  // 표시가 뒤 턴을 가리키도록 조작한 파일은 거부되고 아무것도 저장되지 않는다
  const lines = raw.trim().split('\n');
  const markLine = lines.findIndex((l) => l.includes('"type":"mark"'));
  const tampered = [lines[0], lines[markLine], ...lines.slice(1, markLine)].join('\n') + '\n';
  let caught;
  try { service.importChat(tampered); } catch (e) { caught = e; }
  assert.equal(caught.code, 'BAD_IMPORT');
  assert.ok(caught.details.some((d) => /뒤에 나오는 턴을 가리킵니다/.test(d.message)));
  assert.equal(service.listChats(WORK_ID).length, 2); // 원본 + 정상 가져오기 1개만
});

test('시작 설정별 대본·프롤로그: 기록 응답기는 그 시작의 대사를, 분기·가져오기는 startId를 보존한다', async () => {
  const { service } = setup();
  const chat = service.createChat(WORK_ID, 'morning-after');
  const r = await service.send(chat.id, { text: '어젯밤 말씀하신 열쇠… 아직 유효한가요?' });
  assert.match(r.turns[1].text, /열쇠는 아침에 주는 물건이 아니다/); // 두 번째 시작의 첫 대사
  const w = service.workForChat(r);
  assert.equal(w.start.id, 'morning-after');
  assert.match(w.opening, /폭풍이 지나간 아침/);
  assert.equal(w.startMissing, false);
  const br = service.branch(chat.id, r.turns[1].id);
  assert.equal(br.startId, 'morning-after'); // 분기는 meta를 복제하므로 시작 유지
  const r2 = await service.send(br.id, { text: '차 고맙습니다.' });
  assert.match(r2.turns[3].text, /새벽 세 시에 심지가/); // 분기에서도 같은 시작의 두 번째 대사
  const imported = service.importChat(service.exportChat(chat.id).raw);
  assert.equal(imported.startId, 'morning-after'); // 가져오기도 meta 그대로(검증기는 모르는 키를 거부하지 않음)
  // 시작이 사라진 채팅: 첫 시작으로 이어 가되 startMissing 표시
  const fs = require('node:fs'); const path = require('node:path');
  const file = path.join(service.store.chatsDir, `${chat.id}.jsonl`);
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  const meta = JSON.parse(lines[0]); meta.startId = 'gone'; lines[0] = JSON.stringify(meta);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  const gone = service.getChat(chat.id);
  assert.equal(gone.startMissing, true);
  assert.equal(service.workForChat(gone).start.id, 'first-night');
});

test('완결: 대본이 끝나면 엔딩 장면 1회 → 이후 입력은 ENDED, 엔딩 직전에서 분기하면 계속 쓸 수 있다', async () => {
  const { service } = setup();
  const chat = service.createChat(WORK_ID, 'first-solo-night'); // 대본 5줄
  let last;
  for (let i = 0; i < 5; i += 1) last = await service.send(chat.id, { text: `말 ${i + 1}` });
  assert.equal(last.ended, false);
  assert.equal(last.turns.at(-1).ending, undefined);
  const finished = await service.send(chat.id, { text: '이제 아침이네요' });
  assert.equal(finished.ended, true);
  assert.equal(finished.endingName, '혼자 지킨 밤');
  assert.equal(finished.turns.at(-1).ending, '혼자 지킨 밤');
  assert.match(finished.turns.at(-1).text, /동이 트자 안개가/);
  assert.equal(finished.turns.at(-1).scriptIndex, null);
  await assert.rejects(service.send(chat.id, { text: '더 쓰고 싶어요' }), (e) => e.code === 'ENDED' && /다른 시작으로/.test(e.message));
  // 엔딩 장면 직전(내 말)에서 분기하면 끝나지 않은 채팅이 되고, 응답을 다시 만들면 같은 시작의 같은 엔딩에 닿는다
  const beforeEnding = finished.turns.at(-2);
  assert.equal(beforeEnding.role, 'user');
  const br = service.branch(chat.id, beforeEnding.id);
  assert.equal(br.ended, false);
  assert.equal(br.pending, true);
  const again = await service.retry(br.id);
  assert.equal(again.ended, true);
  assert.equal(again.endingName, '혼자 지킨 밤'); // 한 시작의 결말은 하나. 다른 결말은 다른 시작에 있다
  const other = service.createChat(WORK_ID, 'morning-after');
  assert.equal(service.workForChat(other).ending.name, '창을 닦은 하루');
  assert.equal(service.getChat(chat.id).turnCount, finished.turnCount); // 원본 불변
});

test('엔딩이 없는 시작은 예전처럼 예비 문장(fallback)으로 이어지고 끝나지 않는다', async () => {
  const dir = tempDataDir();
  writeWork(dir, 'no-ending', { title: '엔딩 없음', character: { name: '갑' }, opening: '시작', script: ['한 줄'], fallback: '갑은 말이 없다.' });
  const { service } = setup(dir);
  const chat = service.createChat('no-ending');
  await service.send(chat.id, { text: '첫 말' });
  const after = await service.send(chat.id, { text: '둘째 말' });
  assert.equal(after.ended, false);
  assert.equal(after.turns.at(-1).text, '갑은 말이 없다.');
  assert.equal(after.turns.at(-1).ending, undefined);
  const more = await service.send(chat.id, { text: '셋째 말' }); // 계속 쓸 수 있다
  assert.equal(more.turnCount, 6);
});
