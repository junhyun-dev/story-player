'use strict';
// 브라우저 검사 설정. 브라우저는 PLAYWRIGHT_BROWSERS_PATH=0 으로 node_modules 안(hermetic)에 둔다.
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: 'test/e2e',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 30000, // 다른 프로세스(검토·변이 실행)와 겹칠 때의 부하 여유
  reporter: [['list']],
  outputDir: 'test-results',
  use: {
    headless: true,
    locale: 'ko-KR',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
