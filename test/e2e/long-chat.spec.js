'use strict';
// 긴 채팅 훑어보기: 표시한 장면을 찾아 원문을 읽고 최근 대화로 돌아온다. 데스크톱과 모바일 폭에서, 엔딩 없는 합성 작품(80턴)으로.
const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');
const { startServer } = require('./server-fixture');

let srv;
let chatId;
test.beforeEach(async () => {
  srv = await startServer();
  // 엔딩 없는 긴 합성 작품: 대사 60개. 실제 작품·과거 채팅 원문은 쓰지 않는다.
  const script = Array.from({ length: 60 }, (_, i) => `합성 대사 ${i + 1}: 램프 심지를 ${i + 1}번째로 살핀다.`);
  fs.writeFileSync(path.join(srv.dataDir, 'works', 'synthetic-long.json'), JSON.stringify({
    title: '합성 긴 작품', character: { name: '을', description: '합성' },
    starts: [{ id: 'only', name: '하나뿐', opening: '합성 프롤로그', script, fallback: '을은 창밖을 본다.' }],
  }));
  const headers = { 'content-type': 'application/json', origin: srv.base, 'sec-fetch-site': 'same-origin' };
  const created = await (await fetch(`${srv.base}/api/chats`, { method: 'POST', headers, body: JSON.stringify({ workId: 'synthetic-long', startId: 'only' }) })).json();
  chatId = created.chat.id;
  for (let i = 1; i <= 40; i += 1) {
    const r = await fetch(`${srv.base}/api/chats/${chatId}/turns`, { method: 'POST', headers, body: JSON.stringify({ text: `합성 발화 ${i}`, clientTurnId: `c${i}` }) });
    expect(r.status).toBe(200);
  }
  // 6번째 캐릭터 말을 표시해 둔다(저장된 표시 기록)
  const chat = (await (await fetch(`${srv.base}/api/chats/${chatId}`)).json()).chat;
  const sixth = chat.turns.filter((t) => t.role === 'assistant')[5];
  const m = await fetch(`${srv.base}/api/chats/${chatId}/marks`, { method: 'POST', headers, body: JSON.stringify({ turnId: sixth.id, marked: true }) });
  expect(m.status).toBe(200);
});
test.afterEach(async () => { await srv.stop(); });

const botMsgs = (page) => page.locator('[data-role="assistant"]');
async function open(page) {
  await page.goto(srv.base);
  await page.getByRole('button', { name: /합성 긴 작품/ }).click();
  await page.getByRole('button', { name: /이어 하기/ }).click();
  await expect(botMsgs(page)).toHaveCount(40);
}
async function fromBottom(page) {
  return page.locator('#messages').evaluate((b) => b.scrollHeight - b.scrollTop - b.clientHeight);
}

for (const [label, ctxOpts] of [
  ['데스크톱', { viewport: { width: 1280, height: 800 } }],
  ['모바일', { viewport: { width: 390, height: 780 }, isMobile: true, hasTouch: true }],
]) {
  test(`${label}: 다시 열면 마지막 말이 보이고, 원문으로 → 표시한 장면 → 최근 대화로 돌아온다`, async ({ browser }) => {
    const ctx = await browser.newContext(ctxOpts);
    const page = await ctx.newPage();
    await open(page);
    // 다시 열었을 때: 마지막 말이 보이고 '최근 대화로'는 필요 없으니 숨겨져 있다(모바일에서 프롤로그에 멈추던 결함의 반례)
    await expect(botMsgs(page).nth(39)).toBeInViewport();
    await expect(page.locator('#toLatest')).toBeHidden();
    expect(await fromBottom(page)).toBeLessThan(160);
    // 지난 이야기 → 원문으로: 6번째 캐릭터 말이 화면에 오고 강조된다
    await page.locator('#recap').evaluate((d) => { d.open = true; });
    await page.locator('#recapMarks').getByRole('button', { name: '원문으로' }).click();
    await expect(botMsgs(page).nth(5)).toBeInViewport();
    await expect(botMsgs(page).nth(5)).toHaveClass(/flash/);
    await expect(botMsgs(page).nth(5)).toContainText('합성 대사 6');
    await expect(page.getByText(/표시한 장면의 원문으로 갔습니다/)).toBeVisible();
    // 마지막 말은 화면 밖(여러 화면 아래)이고, 돌아갈 길이 보인다
    await expect(botMsgs(page).nth(39)).not.toBeInViewport();
    expect(await fromBottom(page)).toBeGreaterThan(2000);
    const back = page.locator('#toLatest');
    await expect(back).toBeVisible();
    await expect(back).toBeInViewport();
    await back.click();
    await expect(botMsgs(page).nth(39)).toBeInViewport();
    await expect(botMsgs(page).nth(39)).toContainText('합성 대사 40');
    await expect(back).toBeHidden();
    await expect(page.getByText('최근 대화로 돌아왔습니다.')).toBeVisible();
    // 이동은 화면 위치만 바꾼다: 저장된 턴·표시는 그대로
    const lines = fs.readFileSync(path.join(srv.dataDir, 'chats', `${chatId}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.filter((r) => r.type === 'turn').length).toBe(80);
    expect(lines.filter((r) => r.type === 'mark').length).toBe(1);
    // 돌아온 뒤 이어 쓰기가 정상이다
    await page.locator('#input').fill('돌아와서 이어 씁니다');
    await page.locator('#input').press('Enter');
    await expect(botMsgs(page)).toHaveCount(41);
    await expect(botMsgs(page).nth(40)).toBeInViewport();
    await ctx.close();
  });
}

test('손으로 위로 올려도 돌아갈 길이 보이고, 바닥 근처에서는 숨는다', async ({ page }) => {
  await open(page);
  await page.locator('#messages').evaluate((b) => { b.scrollTop = 0; });
  await expect(page.locator('#toLatest')).toBeVisible();
  await page.locator('#messages').evaluate((b) => { b.scrollTop = b.scrollHeight; });
  await expect(page.locator('#toLatest')).toBeHidden();
});
