'use strict';
// 모델 응답기(가짜 OpenAI 호환 서버) + 실제 브라우저: 기다리는 당사자가 '만드는 중'과 취소를 보고, 취소 뒤 다시 생성으로 이어 간다.
// 실제 Qwen3-4B는 호출하지 않는다(가짜 서버, 임시 디렉터리).
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { test, expect } = require('@playwright/test');
const { startServer } = require('./server-fixture');
const { ModelResponder } = require('../../lib/model-responder');

function fakeOpenAI() {
  const state = { delayMs: 3000, calls: 0 };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url === '/tokenize') { res.writeHead(404); return res.end(); }
      state.calls += 1;
      const reply = () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ model: 'qwen3-4b', choices: [{ message: { role: 'assistant', content: `모델 답 ${state.calls}` }, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 5 } })); };
      const wait = state.delayMs;
      if (wait) { const t = setTimeout(reply, wait); req.on('close', () => clearTimeout(t)); } else reply();
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ state, base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) })));
}

let srv; let fake;
test.beforeEach(async () => {
  fake = await fakeOpenAI();
  srv = await startServer({ responder: new ModelResponder({ baseUrl: fake.base, model: 'qwen3-4b', timeoutMs: 20000 }) });
});
test.afterEach(async () => { await srv.stop(); await fake.close(); });

const turnsOnDisk = () => {
  const dir = path.join(srv.dataDir, 'chats');
  const f = fs.readdirSync(dir).find((x) => x.endsWith('.jsonl'));
  return fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.type === 'turn');
};

test('모델 응답 대기 중 같은 탭에 취소가 보이고, 취소하면 입력만 남아 다시 생성으로 이어진다', async ({ page }) => {
  await page.goto(srv.base);
  await expect(page.locator('#responderBadge')).toHaveText('모델 응답(qwen3-4b)');
  await page.getByRole('button', { name: '새 채팅 시작' }).click();
  await expect(page.getByText('새 채팅을 만들고 저장했습니다.')).toBeVisible();
  await page.locator('#input').fill('이름은 진이에요');
  await page.locator('#input').press('Enter');

  // 기다리는 당사자 화면: 만드는 중 + 취소 버튼(다시 생성은 숨김)
  await expect(page.locator('#pendingBox')).toBeVisible();
  await expect(page.locator('#pendingText')).toHaveText(/응답을 만드는 중입니다\. 오래 걸리면 취소할 수 있습니다/);
  await expect(page.getByRole('button', { name: '취소' })).toBeVisible();
  await expect(page.getByRole('button', { name: '다시 생성' })).toBeHidden();
  await expect(page.locator('#input')).toBeDisabled();

  await page.getByRole('button', { name: '취소' }).click();
  await expect(page.getByText(/응답 요청을 취소했습니다/)).toBeVisible();
  await expect(page.locator('#pendingText')).toHaveText(/아직 응답이 없습니다/);
  await expect(page.getByRole('button', { name: '다시 생성' })).toBeVisible();
  await expect(page.getByRole('button', { name: '취소' })).toBeHidden();
  await expect(page.locator('#input')).toBeEnabled();
  await expect(page.locator('[data-role="user"]')).toHaveCount(1);
  await expect(page.locator('[data-role="assistant"]')).toHaveCount(0);
  expect(turnsOnDisk().map((t) => t.role)).toEqual(['user']);

  // 서버가 빨라진 뒤 다시 생성 → 모델 응답 1개, 태그 '모델 응답 · qwen3-4b'
  fake.state.delayMs = 0;
  await page.getByRole('button', { name: '다시 생성' }).click();
  await expect(page.locator('[data-role="assistant"]')).toHaveCount(1);
  await expect(page.locator('[data-role="assistant"] .tag')).toHaveText('모델 응답 · qwen3-4b');
  await expect(page.locator('#pendingBox')).toBeHidden();
  await expect(page.getByText(/^응답을 저장했습니다/)).toBeVisible();
  await new Promise((r) => setTimeout(r, 200));
  expect(turnsOnDisk().map((t) => t.role)).toEqual(['user', 'assistant']);
  expect(turnsOnDisk()[1].responder).toBe('model');
});

test('기록 응답기에는 취소 버튼이 아예 나타나지 않는다(대조)', async ({ browser }) => {
  const plain = await startServer();
  try {
    const page = await browser.newPage();
    await page.goto(plain.base);
    await expect(page.locator('#responderBadge')).toHaveText('임시 응답(모델 없음)');
    await page.getByRole('button', { name: '새 채팅 시작' }).click();
    await page.locator('#input').fill('[[실패]] 취소 버튼 없음');
    await page.locator('#input').press('Enter');
    await expect(page.locator('#pendingBox')).toBeVisible();
    await expect(page.getByRole('button', { name: '다시 생성' })).toBeVisible();
    await expect(page.locator('#cancelBtn')).toBeHidden(); // 취소 미지원 응답기에서는 대기 상자에 취소가 없다
    await expect(page.locator('#pendingBox').getByRole('button', { name: '취소' })).toHaveCount(0);
    await page.close();
  } finally { await plain.stop(); }
});
