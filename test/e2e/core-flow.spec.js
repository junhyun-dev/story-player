'use strict';
// 핵심 사용자 결과를 실제 브라우저로 잇는 소수의 E2E. 저장 순서·중복·입력 검증은 unit/API 테스트가 맡는다.
// 오라클 원칙: '보이는가'는 toBeVisible로, 개수는 정확 일치로, 저장 결과는 파일/API를 다시 읽어 대조한다.
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

async function openFreshAndStartChat(page) {
  await page.goto(srv.base);
  await expect(page.getByText('임시 응답(모델 없음)').first()).toBeVisible();
  await page.getByRole('button', { name: '새 채팅 시작' }).click();
  await expect(page.getByText('새 채팅을 만들고 저장했습니다.')).toBeVisible();
  await expect(page.locator('#messages')).toBeVisible();
}

async function say(page, text) {
  const input = page.getByRole('textbox');
  await input.fill(text);
  await input.press('Enter');
}

// 실제 저장 상태를 파일에서 다시 읽는다(늦게 붙는 중복까지 잡기 위한 read-back).
async function savedTurnsOnDisk(settleMs = 300) {
  await new Promise((r) => setTimeout(r, settleMs));
  const dir = path.join(srv.dataDir, 'chats');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  expect(files).toHaveLength(1);
  const lines = fs.readFileSync(path.join(dir, files[0]), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  return lines.filter((l) => l.type === 'turn');
}

test('새 채팅 → 대화 → 브라우저 닫기 → 서버 재시작 → 저장된 채팅에서 이어 하기', async ({ browser }) => {
  const ctx1 = await browser.newContext();
  const page = await ctx1.newPage();
  await openFreshAndStartChat(page);
  await say(page, '이름은 진이에요');
  await expect(userMsgs(page)).toHaveCount(1);
  await expect(userMsgs(page).first()).toBeVisible();
  await expect(botMsgs(page)).toHaveCount(1);
  await expect(botMsgs(page).first()).toBeVisible();
  await expect(botMsgs(page).first()).toContainText('임시 응답');
  await expect(page.getByText(/^저장됨/)).toBeVisible();
  await expect(page.locator('#pendingBox')).toBeHidden(); // 응답 정상일 때 '다시 생성' 상자는 실제로 숨겨져야 한다(회귀)
  await expect(meta(page)).toBeVisible();
  await expect(meta(page)).toHaveText(/^2턴 · /);
  const before = await savedTurnsOnDisk();
  expect(before.map((t) => t.role)).toEqual(['user', 'assistant']);
  await ctx1.close(); // 탭·브라우저 종료(localStorage 폐기)

  await srv.restart(); // in-process 재기동(새 Store·Service·응답기), 같은 데이터 디렉터리

  const ctx2 = await browser.newContext();
  const page2 = await ctx2.newPage();
  await page2.goto(srv.base);
  const resume = page2.getByRole('button', { name: /이어 하기/ });
  await expect(resume).toHaveCount(1);
  await expect(resume).toBeVisible();
  await expect(resume.locator('.turns')).toHaveText(/^2턴/);
  await expect(resume.locator('.preview')).toHaveText(/^마지막 말: 이름은 진이에요/);
  await resume.click();
  await expect(page2.getByText(/저장된 채팅을 다시 열었습니다/)).toBeVisible();
  await expect(page2.locator('#messages')).toBeVisible();
  await expect(userMsgs(page2)).toHaveCount(1);
  await expect(userMsgs(page2).first()).toBeVisible();
  await expect(userMsgs(page2).first()).toContainText('이름은 진이에요');
  await expect(botMsgs(page2).first()).toBeVisible();
  await expect(botMsgs(page2).first()).toContainText('이름은 됐다');
  await say(page2, '바람이 무서워요');
  await expect(botMsgs(page2)).toHaveCount(2);
  await expect(botMsgs(page2).nth(1)).toBeVisible();
  await expect(botMsgs(page2).nth(1)).toContainText('바람 소리에 익숙해지려면');
  await expect(meta(page2)).toHaveText(/^4턴 · /);
  const after = await savedTurnsOnDisk();
  expect(after.map((t) => t.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  expect(after.slice(0, 2).map((t) => t.id)).toEqual(before.map((t) => t.id)); // 재기동 전 턴이 그대로
  await ctx2.close();
});

test('응답 실패 → 상자 표시 → 다시 생성 → 응답이 정확히 한 번 추가되고 상자 숨김', async ({ page }) => {
  await openFreshAndStartChat(page);
  await say(page, '[[실패]] 차 한 잔 주세요');
  await expect(userMsgs(page)).toHaveCount(1);
  await expect(botMsgs(page)).toHaveCount(0);
  await expect(page.locator('#pendingBox')).toBeVisible();
  await expect(page.getByText(/입력은 저장됐지만 응답을 만들지 못했습니다/)).toBeVisible();
  await expect(page.getByRole('button', { name: /이어 하기/ }).locator('.flag')).toHaveText('응답 없음');
  expect((await savedTurnsOnDisk()).map((t) => t.role)).toEqual(['user']);
  await page.getByRole('button', { name: '다시 생성' }).click();
  await expect(botMsgs(page)).toHaveCount(1);
  await expect(botMsgs(page).first()).toBeVisible();
  await expect(page.locator('#pendingBox')).toBeHidden();
  await expect(page.getByText(/^응답을 저장했습니다/)).toBeVisible();
  await expect(meta(page)).toHaveText(/^2턴 · /);
  // 늦게 붙는 중복이 없는지 파일과 API를 다시 읽어 대조한다
  expect((await savedTurnsOnDisk()).map((t) => t.role)).toEqual(['user', 'assistant']);
  const list = await (await page.request.get(`${srv.base}/api/chats`)).json();
  expect(list.chats[0].turnCount).toBe(2);
  expect(list.chats[0].pending).toBe(false);
  await say(page, '고마워요'); // 실패 흐름 뒤에도 정상 대화가 이어진다
  await expect(botMsgs(page)).toHaveCount(2);
  expect((await savedTurnsOnDisk()).length).toBe(4);
});

test('HTML·스크립트가 섞인 입력은 글자 그대로 보이고 요소로 만들어지지 않는다', async ({ page }) => {
  // 주 오라클: 요소가 생기지 않는다(innerHTML 회귀 시 실패). 보조: dialog 없음(CSP도 막으므로 단독 증거는 아님).
  const dialogs = [];
  page.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss(); });
  await openFreshAndStartChat(page);
  const evil = '<b>굵게</b><script>alert(1)</script><img src=x onerror=alert(2)>';
  await say(page, evil);
  await expect(userMsgs(page).first()).toBeVisible();
  await expect(userMsgs(page).first()).toContainText(evil);
  await expect(userMsgs(page).locator('b, script, img')).toHaveCount(0);
  await expect(botMsgs(page)).toHaveCount(1);
  await page.waitForTimeout(300);
  expect(dialogs).toEqual([]);
});

test('새로고침하면 마지막 채팅이 자동으로 다시 열린다', async ({ page }) => {
  await openFreshAndStartChat(page);
  await say(page, '오늘 밤은 제가 기름을 채울게요');
  await expect(botMsgs(page)).toHaveCount(1);
  await page.reload();
  await expect(page.getByText(/저장된 채팅을 다시 열었습니다/)).toBeVisible();
  await expect(page.locator('#messages')).toBeVisible();
  await expect(userMsgs(page)).toHaveCount(1);
  await expect(userMsgs(page).first()).toBeVisible();
  await expect(meta(page)).toHaveText(/^2턴 · /);
});

test('회복 UI: 깨진 작품 파일은 목록에서 격리되고, 손상 줄·연결 어긋남은 채팅 화면에 알린다', async ({ page }) => {
  const { Store } = require('../../lib/store');
  const store = new Store(srv.dataDir);
  fs.writeFileSync(path.join(srv.dataDir, 'works', 'zz-broken.json'), '{}');
  const chat = store.createChat('lighthouse-apprentice');
  store.appendTurn(chat.id, { id: 't1', role: 'user', text: '첫 줄', createdAt: new Date().toISOString(), parentId: null });
  store.appendTurn(chat.id, { id: 't2', role: 'assistant', text: '둘째', createdAt: new Date().toISOString(), parentId: 't1' });
  store.appendTurn(chat.id, { id: 't3', role: 'assistant', text: '어긋난 부모', createdAt: new Date().toISOString(), parentId: 't1' });
  fs.appendFileSync(store.chatFile(chat.id), '{"type":"turn","id":"t4","role":"user","text":"끊');

  await page.goto(srv.base);
  const broken = page.getByRole('button', { name: /zz-broken/ });
  await expect(broken).toBeVisible();
  await expect(broken).toBeDisabled();
  await expect(page.locator('#workList').getByRole('button', { name: '등대의 견습생' })).toBeEnabled();
  const resume = page.getByRole('button', { name: /이어 하기/ });
  await expect(resume.locator('.flag', { hasText: '손상 줄 있음' })).toBeVisible();
  await resume.click();
  await expect(page.getByText(/줄이 손상돼 건너뛰었습니다/)).toBeVisible();
  await expect(page.getByText(/이전 턴 연결이 어긋나 있습니다/)).toBeVisible();
  await expect(botMsgs(page)).toHaveCount(2);
  await expect(botMsgs(page).nth(1)).toBeVisible();
  await say(page, '그래도 이어 쓴다');
  await expect(userMsgs(page)).toHaveCount(2);
  await expect(page.getByText(/^저장됨/)).toBeVisible();
});
