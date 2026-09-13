'use strict';
// 표시한 장면: 표시 → 닫기/다시 열기 → 지난 이야기에서 원문으로 → 다음 입력. 분기 승계·저장 실패 보존까지 실제 브라우저로.
const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');
const { startServer } = require('./server-fixture');

let srv;
test.beforeEach(async () => { srv = await startServer(); });
test.afterEach(async () => { await srv.stop(); });

const userMsgs = (page) => page.locator('[data-role="user"]');
const botMsgs = (page) => page.locator('[data-role="assistant"]');
async function chats() { return (await (await fetch(`${srv.base}/api/chats`)).json()).chats; }
function marksOnDisk(chatId) {
  return fs.readFileSync(path.join(srv.dataDir, 'chats', `${chatId}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.type === 'mark');
}
async function say(page, text) { await page.locator('#input').fill(text); await page.locator('#input').press('Enter'); }

test('표시 → 브라우저 닫기 → 다시 열기 → 지난 이야기에서 원문으로 → 이어 쓰기, 해제도 반영', async ({ browser }) => {
  const ctx1 = await browser.newContext();
  const page = await ctx1.newPage();
  await page.goto(srv.base);
  await page.getByRole('button', { name: '새 채팅 시작' }).click();
  await expect(page.getByText('새 채팅을 만들고 저장했습니다.')).toBeVisible();
  await say(page, '이름은 진이에요');
  await expect(botMsgs(page)).toHaveCount(1);
  await say(page, '바람 소리가 무서워요');
  await expect(botMsgs(page)).toHaveCount(2);
  await say(page, '옛날 얘기 하나만 해주세요');
  await expect(botMsgs(page)).toHaveCount(3);
  await expect(page.locator('#recap')).toBeVisible();
  await expect(page.locator('#recapMarks')).toHaveText(''); // 표시 없으면 목록 없음
  // 첫 캐릭터 말과 셋째 캐릭터 말을 표시
  await botMsgs(page).nth(0).getByRole('button', { name: '장면 표시' }).click();
  await expect(page.getByText(/장면을 표시했습니다/)).toBeVisible();
  await expect(botMsgs(page).nth(0)).toHaveClass(/marked/);
  await expect(botMsgs(page).nth(0).locator('.marktag')).toHaveText('표시한 장면');
  await botMsgs(page).nth(2).getByRole('button', { name: '장면 표시' }).click();
  await expect(botMsgs(page).nth(2)).toHaveClass(/marked/);
  const [chat] = await chats();
  expect(marksOnDisk(chat.id).map((m) => m.marked)).toEqual([true, true]);
  await ctx1.close();
  await srv.restart();

  const ctx2 = await browser.newContext();
  const page2 = await ctx2.newPage();
  await page2.goto(srv.base);
  const resume = page2.getByRole('button', { name: /이어 하기/ });
  await expect(resume.locator('.tag', { hasText: '표시 2' })).toBeVisible(); // 목록에서 표시 수
  await resume.click();
  const recap = page2.locator('#recap');
  await expect(recap).toBeVisible();
  await expect(recap).toBeInViewport(); // 다시 열었을 때 스크롤 없이 바로 보여야 한다(입력창 포커스에 밀리지 않음)
  await expect(recap).toHaveAttribute('open', ''); // 표시가 있으면 펼친 채 열림
  await expect(page2.locator('#recapMarks li').first()).toBeInViewport();
  await expect(page2.locator('#recapSummary')).toContainText('6턴 · 표시한 장면 2개');
  await expect(page2.locator('.recapnote')).toContainText('요약이나 캐릭터의 기억이 아닙니다');
  // 마지막 발화 두 줄: 발화자 보존·원문 인용
  await expect(page2.locator('#recapLast .line').nth(0)).toContainText('나:');
  await expect(page2.locator('#recapLast .line').nth(0)).toContainText('옛날 얘기 하나만 해주세요');
  await expect(page2.locator('#recapLast .line').nth(1)).toContainText('해원:');
  await expect(page2.locator('#recapLast .line').nth(1)).toContainText('폭풍 밤에 배 한 척');
  // 표시한 장면 목록: 원문 순서, 발화자, 발췌
  const items = page2.locator('#recapMarks li');
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toContainText('해원:');
  await expect(items.nth(0)).toContainText('이름은 됐다');
  await expect(items.nth(1)).toContainText('폭풍 밤에 배 한 척');
  // 원문으로 → 해당 말풍선이 강조된다
  await items.nth(0).getByRole('button', { name: '원문으로' }).click();
  await expect(botMsgs(page2).nth(0)).toHaveClass(/flash/);
  // 다음 입력이 정상으로 이어진다
  await say(page2, '표시를 보고 이어 씁니다');
  await expect(botMsgs(page2)).toHaveCount(4);
  await expect(page2.locator('#recapSummary')).toContainText('8턴 · 표시한 장면 2개');
  // 해제 → 목록·태그·파일 반영, 원문은 그대로
  await botMsgs(page2).nth(0).getByRole('button', { name: '표시 해제' }).click();
  await expect(page2.getByText(/장면 표시를 해제했습니다/)).toBeVisible();
  await expect(items).toHaveCount(1);
  await expect(botMsgs(page2).nth(0)).not.toHaveClass(/marked/);
  await expect(botMsgs(page2).nth(0)).toContainText('이름은 됐다');
  expect(marksOnDisk(chat.id).map((m) => [m.marked])).toEqual([[true], [true], [false]]);
  await ctx2.close();
});

test('분기는 복제 턴의 유효 표시만 이어받고, 저장 실패 시 표시된 것처럼 보이지 않는다', async ({ page }) => {
  await page.goto(srv.base);
  await page.getByRole('button', { name: '새 채팅 시작' }).click();
  await expect(page.getByText('새 채팅을 만들고 저장했습니다.')).toBeVisible();
  await say(page, '첫 말'); await expect(botMsgs(page)).toHaveCount(1);
  await say(page, '둘째 말'); await expect(botMsgs(page)).toHaveCount(2);
  // 분기점(첫 캐릭터 말) 뒤의 장면을 먼저 표시하고, 앞 장면은 뒤늦게 표시한다
  await botMsgs(page).nth(1).getByRole('button', { name: '장면 표시' }).click();
  await expect(botMsgs(page).nth(1)).toHaveClass(/marked/);
  await userMsgs(page).nth(0).getByRole('button', { name: '장면 표시' }).click();
  await expect(userMsgs(page).nth(0)).toHaveClass(/marked/);
  const [source] = await chats();
  await botMsgs(page).nth(0).getByRole('button', { name: '여기서 새 전개' }).click();
  await expect(page.getByText(/2턴까지 복제한 새 채팅입니다/)).toBeVisible();
  // 자식: 앞 장면 표시만 따라왔고(뒤늦게 표시했어도), 분기점 뒤 표시는 없다
  await expect(userMsgs(page).nth(0)).toHaveClass(/marked/);
  await expect(page.locator('#recapMarks li')).toHaveCount(1);
  await expect(page.locator('#recapMarks li').nth(0)).toContainText('첫 말');
  const branch = (await chats()).find((c) => c.branchOf);
  expect(marksOnDisk(branch.id).map((m) => [m.marked, m.carriedFrom === source.id])).toEqual([[true, true]]);
  // 자식에서 해제해도 부모는 그대로
  await userMsgs(page).nth(0).getByRole('button', { name: '표시 해제' }).click();
  await expect(page.locator('#recapMarks li')).toHaveCount(0);
  const parent = await (await fetch(`${srv.base}/api/chats/${source.id}`)).json();
  expect(parent.chat.marks.length).toBe(2);
  // 저장 실패(요청이 서버에 닿지 않음): 서버 상태를 다시 읽어 '저장되지 않았다'로 수렴, 표시된 것처럼 보이지 않고 원문·기존 표시 그대로
  await page.route('**/api/chats/*/marks', (route) => route.abort());
  await botMsgs(page).nth(0).getByRole('button', { name: '장면 표시' }).click();
  await expect(page.getByText(/장면 표시가 저장되지 않았습니다. 다시 눌러 주세요/)).toBeVisible();
  await expect(botMsgs(page).nth(0)).not.toHaveClass(/marked/);
  await expect(botMsgs(page).nth(0).getByRole('button', { name: '장면 표시' })).toBeVisible();
  await expect(botMsgs(page).nth(0)).toContainText('이름은 됐다');
  expect(marksOnDisk(branch.id).length).toBe(2); // 승계 1 + 해제 1, 실패한 표시는 기록되지 않음
  await page.unroute('**/api/chats/*/marks');
});

test('실패 안내는 실제 근거대로: 응답 소실은 저장을 다시 확인해 수렴, 목록 갱신 실패는 저장 실패가 아니다, 확인 불가는 미확정', async ({ page }) => {
  await page.goto(srv.base);
  await page.getByRole('button', { name: '새 채팅 시작' }).click();
  await expect(page.getByText('새 채팅을 만들고 저장했습니다.')).toBeVisible();
  await say(page, '합성 표시 저장 확인'); await expect(botMsgs(page)).toHaveCount(1);
  const [chat] = await chats();
  const serverMarks = async () => (await (await fetch(`${srv.base}/api/chats/${chat.id}`)).json()).chat.marks.length;

  // 1) 서버는 저장(200)했지만 브라우저로 오는 응답만 끊긴다 → 다시 읽어 '저장됨'으로 수렴하고 화면에 표시가 보인다
  await page.route('**/api/chats/*/marks', async (route) => { await route.fetch(); await route.abort(); });
  await botMsgs(page).nth(0).getByRole('button', { name: '장면 표시' }).click();
  await expect(page.getByText(/장면을 표시했습니다.*응답이 불확실해 서버 상태를 다시 확인했습니다/)).toBeVisible();
  await expect(botMsgs(page).nth(0)).toHaveClass(/marked/);
  expect(await serverMarks()).toBe(1);
  await page.unroute('**/api/chats/*/marks');

  // 2) 해제 POST는 정상, 뒤따르는 목록 GET만 실패 → 해제는 적용됐다고 말하고 목록 갱신 실패만 따로 알린다
  await page.route('**/api/chats?work=*', (route) => route.abort());
  await botMsgs(page).nth(0).getByRole('button', { name: '표시 해제' }).click();
  await expect(page.getByText(/장면 표시를 해제했습니다.*채팅 목록을 갱신하지 못해/)).toBeVisible();
  await expect(page.getByText(/저장하지 않았습니다|저장되지 않았습니다/)).toHaveCount(0);
  await expect(botMsgs(page).nth(0)).not.toHaveClass(/marked/);
  expect(await serverMarks()).toBe(0);
  await page.unroute('**/api/chats?work=*');

  // 3) 응답도 끊기고 재확인 GET도 실패 → 미확정으로 표시하고 단정하지 않는다. 다시 열면 실제 상태(저장됨)로 맞춰진다
  await page.route('**/api/chats/*/marks', async (route) => { await route.fetch(); await route.abort(); });
  await page.route(`**/api/chats/${chat.id}`, (route) => route.abort());
  await botMsgs(page).nth(0).getByRole('button', { name: '장면 표시' }).click();
  await expect(page.getByText(/저장됐는지 확인하지 못했습니다.*마지막으로 확인된 상태.*다시 열면 실제 저장 상태로/)).toBeVisible();
  await expect(botMsgs(page).nth(0)).not.toHaveClass(/marked/); // 마지막으로 확인된 화면(표시 없음) 그대로, 저장됐다고도 안 됐다고도 하지 않음
  expect(await serverMarks()).toBe(1); // 실제로는 저장됨
  await page.unroute('**/api/chats/*/marks');
  await page.unroute(`**/api/chats/${chat.id}`);
  await page.reload();
  await expect(page.getByText(/저장된 채팅을 다시 열었습니다/)).toBeVisible();
  await expect(botMsgs(page).nth(0)).toHaveClass(/marked/); // 재열기에서 실제 저장 상태로 수렴
  await expect(page.locator('#recapMarks li')).toHaveCount(1);
});

test('5xx는 저장 여부를 확정할 수 없는 응답이다: 저장 뒤 500이면 재확인으로 저장됨에 수렴하고 목록도 갱신, 4xx 거부만 저장 안 됨으로 단정', async ({ page }) => {
  await page.goto(srv.base);
  await page.getByRole('button', { name: '새 채팅 시작' }).click();
  await expect(page.getByText('새 채팅을 만들고 저장했습니다.')).toBeVisible();
  await say(page, '합성 500 확인'); await expect(botMsgs(page)).toHaveCount(1);
  const [chat] = await chats();
  const serverMarks = async () => (await (await fetch(`${srv.base}/api/chats/${chat.id}`)).json()).chat.marks.length;

  // 1) 서버는 저장했지만(요청을 실제로 통과시킴) 브라우저에는 500 INTERNAL이 돌아온다(저장 뒤 읽기 실패 주입과 같은 형태)
  await page.route('**/api/chats/*/marks', async (route) => {
    await route.fetch();
    await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'INTERNAL', message: '서버 내부 오류' } }) });
  });
  await botMsgs(page).nth(0).getByRole('button', { name: '장면 표시' }).click();
  await expect(page.getByText(/장면을 표시했습니다.*응답이 불확실해 서버 상태를 다시 확인했습니다/)).toBeVisible();
  await expect(page.getByText(/저장하지 않았습니다/)).toHaveCount(0);
  await expect(botMsgs(page).nth(0)).toHaveClass(/marked/);
  await expect(page.locator(`[data-chat-id="${chat.id}"] .tag`, { hasText: '표시 1' })).toBeVisible(); // 재확인 뒤에도 목록이 갱신된다
  expect(await serverMarks()).toBe(1);
  await page.unroute('**/api/chats/*/marks');

  // 2) 500 + 재확인 GET도 실패 → 미확정(단정 없음), 다시 열면 실제 상태로 수렴
  await page.route('**/api/chats/*/marks', async (route) => {
    await route.fetch();
    await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'INTERNAL', message: '서버 내부 오류' } }) });
  });
  await page.route(`**/api/chats/${chat.id}`, (route) => route.abort());
  await botMsgs(page).nth(0).getByRole('button', { name: '표시 해제' }).click();
  await expect(page.getByText(/저장됐는지 확인하지 못했습니다.*마지막으로 확인된 상태/)).toBeVisible();
  await expect(botMsgs(page).nth(0)).toHaveClass(/marked/); // 마지막으로 확인된 화면 그대로(해제됐다고 단정하지 않음)
  expect(await serverMarks()).toBe(0); // 실제로는 해제됨
  await page.unroute('**/api/chats/*/marks');
  await page.unroute(`**/api/chats/${chat.id}`);
  await page.reload();
  await expect(page.getByText(/저장된 채팅을 다시 열었습니다/)).toBeVisible();
  await expect(botMsgs(page).nth(0)).not.toHaveClass(/marked/);

  // 3) 명확한 거부(4xx)는 그대로 '저장하지 않았습니다': 보관된 채팅에서 표시 시도 → 409
  await page.getByRole('button', { name: '보관', exact: true }).click();
  await expect(page.getByText(/보관함으로 옮겼습니다/)).toBeVisible();
  const res = await page.request.post(`${srv.base}/api/chats/${chat.id}/marks`, { data: { turnId: (await (await fetch(`${srv.base}/api/chats/${chat.id}`)).json()).chat.turns[1].id, marked: true } });
  expect(res.status()).toBe(409);
  expect(await serverMarks()).toBe(0);
  // 화면 경로: 없는 턴을 가리키는 요청으로 404를 만들어 문장 확인(보관 중엔 버튼이 비활성이라 API로 유도)
  await page.locator('#archiveBtn').click(); // 헤더의 '복구'(보관함 목록에도 '복구'가 있어 헤더 버튼을 지정)
  await expect(page.getByText(/복구했습니다/)).toBeVisible();
  await page.route('**/api/chats/*/marks', (route) => route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: { code: 'NOT_FOUND', message: '이 채팅에 그 턴이 없습니다' } }) }));
  await botMsgs(page).nth(0).getByRole('button', { name: '장면 표시' }).click();
  await expect(page.getByText(/장면 표시를 저장하지 않았습니다: 이 채팅에 그 턴이 없습니다/)).toBeVisible();
  await expect(botMsgs(page).nth(0)).not.toHaveClass(/marked/);
  await page.unroute('**/api/chats/*/marks');
});
