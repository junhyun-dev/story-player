'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 테스트마다 빈 data 디렉터리를 만들고 샘플 작품을 복사한다. 실제 data/chats는 건드리지 않는다.
const created = [];
function removeTempDirs() {
  while (created.length) {
    const d = created.pop();
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 이미 없음 */ }
  }
}
process.on('exit', removeTempDirs);

function tempDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psp-test-'));
  created.push(dir);
  fs.mkdirSync(path.join(dir, 'works'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'chats'), { recursive: true });
  fs.copyFileSync(
    path.join(__dirname, '..', 'data', 'works', 'lighthouse-apprentice.json'),
    path.join(dir, 'works', 'lighthouse-apprentice.json'),
  );
  return dir;
}

function writeWork(dir, id, work) {
  fs.writeFileSync(path.join(dir, 'works', `${id}.json`), JSON.stringify(work));
}

module.exports = { tempDataDir, writeWork, removeTempDirs, WORK_ID: 'lighthouse-apprentice' };
