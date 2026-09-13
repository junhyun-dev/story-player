'use strict';
// 검사마다 임시 데이터 디렉터리로 서버를 in-process 기동한다. 실제 data/chats는 건드리지 않는다.
const { createApp } = require('../../server');
const { RecordedResponder } = require('../../lib/responder');
const fs = require('node:fs');
const { tempDataDir } = require('../helpers');

async function startServer({ delayMs = 0, responder = null } = {}) {
  const dataDir = tempDataDir();
  let server = null;
  let port = 0;
  const listen = () => new Promise((resolve, reject) => {
    server = createApp({ dataDir, responder: responder || new RecordedResponder({ delayMs }) });
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { port = server.address().port; resolve(); });
  });
  const close = () => new Promise((resolve) => (server ? server.close(() => resolve()) : resolve()));
  await listen();
  return {
    dataDir,
    get base() { return `http://127.0.0.1:${port}`; },
    stop: async () => { await close(); fs.rmSync(dataDir, { recursive: true, force: true }); },
    restart: async () => { await close(); await listen(); }, // 같은 포트·같은 데이터로 재기동
  };
}

module.exports = { startServer };
