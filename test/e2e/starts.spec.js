'use strict';
// 시작 설정 고르기: 여러 시작이 있는 작품에서 고른 시작의 프롤로그·추천 답변·대본으로 채팅이 시작되고, 다시 열어도 그 시작이 유지된다.
const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');
const { startServer } = require('./server-fixture');

let srv;
test.beforeEach(async () => { srv = await startServer(); });
test.afterEach(async () => { await srv.stop(); });
const botMsgs = (page) => page.locator('[data-role="assistant"]');

test('시작 설정을 골라 새 채팅 → 그 시작의 장면·추천·대사 → 목록 태그 → 다시 열어도 유지', async ({ page }) => {
  await page.goto(srv.base);
  const picker = page.locator('#startPicker');
  await expect(picker).toBeVisible();
  const options = page.locator('#startOptions label');
  await expect(options).toHaveCount(3);
  await expect(options.nth(0)).toHaveClass(/selected/); // 기본은 첫 시작
  await expect(options.nth(1)).toContainText('폭풍 다음 날 아침');
  await expect(options.nth(1)).toContainText('열쇠 약속을 말하지 않는다'); // 상황 한 줄
  await options.nth(1).click();
  await expect(options.nth(1)).toHaveClass(/selected/);
  await page.getByRole('button', { name: '새 채팅 시작' }).click();
  await expect(page.getByText('새 채팅을 만들고 저장했습니다.')).toBeVisible();
  // 고른 시작의 장면·추천 답변·헤더
  await expect(page.locator('.scene')).toContainText('폭풍이 지나간 아침');
  await expect(page.locator('.scene .who')).toContainText('폭풍 다음 날 아침');
  await expect(page.locator('#chatTitle')).toContainText('폭풍 다음 날 아침');
  const chips = page.locator('#starterChips button');
  await expect(chips).toHaveCount(3);
  await expect(chips.nth(0)).toHaveText('어젯밤 말씀하신 열쇠… 아직 유효한가요?');
  await chips.nth(0).click();
  await page.locator('#input').press('Enter');
  await expect(botMsgs(page)).toHaveCount(1);
  await expect(botMsgs(page).first()).toContainText('열쇠는 아침에 주는 물건이 아니다'); // 그 시작의 대본
  // 목록에 시작 이름 태그
  const list = (await (await fetch(`${srv.base}/api/chats`)).json()).chats;
  await expect(page.locator(`[data-chat-id="${list[0].id}"] .tag`, { hasText: '폭풍 다음 날 아침' })).toBeVisible();
  const meta = JSON.parse(fs.readFileSync(path.join(srv.dataDir, 'chats', `${list[0].id}.jsonl`), 'utf8').split('\n')[0]);
  expect(meta.startId).toBe('morning-after');
  // 다시 열어도 같은 시작
  await page.reload();
  await expect(page.getByText(/저장된 채팅을 다시 열었습니다/)).toBeVisible();
  await expect(page.locator('.scene')).toContainText('폭풍이 지나간 아침');
  await expect(page.locator('#chatTitle')).toContainText('폭풍 다음 날 아침');
  // 다른 시작으로 새 채팅을 만들면 서로 다른 장면
  await options.nth(2).click();
  await page.getByRole('button', { name: '새 채팅 시작' }).click();
  await expect(page.getByText('새 채팅을 만들고 저장했습니다.')).toBeVisible();
  await expect(page.locator('.scene')).toContainText('한 달이 지났다');
  await expect(page.locator('#starterChips button').nth(0)).toContainText('안개가 짙어지는데');
});

test('시작 설정이 하나뿐인 작품은 고르기가 보이지 않는다', async ({ page }) => {
  const { writeWork } = require('../helpers');
  writeWork(srv.dataDir, 'single', { title: '단일 시작', character: { name: '을' }, opening: '한 가지 시작', script: ['답 하나'] });
  await page.goto(srv.base);
  await page.locator('#workList').getByRole('button', { name: '단일 시작' }).click();
  await expect(page.locator('#startPicker')).toBeHidden();
  await expect(page.getByRole('button', { name: '새 채팅 시작' })).toBeVisible();
  await page.getByRole('button', { name: '새 채팅 시작' }).click();
  await expect(page.locator('.scene')).toContainText('한 가지 시작');
  await expect(page.locator('#chatTitle')).not.toContainText('기본 시작'); // 하나뿐이면 이름을 덧붙이지 않는다
});
