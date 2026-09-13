'use strict';
// 느린 응답기(통제 실험)로 pending 중 화면 전환·두 탭 동시 요청·새로고침 중 늦은 응답이
// 엉뚱한 채팅이나 중복 턴을 만들지 않는지 실제 브라우저로 확인한다. 실제 LLM·강제 종료 내구성은 아니다.
const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');
const { startServer } = require('./server-fixture');

const DELAY = 1500;
const userMsgs = (page) => page.locator('[data-role="user"]');
const botMsgs = (page) => page.locator('[data-role="assistant"]');
const meta = (page) => page.locator('#chatMeta');

let srv;
test.beforeEach(async () => { srv = await startServer({ delayMs: DELAY }); });
test.afterEach(async () => { await srv.stop(); });

function turnsOnDisk(chatId) {
  const file = path.join(srv.dataDir, 'chats', `${chatId}.jsonl`);
  return fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((l) => l.type === 'turn');
}
async function chatIds() {
  const res = await (await fetch(`${srv.base}/api/chats`)).json();
  return res.chats.map((c) => c.id);
}
async function newChatViaUI(page) {
  await page.getByRole('button', { name: '새 채팅 시작' }).click();
  await expect(page.getByText('새 채팅을 만들고 저장했습니다.')).toBeVisible();
}

test('느린 응답 중에는 전환·전송이 막히고, 응답은 원래 채팅에만 저장된다', async ({ page }) => {
  await page.goto(srv.base);
  await expect(page.getByText('임시 응답(모델 없음)').first()).toBeVisible();
  await newChatViaUI(page); // 채팅 B (비워 둔다)
  const [idB] = await chatIds();
  await newChatViaUI(page); // 채팅 A (활성)
  const idA = (await chatIds()).find((id) => id !== idB);

  const input = page.getByRole('textbox');
  await input.fill('느린 응답 기다리는 중');
  await input.press('Enter');
  await expect(page.getByText('입력 저장·응답 요청 중…')).toBeVisible();
  await expect(page.getByRole('button', { name: '보내기', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '새 채팅 시작' })).toBeDisabled();
  await expect(input).toBeDisabled();

  // 기다리는 동안 저장된 채팅 B를 눌러 전환을 시도한다
  await expect(page.getByRole('button', { name: /이어 하기/ })).toHaveCount(2);
  const buttonB = page.locator(`[data-chat-id="${idB}"]`);
  await buttonB.click();
  await expect(page.getByText(/처리 중에는 다른 채팅으로 바꿀 수 없습니다/)).toBeVisible();

  // 응답이 도착하면 A 화면에 그대로 붙고, B는 비어 있어야 한다
  await expect(botMsgs(page)).toHaveCount(1, { timeout: DELAY + 5000 });
  await expect(botMsgs(page).first()).toBeVisible();
  await expect(meta(page)).toHaveText(/^2턴 · /);
  await expect(page.getByText(/^저장됨/)).toBeVisible();
  await expect(input).toBeEnabled();
  expect(turnsOnDisk(idA).map((t) => t.role)).toEqual(['user', 'assistant']);
  expect(turnsOnDisk(idB)).toEqual([]);

  // 이제 전환이 되고 B는 0턴이다
  await buttonB.click();
  await expect(page.getByText(/저장된 채팅을 다시 열었습니다/)).toBeVisible();
  await expect(meta(page)).toHaveText(/^0턴 · /);
  await expect(userMsgs(page)).toHaveCount(0);
});

test('두 탭이 같은 채팅에 동시에 요청해도 턴은 한 번만 저장된다', async ({ context }) => {
  const page1 = await context.newPage();
  await page1.goto(srv.base);
  await newChatViaUI(page1);
  const [idA] = await chatIds();
  const page2 = await context.newPage();
  await page2.goto(srv.base); // 같은 origin·localStorage → 마지막 채팅 A가 자동으로 열린다
  await expect(page2.getByText(/저장된 채팅을 다시 열었습니다/)).toBeVisible();

  await page1.getByRole('textbox').fill('첫 탭에서 보냄');
  await page1.getByRole('textbox').press('Enter');
  await expect(page1.getByText('입력 저장·응답 요청 중…')).toBeVisible();

  // 둘째 탭: 응답 대기 중 새 입력 → 서버가 409로 막고, 화면은 '실패'가 아니라 '만드는 중'을 보여준다
  await page2.getByRole('textbox').fill('둘째 탭에서 보냄');
  await page2.getByRole('textbox').press('Enter');
  await expect(page2.getByText(/이전 입력의 응답이 아직 없습니다/)).toBeVisible();
  await expect(page2.locator('#pendingBox')).toBeVisible();
  await expect(page2.locator('#pendingText')).toHaveText(/응답을 만드는 중입니다/);
  await expect(page2.getByRole('button', { name: '다시 생성' })).toBeHidden(); // 처리 중엔 중복 생성 버튼을 주지 않는다
  await expect(userMsgs(page2)).toHaveCount(1);
  await expect(userMsgs(page2).first()).toContainText('첫 탭에서 보냄');

  // 첫 탭에 응답이 도착하고, 둘째 탭은 아무것도 누르지 않아도 자동 확인으로 따라온다
  await expect(botMsgs(page1)).toHaveCount(1, { timeout: DELAY + 5000 });
  await expect(meta(page1)).toHaveText(/^2턴 · /);
  await expect(page1.getByText(/^저장됨/)).toBeVisible();
  await expect(botMsgs(page2)).toHaveCount(1, { timeout: 5000 });
  await expect(page2.getByText(/응답이 도착해 저장됐습니다/)).toBeVisible();
  await expect(page2.locator('#pendingBox')).toBeHidden();
  await expect(meta(page2)).toHaveText(/^2턴 · /);
  // 둘째 탭에서 이어 보내면 3·4번째 턴이 되고 중복은 없다
  await page2.getByRole('textbox').fill('둘째 탭에서 이어감');
  await page2.getByRole('textbox').press('Enter');
  await expect(botMsgs(page2)).toHaveCount(2, { timeout: DELAY + 5000 });

  await new Promise((r) => setTimeout(r, 300));
  expect(turnsOnDisk(idA).map((t) => t.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  expect(turnsOnDisk(idA)[0].text).toBe('첫 탭에서 보냄');
  expect(turnsOnDisk(idA)[2].text).toBe('둘째 탭에서 이어감');
});

test('응답을 기다리다 새로고침해도 늦게 온 응답이 유실·중복되지 않는다', async ({ page }) => {
  await page.goto(srv.base);
  await newChatViaUI(page);
  const [idA] = await chatIds();
  await page.getByRole('textbox').fill('새로고침 전에 보냄');
  await page.getByRole('textbox').press('Enter');
  await expect(page.getByText('입력 저장·응답 요청 중…')).toBeVisible();
  await page.reload(); // 응답 도착 전 새로고침
  await expect(page.getByText(/저장된 채팅을 다시 열었습니다/)).toBeVisible();
  await expect(userMsgs(page)).toHaveCount(1);
  await expect(page.locator('#pendingBox')).toBeVisible(); // 서버는 아직 응답 중
  await expect(page.locator('#pendingText')).toHaveText(/응답을 만드는 중입니다/); // 거짓 '실패'가 아니어야 한다
  await expect(page.getByRole('button', { name: '다시 생성' })).toBeHidden();

  // 아무것도 누르지 않아도 늦게 온 응답이 자동 확인으로 나타난다
  await expect(botMsgs(page)).toHaveCount(1, { timeout: DELAY + 5000 });
  await expect(page.getByText(/응답이 도착해 저장됐습니다/)).toBeVisible();
  await expect(page.locator('#pendingBox')).toBeHidden();
  await expect(meta(page)).toHaveText(/^2턴 · /);
  await new Promise((r) => setTimeout(r, 300));
  expect(turnsOnDisk(idA).map((t) => t.role)).toEqual(['user', 'assistant']);
});
