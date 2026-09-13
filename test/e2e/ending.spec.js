'use strict';
// 완결: 대본이 끝나면 엔딩 장면으로 이야기가 닫히고, 다음에 할 일(다른 시작 / 처음부터 읽기)이 보인다.
const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');
const { startServer } = require('./server-fixture');

let srv;
test.beforeEach(async () => { srv = await startServer(); });
test.afterEach(async () => { await srv.stop(); });
const botMsgs = (page) => page.locator('[data-role="assistant"]');
async function chats() { return (await (await fetch(`${srv.base}/api/chats`)).json()).chats; }
async function say(page, text) { await page.locator('#input').fill(text); await page.locator('#input').press('Enter'); }

test('대본 끝 → 엔딩 장면 · 끝 블록 · 입력 잠금 · 목록 태그, 다른 시작은 다른 엔딩', async ({ page }) => {
  await page.goto(srv.base);
  await page.locator('#startOptions label').nth(2).click(); // 한 달 뒤 · 첫 홀로 밤 근무(대본 5줄)
  await page.getByRole('button', { name: '새 채팅 시작' }).click();
  await expect(page.getByText('새 채팅을 만들고 저장했습니다.')).toBeVisible();
  // 끝을 향한 단서가 플레이 가이드에 보인다(사용자 전용)
  await expect(page.locator('#guideHint')).toContainText('끝을 향한 단서');
  for (let i = 0; i < 5; i += 1) { await say(page, `${i + 1}번째 말`); await expect(botMsgs(page)).toHaveCount(i + 1); }
  await expect(page.locator('.endingblock')).toHaveCount(0); // 아직 끝나지 않았다
  await say(page, '이제 아침이네요');
  await expect(botMsgs(page)).toHaveCount(6);
  // 엔딩 장면과 끝 블록
  const ending = botMsgs(page).nth(5);
  await expect(ending).toHaveClass(/endingturn/);
  await expect(ending).toContainText('동이 트자 안개가');
  await expect(ending).not.toContainText('기록된 대사가 끝났습니다'); // 구현 사정이 대사에 섞이지 않는다
  const block = page.locator('.endingblock');
  await expect(block).toBeVisible();
  await expect(block.locator('.endtitle')).toHaveText('이야기의 끝 · 혼자 지킨 밤');
  await expect(block).toContainText('총 12턴');
  // 입력 잠금과 안내
  await expect(page.locator('#input')).toBeDisabled();
  await expect(page.locator('#input')).toHaveAttribute('placeholder', /이 이야기는 끝났습니다/);
  await expect(page.getByRole('button', { name: '보내기', exact: true })).toBeDisabled();
  await expect(page.locator('#guideHint')).toBeHidden(); // 끝난 뒤에는 단서를 감춘다
  // 목록 태그
  const [chat] = await chats();
  expect(chat.ended).toBe(true);
  await expect(page.locator(`[data-chat-id="${chat.id}"] .tag`, { hasText: '끝 · 혼자 지킨 밤' })).toBeVisible();
  const turns = fs.readFileSync(path.join(srv.dataDir, 'chats', `${chat.id}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.type === 'turn');
  expect(turns.at(-1).ending).toBe('혼자 지킨 밤');
  // 서버도 막는다
  const blocked = await page.request.post(`${srv.base}/api/chats/${chat.id}/turns`, { data: { text: '더 쓰기' } });
  expect(blocked.status()).toBe(409);
  // 다음 행동: 다른 시작으로
  await block.getByRole('button', { name: '다른 시작으로 새 채팅' }).click();
  await expect(page.getByText(/다른 시작 설정을 골랐습니다/)).toBeVisible();
  await page.getByRole('button', { name: '새 채팅 시작' }).click();
  await expect(page.getByText('새 채팅을 만들고 저장했습니다.')).toBeVisible();
  await expect(page.locator('#input')).toBeEnabled();
  await expect(page.locator('.scene')).toContainText('폭풍이 몰려오는 저녁'); // 첫 밤 시작
  // 이 시작의 엔딩은 다른 이름이다
  for (let i = 0; i < 9; i += 1) await say(page, `말 ${i}`);
  await expect(page.locator('.endingblock .endtitle')).toHaveText('이야기의 끝 · 열쇠를 받은 새벽');
});

test('엔딩이 없는 작품은 예비 문장을 보이고 끝나지 않으며, 그 문장이 준비된 것임을 말풍선 밖에서 알린다', async ({ page }) => {
  const { writeWork } = require('../helpers');
  writeWork(srv.dataDir, 'no-ending', { title: '엔딩 없는 작품', character: { name: '을' }, opening: '시작 장면', script: ['한 줄'], fallback: '을은 말이 없다.' });
  await page.goto(srv.base);
  await page.locator('#workList').getByRole('button', { name: '엔딩 없는 작품' }).click();
  await page.getByRole('button', { name: '새 채팅 시작' }).click();
  await say(page, '첫 말');
  await expect(botMsgs(page)).toHaveCount(1);
  await say(page, '둘째 말');
  await expect(botMsgs(page)).toHaveCount(2);
  await expect(botMsgs(page).nth(1)).toContainText('을은 말이 없다.');
  await expect(botMsgs(page).nth(1).locator('.aside')).toHaveText('작품에 적힌 대사가 끝나 준비된 마무리 문장입니다.');
  await expect(page.locator('.endingblock')).toHaveCount(0);
  await expect(page.locator('#input')).toBeEnabled(); // 계속 쓸 수 있다
});
