'use strict';
// 작품 원고를 '실제 플레이 순서'로 찍어 본다(읽기 전용). ink 공식 실습의 "쓰고 바로 미리 보기"를 우리 크기로 옮긴 것이며
// 작가용 편집 도구가 아니다. 순서는 lib/responder.js(RecordedResponder)가 실제로 돌려주는 순서를 따른다:
//   프롤로그(작품 설정) → 대사 1..n → (엔딩이 있으면) 엔딩  /  (엔딩이 없으면) 예비 문장이 계속 반복
// 엔딩이 있는 시작에서는 예비 문장이 소비되지 않으므로 본문에 넣지 않고 '쓰이지 않는 자료'로 따로 보여 준다.
// 사용법: node scripts/preview-work.js [작품id] [시작id]   (DATA_DIR 환경변수로 다른 자료 폴더를 볼 수 있다)
const fs = require('node:fs');
const path = require('node:path');
const { Store } = require('../lib/store');

const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, '..', 'data');
const worksDir = path.join(dataDir, 'works');
if (!fs.existsSync(worksDir) || !fs.statSync(worksDir).isDirectory()) {
  console.error(`작품 폴더가 없습니다: ${worksDir}`);
  console.error('미리보기는 폴더를 만들지 않습니다. DATA_DIR를 확인하거나 작품 JSON을 넣은 뒤 다시 실행하세요.');
  process.exit(1);
}
const store = new Store(dataDir, { create: false }); // 읽기만 한다: works/chats 폴더를 만들지 않는다
const [workArg, startArg] = process.argv.slice(2);
const wrap = (text) => String(text).split('\n').map((l) => `    ${l}`).join('\n');

let works;
if (workArg) {
  works = [{ id: workArg }];
} else {
  works = store.listWorks().filter((w) => !w.unreadable);
  if (!works.length) { console.error(`읽을 수 있는 작품이 없습니다: ${worksDir}`); process.exit(1); }
}

let missing = 0;
for (const item of works) {
  let work = null;
  try { work = store.getWork(item.id); } catch (err) { console.error(`작품을 읽을 수 없습니다: ${item.id} (${err.message})`); missing += 1; continue; }
  if (!work) { console.error(`작품을 찾을 수 없습니다: ${item.id}`); missing += 1; continue; }
  console.log(`\n# ${work.title} · ${work.character.name}  (${work.id})`);
  if (work.tagline) console.log(`  ${work.tagline}`);
  const starts = startArg ? work.starts.filter((st) => st.id === startArg) : work.starts;
  if (!starts.length) { console.error(`  시작 설정을 찾을 수 없습니다: ${startArg}`); missing += 1; continue; }
  for (const st of starts) {
    console.log(`\n## 시작: ${st.name}  (${st.id})`);
    if (st.situation) console.log(`  상황: ${st.situation}`);
    console.log('\n  [프롤로그 · 작품 설정]');
    console.log(wrap(st.opening));
    if (st.suggestedReplies.length) console.log(`\n  [시작 추천 답변] ${st.suggestedReplies.map((r) => `"${r}"`).join('  ')}`);
    if (st.playGuide) console.log(`\n  [플레이 가이드 · 사용자 전용]\n${wrap(st.playGuide)}`);
    console.log(`\n  [플레이 순서 · ${work.character.name}의 기록 대사 ${st.script.length}개]`);
    st.script.forEach((line, i) => console.log(`  ${String(i + 1).padStart(2)}. ${line}`));
    if (st.ending) {
      console.log(`\n  ${String(st.script.length + 1).padStart(2)}. [엔딩 · ${st.ending.name}] ← 대사가 끝난 다음 응답이 이 장면이며 여기서 이야기가 끝난다`);
      console.log(wrap(st.ending.text));
      if (st.ending.hint) console.log(`  (끝을 향한 단서: ${st.ending.hint})`);
      if (st.fallback) {
        console.log('\n  [쓰이지 않는 자료 · 예비 문장]  엔딩이 있으므로 현재 플레이에서는 등장하지 않는다(엔딩을 지우면 이 문장이 이어진다).');
        console.log(wrap(st.fallback));
      }
      console.log(`\n  읽기 길이: 프롤로그 1 + 대사 ${st.script.length} + 엔딩 1 = 장면 ${st.script.length + 2}개(엔딩에서 끝)`);
    } else {
      console.log(`\n  ${String(st.script.length + 1).padStart(2)}. [예비 문장] ← 엔딩이 없으므로 대사가 끝난 뒤에는 이 문장이 계속 반복되고 이야기는 끝나지 않는다`);
      console.log(wrap(st.fallback || '(기록된 대사가 끝났습니다.)'));
      console.log(`\n  읽기 길이: 프롤로그 1 + 대사 ${st.script.length} + 예비 문장 반복 = 장면 ${st.script.length + 1}개 뒤 끝 없음`);
    }
  }
}
process.exit(missing ? 1 : 0);
