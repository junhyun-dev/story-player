'use strict';
// 재시동 도움(모델 없음): 빈 채팅의 시작 추천 답변(작품에 적힌 것)과 사용자 전용 플레이 가이드.
const { test, expect } = require('@playwright/test');
const { startServer } = require('./server-fixture');

let srv;
test.beforeEach(async () => { srv = await startServer(); });
test.afterEach(async () => { await srv.stop(); });
const botMsgs = (page) => page.locator('[data-role="assistant"]');

test('빈 채팅에서 추천 답변을 골라 고쳐 보내고, 플레이 가이드는 언제든 펼쳐 본다', async ({ page }) => {
  await page.goto(srv.base);
  await page.getByRole('button', { name: '새 채팅 시작' }).click();
  await expect(page.getByText('새 채팅을 만들고 저장했습니다.')).toBeVisible();
  // 빈 상태: 추천 답변 칩 3개와 안내 문구
  const chips = page.locator('#starterChips button');
  await expect(chips).toHaveCount(3);
  await expect(page.getByText(/시작 추천 답변\(작품에 적힌 것/)).toBeVisible();
  // 플레이 가이드: 사용자 전용임을 밝히고 펼치면 본문이 보인다
  const guide = page.locator('#guide');
  await expect(guide).toBeVisible();
  await expect(guide.locator('summary')).toContainText('해원에게는 전달되지 않습니다');
  await guide.locator('summary').click();
  await expect(page.locator('#guideText')).toBeVisible();
  await expect(page.locator('#guideText')).toContainText('등대 열쇠를 받는 첫 밤');
  // 칩을 누르면 입력창에 들어가고(전송되지 않음) 고쳐서 보낼 수 있다
  await chips.nth(1).click();
  await expect(page.locator('#input')).toHaveValue('문부터 닫을게요. 램프실은 어디죠?');
  await expect(botMsgs(page)).toHaveCount(0);
  await page.locator('#input').fill('문부터 닫을게요. 램프실은 위층인가요?');
  await page.locator('#input').press('Enter');
  await expect(botMsgs(page)).toHaveCount(1);
  await expect(page.locator('[data-role="user"]').first()).toContainText('램프실은 위층인가요?');
  // 대화가 시작되면 시작 추천 답변은 사라지고(대화 중 추천은 모델 필요), 가이드는 남는다
  await expect(page.locator('#starters')).toBeHidden();
  await expect(guide).toBeVisible();
  // 다시 열어도 가이드는 보이고 칩은 없다
  await page.reload();
  await expect(page.getByText(/저장된 채팅을 다시 열었습니다/)).toBeVisible();
  await expect(page.locator('#starters')).toBeHidden();
  await expect(page.locator('#guide')).toBeVisible();
});

test('보관된 빈 채팅에는 추천 답변이 보이지 않는다', async ({ page }) => {
  await page.goto(srv.base);
  await page.getByRole('button', { name: '새 채팅 시작' }).click();
  await expect(page.locator('#starterChips button')).toHaveCount(3);
  await page.getByRole('button', { name: '보관', exact: true }).click();
  await expect(page.getByText(/보관함으로 옮겼습니다/)).toBeVisible();
  await expect(page.locator('#starters')).toBeHidden();
});
