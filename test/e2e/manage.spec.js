'use strict';
// 채팅이 늘어도 찾고 정리하고 다시 이어가는 흐름: 이름·검색·보관/복구·내보내기·빈 목록·연결 실패·모바일 전환.
const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');
const { startServer } = require('./server-fixture');

const botMsgs = (page) => page.locator('[data-role="assistant"]');
const meta = (page) => page.locator('#chatMeta');
let srv;
test.beforeEach(async () => { srv = await startServer(); });
test.afterEach(async () => { await srv.stop(); });

async function newChatAndSay(page, text) {
  await page.getByRole('button', { name: '새 채팅 시작' }).click();
  await expect(page.getByText('새 채팅을 만들고 저장했습니다.')).toBeVisible();
  await page.getByRole('textbox', { name: '' }).first().fill(text);
  await page.locator('#input').press('Enter');
  await expect(botMsgs(page)).toHaveCount(1);
}
async function chats() { return (await (await fetch(`${srv.base}/api/chats`)).json()).chats; }

test('이름 바꾸기 → 검색으로 찾기 → 보관(읽기 전용) → 보관함에서 복구 → 이어 쓰기', async ({ page }) => {
  await page.goto(srv.base);
  await expect(page.getByText('아직 저장된 채팅이 없습니다')).toBeVisible(); // 빈 목록 상태
  await newChatAndSay(page, '첫 채팅의 말');
  await newChatAndSay(page, '둘째 채팅의 말');
  const [second, first] = await chats(); // 최근 저장 순

  // 이름 바꾸기(인라인 폼)
  await page.getByRole('button', { name: '이름 바꾸기' }).click();
  await page.getByLabel('새 이름').fill('폭풍 밤의 약속');
  await page.locator('#renameForm').getByRole('button', { name: '저장' }).click();
  await expect(page.getByText(/이름을 '폭풍 밤의 약속'으로 바꿨습니다/)).toBeVisible();
  await expect(page.locator('#chatTitle')).toContainText('폭풍 밤의 약속');
  await expect(page.locator(`[data-chat-id="${second.id}"] .name`)).toHaveText('폭풍 밤의 약속');
  await expect(page.locator(`[data-chat-id="${first.id}"] .name`)).toHaveText('등대의 견습생'); // 다른 채팅은 기본 이름

  // 검색: 이름으로, 마지막 말로, 없는 말로
  const search = page.getByLabel('채팅 찾기');
  await search.fill('폭풍');
  await expect(page.locator('#chatList [data-chat-id]')).toHaveCount(1);
  await search.fill('첫 채팅');
  await expect(page.locator('#chatList [data-chat-id]')).toHaveCount(1);
  await expect(page.locator(`#chatList [data-chat-id="${first.id}"]`)).toBeVisible();
  await search.fill('없는 말');
  await expect(page.getByText('검색 결과가 없습니다.')).toBeVisible();
  await search.fill('');
  await expect(page.locator('#chatList [data-chat-id]')).toHaveCount(2);

  // 분기 두 개를 같은 턴에서 만들고 '분기 뒤 첫 말'로 찾는다(이름이 같아 미리보기만이 단서)
  await page.locator(`#chatList [data-chat-id="${first.id}"]`).click();
  await botMsgs(page).first().getByRole('button', { name: '여기서 새 전개' }).click();
  await expect(page.getByText(/2턴까지 복제한 새 채팅입니다/)).toBeVisible();
  await page.locator('#input').fill('갈라진 길의 첫 말');
  await page.locator('#input').press('Enter');
  await expect(botMsgs(page)).toHaveCount(2);
  await page.locator(`#chatList [data-chat-id="${first.id}"]`).click();
  await botMsgs(page).first().getByRole('button', { name: '여기서 새 전개' }).click();
  await expect(page.getByText(/2턴까지 복제한 새 채팅입니다/)).toBeVisible();
  await expect(page.locator('#chatList [data-chat-id]')).toHaveCount(4);
  await search.fill('갈라진 길');
  await expect(page.locator('#chatList [data-chat-id]')).toHaveCount(1);
  await expect(page.locator('#chatList .preview')).toHaveText(/^다음 말: 갈라진 길의 첫 말/);
  await search.fill('');
  await page.locator(`#chatList [data-chat-id="${second.id}"]`).click();
  await expect(page.locator('#chatTitle')).toContainText('폭풍 밤의 약속');

  // 보관: 목록에서 사라지고 보관함으로, 채팅은 읽기 전용
  await page.getByRole('button', { name: '보관', exact: true }).click();
  await expect(page.getByText(/보관함으로 옮겼습니다/)).toBeVisible();
  await expect(page.locator('.info.archived')).toBeVisible();
  await expect(page.locator('#input')).toBeDisabled();
  await expect(page.getByRole('button', { name: '보내기', exact: true })).toBeDisabled();
  await expect(page.locator('#chatList [data-chat-id]')).toHaveCount(3);
  await expect(page.getByRole('button', { name: /보관함 \(1\)/ })).toBeVisible();
  await expect(page.locator(`#archivedList [data-chat-id="${second.id}"]`)).toBeVisible();
  // 보관된 채팅만 검색에 걸리면 보관함이 자동으로 펼쳐지고 일치 수가 보인다(빈 화면 방지)
  await page.reload();
  await expect(page.locator('#chatTitle')).toContainText('폭풍 밤의 약속');
  await expect(page.locator('#archivedList')).toBeHidden(); // 새로고침 뒤엔 접혀 있다
  await page.getByLabel('채팅 찾기').fill('폭풍');
  await expect(page.locator('#chatList [data-chat-id]')).toHaveCount(0);
  await expect(page.getByText('검색 결과가 없습니다.')).toBeHidden();
  await expect(page.getByRole('button', { name: /보관함 \(1\) · 검색 일치 1/ })).toBeVisible();
  await expect(page.locator(`#archivedList [data-chat-id="${second.id}"]`)).toBeVisible();
  await page.getByLabel('채팅 찾기').fill('');
  // 서버도 막는다
  const blocked = await fetch(`${srv.base}/api/chats/${second.id}/turns`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '몰래 이어 쓰기' }) });
  expect(blocked.status).toBe(409);
  // 보관해도 새 전개는 만들 수 있다
  await botMsgs(page).first().getByRole('button', { name: '여기서 새 전개' }).click();
  await expect(page.getByText(/2턴까지 복제한 새 채팅입니다/)).toBeVisible();
  await expect(page.locator('#input')).toBeEnabled(); // 분기는 보관 상태를 물려받지 않는다

  // 보관함에서 복구 → 이어 쓰기
  await page.getByRole('button', { name: /보관함 \(1\) 열기/ }).click();
  await expect(page.locator('#archivedList')).toBeVisible();
  await page.locator('#archivedList').getByRole('button', { name: '복구' }).click();
  await expect(page.getByText(/복구했습니다/)).toBeVisible();
  await expect(page.getByRole('button', { name: /보관함/ })).toBeHidden();
  await page.locator(`#chatList [data-chat-id="${second.id}"]`).click();
  await expect(page.locator('#chatList [data-chat-id]')).toHaveCount(5); // 원본 2 + first의 분기 2 + 보관 중 만든 분기 1
  await expect(page.locator('#chatTitle')).toContainText('폭풍 밤의 약속');
  await expect(page.locator('#input')).toBeEnabled();
  await page.locator('#input').fill('복구 뒤 이어 쓴 말');
  await page.locator('#input').press('Enter');
  await expect(botMsgs(page)).toHaveCount(2);
  await expect(meta(page)).toHaveText(/^4턴 · /);

  // 내보내기: 저장 파일이 그대로 내려온다
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '내보내기' }).click()]);
  expect(download.suggestedFilename()).toMatch(/\.jsonl$/);
  const downloaded = fs.readFileSync(await download.path(), 'utf8');
  const onDisk = fs.readFileSync(path.join(srv.dataDir, 'chats', `${second.id}.jsonl`), 'utf8');
  expect(downloaded).toBe(onDisk);
  expect(downloaded.split('\n').filter(Boolean).map((l) => JSON.parse(l).type)).toEqual(['meta', 'turn', 'turn', 'meta-update', 'meta-update', 'meta-update', 'turn', 'turn']);
});

test('모바일: 목록과 채팅이 한 화면씩 보이고 버튼으로 오간다', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 780 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await page.goto(srv.base);
  await expect(page.locator('#sidebar')).toBeVisible();
  await expect(page.locator('#chatpane')).toBeHidden(); // 처음엔 목록만
  await page.getByRole('button', { name: '새 채팅 시작' }).click();
  await expect(page.locator('#chatpane')).toBeVisible();
  await expect(page.locator('#sidebar')).toBeHidden(); // 채팅을 열면 채팅만
  await page.locator('#input').fill('모바일에서 보냄');
  await page.locator('#input').press('Enter');
  await expect(botMsgs(page)).toHaveCount(1);
  await page.getByRole('button', { name: '채팅 목록 열기' }).click();
  await expect(page.locator('#sidebar')).toBeVisible();
  await expect(page.locator('#chatpane')).toBeHidden();
  await page.getByRole('button', { name: /이어 하기/ }).click();
  await expect(page.locator('#chatpane')).toBeVisible();
  await expect(meta(page)).toHaveText(/^2턴 · /);
  await ctx.close();
});

test('API에 닿지 못하면 연결 실패 상태와 다시 연결 버튼이 보이고, 돌아오면 복구된다', async ({ page }) => {
  await page.goto(srv.base);
  await expect(page.getByText('임시 응답(모델 없음)').first()).toBeVisible();
  // 서버가 완전히 없으면 브라우저 자체 오류 페이지라 우리 화면이 없다. 화면이 있는데 API만 실패하는 경우를 라우트 차단으로 재현한다.
  await page.route('**/api/meta', (route) => route.abort());
  await page.reload();
  await expect(page.locator('#connState')).toBeVisible();
  await expect(page.getByText(/서버에 연결하지 못했습니다/).first()).toBeVisible();
  await expect(page.locator('#responderBadge')).toHaveText('서버 연결 실패');
  await page.unroute('**/api/meta');
  await page.getByRole('button', { name: '다시 연결' }).click();
  await expect(page.locator('#connState')).toBeHidden();
  await expect(page.locator('#responderBadge')).toHaveText('임시 응답(모델 없음)');
});

test('가져오기: 내보낸 파일은 별도 채팅으로 복원되고, 손상 파일은 줄 번호가 있는 오류로 거부된다', async ({ page }) => {
  await page.goto(srv.base);
  await newChatAndSay(page, '가져오기 전 원본의 말');
  const [source] = await chats();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '내보내기' }).click()]);
  const exported = fs.readFileSync(await download.path(), 'utf8');

  // 정상 파일 가져오기 → 새 채팅이 열리고 '가져온 채팅' 안내, 원본은 그대로 목록에 남는다
  const fileChooser = page.waitForEvent('filechooser');
  await page.locator('#importBtn').click();
  await (await fileChooser).setFiles({ name: 'story.jsonl', mimeType: 'application/x-ndjson', buffer: Buffer.from(exported, 'utf8') });
  await expect(page.getByText(/별도 채팅으로 가져왔습니다\(2턴\)/)).toBeVisible();
  await expect(page.locator('.info', { hasText: '가져온 채팅입니다' })).toBeVisible();
  await expect(meta(page)).toHaveText(/^2턴 · /);
  await expect(page.locator('#chatList [data-chat-id]')).toHaveCount(2);
  const list = await chats();
  const imported = list.find((c) => c.importedFrom);
  expect(imported.importedFrom.originalId).toBe(source.id);
  const onDisk = (id) => fs.readFileSync(path.join(srv.dataDir, 'chats', `${id}.jsonl`), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.type === 'turn');
  expect(onDisk(imported.id)).toEqual(onDisk(source.id));
  // 가져온 채팅에 이어 쓰면 원본은 변하지 않는다
  await page.locator('#input').fill('가져온 쪽에서 이어 쓴 말');
  await page.locator('#input').press('Enter');
  await expect(botMsgs(page)).toHaveCount(2);
  expect(onDisk(source.id)).toHaveLength(2);

  // 보관된 분기를 내보내 '출처가 없는 곳'에 가져오면: 활성으로 들어오고, 출처 없음을 사실대로 말한다
  await botMsgs(page).first().getByRole('button', { name: '여기서 새 전개' }).click();
  await expect(page.getByText(/2턴까지 복제한 새 채팅입니다/)).toBeVisible();
  await page.getByRole('button', { name: '보관', exact: true }).click();
  await expect(page.getByText(/보관함으로 옮겼습니다/)).toBeVisible();
  const [dl2] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '내보내기' }).click()]);
  const branchExport = fs.readFileSync(await dl2.path(), 'utf8').replace(/"chatId":"chat-[^"]+"/, '"chatId":"chat-not-here-000"');
  const chooser3 = page.waitForEvent('filechooser');
  await page.locator('#importBtn').click();
  await (await chooser3).setFiles({ name: 'branch.jsonl', mimeType: 'application/x-ndjson', buffer: Buffer.from(branchExport, 'utf8') });
  await expect(page.getByText(/내보낼 때는 보관 상태였지만 활성으로 가져왔습니다/)).toBeVisible();
  await expect(page.locator('#input')).toBeEnabled();
  await expect(page.locator('.info', { hasText: '출처 채팅(id chat-not-here-000)은 이 컴퓨터에 없습니다' })).toBeVisible();
  await expect(page.getByRole('button', { name: '출처 채팅 열기' })).toHaveCount(0);

  // 손상 파일: 작품 id가 없는 것으로 바뀌고 둘째 턴 줄이 깨졌다
  const broken = exported.replace('"workId":"lighthouse-apprentice"', '"workId":"unknown-work"').replace(/\n[^\n]*\n$/, '\n{"type":"turn","id":"zz","role":"assistant"\n');
  const chooser2 = page.waitForEvent('filechooser');
  await page.locator('#importBtn').click();
  await (await chooser2).setFiles({ name: 'broken.jsonl', mimeType: 'text/plain', buffer: Buffer.from(broken, 'utf8') });
  const errors = page.locator('#importErrors');
  await expect(errors).toBeVisible();
  await expect(errors).toContainText("'broken.jsonl'을(를) 가져올 수 없습니다. 아무것도 저장하지 않았습니다.");
  await expect(errors.getByText(/1번째 줄: 이 작품이 설치돼 있지 않습니다: unknown-work/)).toBeVisible();
  await expect(errors.getByText(/3번째 줄: JSON으로 읽을 수 없는 줄입니다/)).toBeVisible();
  await expect(page.locator('#chatList [data-chat-id]')).toHaveCount(3); // 손상 파일로는 새 채팅이 생기지 않았다(활성 3 + 보관 1)
  expect((await chats()).length).toBe(4);
  await errors.getByRole('button', { name: '닫기' }).click();
  await expect(errors).toBeHidden();
});
