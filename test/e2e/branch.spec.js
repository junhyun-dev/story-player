'use strict';
// 분기(특정 시점부터 새 채팅)의 사용자 결과를 실제 브라우저로 확인한다. 복제 규칙·API 오류는 unit/API가 맡는다.
const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');
const { startServer } = require('./server-fixture');

const userMsgs = (page) => page.locator('[data-role="user"]');
const botMsgs = (page) => page.locator('[data-role="assistant"]');
const meta = (page) => page.locator('#chatMeta');

let srv;
test.beforeEach(async () => { srv = await startServer(); });
test.afterEach(async () => { await srv.stop(); });

function turnsOnDisk(chatId) {
  const file = path.join(srv.dataDir, 'chats', `${chatId}.jsonl`);
  return fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((l) => l.type === 'turn');
}
async function chats() { return (await (await fetch(`${srv.base}/api/chats`)).json()).chats; }
async function say(page, text) {
  await page.getByRole('textbox').fill(text);
  await page.getByRole('textbox').press('Enter');
}

test('첫 응답에서 새 전개 → 복제된 채팅에서 다른 말을 이어 가도 원래 채팅은 그대로', async ({ page }) => {
  await page.goto(srv.base);
  await page.getByRole('button', { name: '새 채팅 시작' }).click();
  await expect(page.getByText('새 채팅을 만들고 저장했습니다.')).toBeVisible();
  await say(page, '이름은 진이에요');
  await expect(botMsgs(page)).toHaveCount(1);
  await say(page, '바람이 무서워요');
  await expect(botMsgs(page)).toHaveCount(2);
  await expect(meta(page)).toHaveText(/^4턴 · /);
  const [source] = await chats();

  // 첫 응답 말풍선의 '여기서 새 전개'
  await botMsgs(page).first().getByRole('button', { name: '여기서 새 전개' }).click();
  await expect(page.getByText(/2턴까지 복제한 새 채팅입니다/)).toBeVisible();
  await expect(page.locator('.info')).toBeVisible();
  await expect(page.locator('.info')).toContainText('2턴까지를 복제해 갈라져 나왔습니다');
  await expect(meta(page)).toHaveText(/^2턴 · /);
  await expect(userMsgs(page)).toHaveCount(1);
  await expect(botMsgs(page)).toHaveCount(1);
  await expect(page.locator('#pendingBox')).toBeHidden();

  // 목록: 두 채팅, 분기 표시
  const list = await chats();
  expect(list).toHaveLength(2);
  const branch = list.find((c) => c.branchOf);
  expect(branch.branchOf.chatId).toBe(source.id);
  await expect(page.locator(`[data-chat-id="${branch.id}"] .tag`, { hasText: '분기' })).toHaveText(/^분기 · 2턴에서/);
  await expect(page.locator(`[data-chat-id="${source.id}"] .tag`, { hasText: '분기' })).toHaveCount(0); // 시작 이름 태그는 있어도 분기 태그는 없다
  await expect(page.locator(`[data-chat-id="${branch.id}"] .preview`)).toHaveText('아직 이어 쓴 말 없음');
  await expect(page.locator(`[data-chat-id="${source.id}"] .preview`)).toHaveText(/^마지막 말: 바람이 무서워요/);
  // 복제 충실도: 분기의 앞 2턴은 출처의 앞 2턴과 필드 단위로 같다(응답기 표시 등이 빠지지 않는다)
  expect(turnsOnDisk(branch.id).slice(0, 2)).toEqual(turnsOnDisk(source.id).slice(0, 2));
  await expect(botMsgs(page).first().locator('.tag')).toHaveText('임시 응답');

  // 분기에서 다른 말을 이어 간다 → 분기 4턴, 출처 4턴 그대로
  await say(page, '사실 저는 바람이 좋아요');
  await expect(botMsgs(page)).toHaveCount(2);
  await expect(botMsgs(page).nth(1)).toBeVisible();
  await expect(meta(page)).toHaveText(/^4턴 · /);
  await expect(page.locator(`[data-chat-id="${branch.id}"] .preview`)).toHaveText(/^다음 말: 사실 저는 바람이 좋아요/);
  await new Promise((r) => setTimeout(r, 300));
  expect(turnsOnDisk(branch.id).map((t) => t.text)[2]).toBe('사실 저는 바람이 좋아요');
  expect(turnsOnDisk(source.id).map((t) => t.text)[2]).toBe('바람이 무서워요');
  expect(turnsOnDisk(source.id)).toHaveLength(4);

  // 출처 채팅 열기 → 원래 4턴
  await page.locator('.info').getByRole('button', { name: '출처 채팅 열기' }).click();
  await expect(page.getByText(/저장된 채팅을 다시 열었습니다/)).toBeVisible();
  await expect(page.locator('.info')).toHaveCount(0);
  await expect(userMsgs(page).nth(1)).toContainText('바람이 무서워요');
  await expect(meta(page)).toHaveText(/^4턴 · /);
});

test('내 말에서 새 전개 → 응답 없는 상태로 열리고 다시 생성으로 이어 간다', async ({ page }) => {
  await page.goto(srv.base);
  await page.getByRole('button', { name: '새 채팅 시작' }).click();
  await expect(page.getByText('새 채팅을 만들고 저장했습니다.')).toBeVisible();
  await say(page, '열쇠를 주세요');
  await expect(botMsgs(page)).toHaveCount(1);
  await userMsgs(page).first().getByRole('button', { name: '여기서 새 전개' }).click();
  await expect(page.getByText(/1턴까지 복제한 새 채팅입니다. 복제된 내 말은 그대로 두고 응답만 새로 만듭니다/)).toBeVisible();
  await expect(userMsgs(page)).toHaveCount(1);
  await expect(botMsgs(page)).toHaveCount(0);
  await expect(page.locator('#pendingBox')).toBeVisible();
  await expect(page.locator('#pendingText')).toHaveText(/아직 응답이 없습니다/);
  await page.getByRole('button', { name: '다시 생성' }).click();
  await expect(botMsgs(page)).toHaveCount(1);
  await expect(page.locator('#pendingBox')).toBeHidden();
  await expect(meta(page)).toHaveText(/^2턴 · /);
  const list = await chats();
  expect(list.map((c) => c.turnCount).sort()).toEqual([2, 2]);
});

test('회복 표시: 잘린 분기 경고, 손상 출처 근거, 분기의 분기에서 출처 열기', async ({ page }) => {
  const { Store } = require('../../lib/store');
  const store = new Store(srv.dataDir);
  const src = store.createChat('lighthouse-apprentice');
  store.appendTurn(src.id, { id: 't1', role: 'user', text: '첫 말', createdAt: new Date().toISOString(), parentId: null });
  store.appendTurn(src.id, { id: 't2', role: 'assistant', text: '둘째', createdAt: new Date().toISOString(), parentId: 't1' });
  fs.appendFileSync(store.chatFile(src.id), '{"type":"turn","id":"t3","role":"user","text":"끊\n'); // 출처 손상 줄
  const br = store.branchChat(src.id, 't2'); // 손상 앞에서 갈라진 분기(근거 보존)
  const br2 = store.branchChat(br.id, 't2'); // 분기의 분기
  const cut = store.branchChat(src.id, 't2'); // 잘린 분기 재현: 복제 턴 하나를 지운다
  const lines = fs.readFileSync(store.chatFile(cut.id), 'utf8').trim().split('\n');
  fs.writeFileSync(store.chatFile(cut.id), lines.slice(0, 2).join('\n') + '\n');

  await page.goto(srv.base);
  await expect(page.locator(`[data-chat-id="${cut.id}"] .flag`, { hasText: '잘린 분기' })).toBeVisible();
  await page.locator(`[data-chat-id="${cut.id}"]`).click();
  await expect(page.getByText(/2턴을 복제했어야 하는데 1턴만 있습니다/)).toBeVisible();

  await page.locator(`[data-chat-id="${br.id}"]`).click();
  await expect(page.locator('.info')).toContainText('출처에 손상 줄이 있었고 손상 앞 구간만 복제했습니다');
  await expect(page.getByText(/줄이 손상돼/)).toHaveCount(0); // 분기 자체는 손상이 없다

  await page.locator(`[data-chat-id="${br2.id}"]`).click();
  await expect(page.locator('.info')).toContainText('2턴까지를 복제해 갈라져 나왔습니다');
  await page.locator('.info').getByRole('button', { name: '출처 채팅 열기' }).click();
  await expect(page.locator(`[data-chat-id="${br.id}"]`)).toHaveClass(/active/); // 바로 위 분기가 열린다
  await expect(page.locator('.info')).toContainText('손상 앞 구간만 복제했습니다');
});
