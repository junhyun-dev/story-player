'use strict';
// 가져오기 검증: 내보낸 채팅 JSONL 텍스트를 저장 전에 엄격히 검사하는 순수 함수.
// 파일·네트워크·시간·무작위를 쓰지 않고 입력만 본다. 여기서 ok=true인 텍스트만 store가 받아 쓴다.
// 형식은 lib/store.js의 저장 형식과 같다(첫 줄 meta, 이후 turn / meta-update / mark, 한 줄 한 레코드).
// mark는 "이 턴을 다시 읽을 장면으로 표시/해제"한 기록이며 사실 확정·기억이 아니다. 같은 턴에 여러 번 나올 수 있다.
// 오류는 첫 줄에서 멈추지 않고 모아서 돌려준다. 사용자에게 그대로 보여줄 문장으로 쓴다.
const { ID_RE, MAX_NAME } = require('./store');

const MAX_IMPORT_BYTES = 4 * 1024 * 1024;
const MAX_IMPORT_RECORDS = 5000;
const MAX_TURN_TEXT = 20000;
const MAX_ERRORS = 20;
const RECORD_TYPES = new Set(['meta', 'turn', 'meta-update', 'mark']);
// createdAt·at은 저장 형식과 같은 ISO 문자열만 받는다(Date.parse만으로는 '2026'도 통과하므로 모양까지 본다).
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

function isObject(v) { return Boolean(v) && typeof v === 'object' && !Array.isArray(v); }
function isId(v) { return typeof v === 'string' && ID_RE.test(v); }
function isIso(v) { return typeof v === 'string' && ISO_RE.test(v) && !Number.isNaN(Date.parse(v)); }
function isText(v) { return typeof v === 'string' && v.length > 0; }
function isInt(v) { return typeof v === 'number' && Number.isInteger(v); }

// 알 수 없는 값을 오류 문장에 넣을 때 쓴다. 어떤 값이 와도 throw하지 않는다.
function show(v) {
  if (typeof v === 'string') return v.length > 40 ? `"${v.slice(0, 40)}…"` : `"${v}"`;
  try {
    const s = JSON.stringify(v);
    if (s === undefined) return String(v);
    return s.length > 40 ? `${s.slice(0, 40)}…` : s;
  } catch { return String(v); }
}

function validateChatImport(text, options) {
  const opts = isObject(options) ? options : {};
  const workExists = typeof opts.workExists === 'function' ? opts.workExists : null;

  const errors = [];
  const add = (line, message) => { if (errors.length < MAX_ERRORS) errors.push({ line, message }); };
  const stats = { turnCount: 0, userTurns: 0, assistantTurns: 0, markCount: 0, bytes: 0 };
  const fail = () => ({ ok: false, errors, meta: null, turns: null, updates: [], marks: [], stats });

  if (typeof text !== 'string') {
    add(null, '가져올 내용을 읽지 못했습니다. 내보낸 .jsonl 파일의 글자를 그대로 넣어 주세요.');
    return fail();
  }
  stats.bytes = Buffer.byteLength(text, 'utf8');
  if (stats.bytes > MAX_IMPORT_BYTES) {
    const mb = (stats.bytes / 1024 / 1024).toFixed(1);
    add(null, `파일이 너무 큽니다(약 ${mb}MB). 4MB 이하만 가져올 수 있습니다.`);
    return fail();
  }
  if (text.trim() === '') {
    add(null, '가져올 내용이 비어 있습니다. 내보낸 .jsonl 파일을 골라 주세요.');
    return fail();
  }

  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop(); // 마지막 줄바꿈 하나는 있어도 없어도 된다
  if (lines.length > MAX_IMPORT_RECORDS) {
    add(null, `줄이 너무 많습니다(${lines.length}줄). 한 번에 ${MAX_IMPORT_RECORDS}줄까지만 가져올 수 있습니다.`);
    return fail();
  }

  // 1) 줄마다 JSON 객체인지
  const records = lines.map((raw, i) => {
    const line = i + 1;
    if (raw.trim() === '') { add(line, '빈 줄입니다. 한 줄에 레코드 하나만 있어야 합니다.'); return null; }
    let rec;
    try { rec = JSON.parse(raw); } catch { add(line, 'JSON으로 읽을 수 없는 줄입니다. 파일이 편집되었을 수 있습니다.'); return null; }
    if (!isObject(rec)) { add(line, 'JSON 객체({...})가 아닙니다.'); return null; }
    return rec;
  });

  // 2) 첫 레코드가 meta인지, meta가 하나만인지
  const metaIndex = records.findIndex((r) => r && r.type === 'meta');
  if (metaIndex < 0) add(null, '채팅 정보(meta) 줄이 없습니다. 내보낸 파일을 그대로 가져와 주세요.');
  else if (metaIndex > 0) add(metaIndex + 1, '채팅 정보(meta)는 첫 줄에 있어야 합니다.');

  let meta = null;
  const turns = [];
  const updates = [];
  const marks = [];
  // mark가 가리키는 턴이 "이 파일에 아예 없는지"와 "뒤에 나오는지"를 구분해 알려 주기 위해 턴 id를 먼저 모은다.
  const allTurnIds = new Set();
  for (const rec of records) if (rec && rec.type === 'turn' && isId(rec.id)) allTurnIds.add(rec.id);
  const seenTurnIds = new Set();
  let prevTurn = null; // 사슬 비교의 기준: 마지막으로 id가 올바른 턴
  let prevRole = null;
  let metaLine = null;

  records.forEach((rec, i) => {
    const line = i + 1;
    if (!rec) return;
    if (!RECORD_TYPES.has(rec.type)) {
      add(line, `알 수 없는 종류(type)입니다: ${show(rec.type)}. meta·turn·meta-update만 가져올 수 있습니다.`);
      return;
    }
    if (rec.type === 'meta') {
      if (meta) { add(line, '채팅 정보(meta)가 두 번 나옵니다. 한 채팅에 하나만 있어야 합니다.'); return; }
      meta = rec;
      metaLine = line;
      checkMeta(rec, line, add, workExists);
      return;
    }
    if (rec.type === 'meta-update') {
      updates.push(rec);
      checkUpdate(rec, line, add);
      return;
    }
    if (rec.type === 'mark') {
      stats.markCount += 1;
      marks.push(rec);
      checkMark(rec, line, add, seenTurnIds, allTurnIds);
      return;
    }
    // turn
    stats.turnCount += 1;
    turns.push(rec);
    const isFirstTurn = stats.turnCount === 1;

    if (!isId(rec.id)) add(line, '턴 id가 올바르지 않습니다. 영문·숫자·밑줄·붙임표 1~64자만 쓸 수 있습니다.');
    else if (seenTurnIds.has(rec.id)) add(line, `턴 id가 앞에서 이미 쓰였습니다: ${rec.id}`);

    if (rec.role === 'user') stats.userTurns += 1;
    else if (rec.role === 'assistant') stats.assistantTurns += 1;

    if (rec.role !== 'user' && rec.role !== 'assistant') {
      add(line, `턴의 역할(role)은 user 또는 assistant여야 합니다: ${show(rec.role)}`);
    } else if (isFirstTurn && rec.role !== 'user') {
      add(line, '첫 턴은 사용자(user)의 말이어야 합니다.');
    } else if (rec.role === 'assistant' && prevRole === 'assistant') {
      add(line, '사용자 말 없이 캐릭터 응답이 두 번 이어집니다.');
    }

    if (typeof rec.text !== 'string') add(line, '턴의 내용(text)이 글자가 아닙니다.');
    else if (rec.text.length === 0) add(line, '턴의 내용(text)이 비어 있습니다.');
    else if (rec.text.length > MAX_TURN_TEXT) add(line, `턴의 내용(text)이 너무 깁니다(${rec.text.length}자). ${MAX_TURN_TEXT}자 이하여야 합니다.`);

    if (!isIso(rec.createdAt)) add(line, '턴의 시각(createdAt)이 ISO 날짜 글자가 아닙니다(예: 2026-09-11T00:00:00.000Z).');

    // 4) 사슬: 첫 턴은 parentId null, 이후는 바로 앞 턴의 id
    if (rec.parentId !== null && typeof rec.parentId !== 'string') {
      add(line, '턴의 parentId가 글자나 null이 아닙니다.');
    } else if (isFirstTurn) {
      if (rec.parentId !== null) add(line, '첫 턴의 parentId는 null이어야 합니다.');
    } else if (prevTurn && rec.parentId !== prevTurn.id) {
      add(line, `턴의 parentId가 바로 앞 턴의 id와 다릅니다(앞 턴: ${prevTurn.id}). 한 채팅 파일은 한 경로여야 합니다.`);
    }

    if (rec.clientTurnId !== undefined && !isId(rec.clientTurnId)) add(line, '턴의 clientTurnId 형식이 올바르지 않습니다.');
    if (rec.responder !== undefined && !isText(rec.responder)) add(line, '턴의 응답기 표시(responder)가 비어 있거나 글자가 아닙니다.');
    if (rec.scriptIndex !== undefined && rec.scriptIndex !== null && !(isInt(rec.scriptIndex) && rec.scriptIndex >= 0)) {
      add(line, '턴의 대사 번호(scriptIndex)가 0 이상의 정수나 null이 아닙니다.');
    }

    if (isId(rec.id) && !seenTurnIds.has(rec.id)) { seenTurnIds.add(rec.id); prevTurn = rec; }
    if (rec.role === 'user' || rec.role === 'assistant') prevRole = rec.role;
  });

  // 6) branchOf.turnCount는 실제 턴 수를 넘을 수 없다(턴을 모두 센 뒤에 본다)
  if (meta && isObject(meta.branchOf) && isInt(meta.branchOf.turnCount) && meta.branchOf.turnCount >= 1
    && meta.branchOf.turnCount > stats.turnCount) {
    add(metaLine, `분기 정보의 복제 턴 수(${meta.branchOf.turnCount})가 이 파일의 턴 수(${stats.turnCount})보다 많습니다.`);
  }

  const ok = errors.length === 0;
  return {
    ok,
    errors,
    meta: ok ? meta : null,
    turns: ok ? turns : null,
    updates: ok ? updates : [],
    marks: ok ? marks : [], // 파일 순서 그대로. 같은 턴의 마지막 레코드가 현재 상태라는 접기는 store가 한다
    stats,
  };
}

function checkMeta(rec, line, add, workExists) {
  if (!isId(rec.id)) add(line, '채팅 정보의 id가 올바르지 않습니다. 영문·숫자·밑줄·붙임표 1~64자만 쓸 수 있습니다.');
  if (!isId(rec.workId)) add(line, '채팅 정보의 작품 id(workId)가 올바르지 않습니다. 영문·숫자·밑줄·붙임표 1~64자만 쓸 수 있습니다.');
  if (!isText(rec.title)) add(line, '채팅 정보의 제목(title)이 비어 있거나 글자가 아닙니다.');
  if (!isText(rec.character)) add(line, '채팅 정보의 캐릭터 이름(character)이 비어 있거나 글자가 아닙니다.');
  if (!isIso(rec.createdAt)) add(line, '채팅 정보의 만든 시각(createdAt)이 ISO 날짜 글자가 아닙니다(예: 2026-09-11T00:00:00.000Z).');

  // 3) 이 작품이 이 컴퓨터에 있는지. 없으면 가져와도 대사·설정을 이어 갈 수 없다.
  if (isId(rec.workId) && workExists) {
    let exists;
    let threw = false;
    try { exists = workExists(rec.workId); } catch { threw = true; }
    if (threw) add(line, '작품이 설치돼 있는지 확인하지 못했습니다.');
    else if (!exists) add(line, `이 작품이 설치돼 있지 않습니다: ${rec.workId}`);
  }

  if (rec.branchOf !== undefined) {
    if (!isObject(rec.branchOf)) {
      add(line, '분기 정보(branchOf)가 객체가 아닙니다.');
    } else {
      const b = rec.branchOf;
      if (!isId(b.chatId)) add(line, '분기 정보의 출처 채팅 id(chatId)가 올바르지 않습니다.');
      if (!isId(b.turnId)) add(line, '분기 정보의 출처 턴 id(turnId)가 올바르지 않습니다.');
      if (!(isInt(b.turnCount) && b.turnCount >= 1)) add(line, '분기 정보의 복제 턴 수(turnCount)가 1 이상의 정수가 아닙니다.');
      if (b.sourceDamagedLines !== undefined
        && !(Array.isArray(b.sourceDamagedLines) && b.sourceDamagedLines.every((n) => isInt(n) && n >= 1))) {
        add(line, '분기 정보의 손상 줄 목록(sourceDamagedLines)이 1 이상의 정수 배열이 아닙니다.');
      }
    }
  }
  if (rec.importedFrom !== undefined && !isObject(rec.importedFrom)) {
    add(line, '가져온 출처 정보(importedFrom)가 객체가 아닙니다.');
  }
}

function checkUpdate(rec, line, add) {
  if (!isIso(rec.at)) add(line, '이름·보관 기록(meta-update)의 시각(at)이 ISO 날짜 글자가 아닙니다(예: 2026-09-11T00:00:00.000Z).');
  if (rec.name !== undefined && !(typeof rec.name === 'string' && rec.name.trim().length >= 1 && rec.name.trim().length <= MAX_NAME)) {
    add(line, `이름(name)은 1~${MAX_NAME}자의 글자여야 합니다.`);
  }
  if (rec.archived !== undefined && typeof rec.archived !== 'boolean') {
    add(line, '보관 여부(archived)는 true 또는 false여야 합니다.');
  }
  if (rec.name === undefined && rec.archived === undefined) {
    add(line, '이름·보관 기록(meta-update)에 name도 archived도 없습니다.');
  }
}

// 장면 표시: 앞에 나온 턴만 가리킬 수 있다(뒤나 없는 턴을 가리키면 다시 열었을 때 찾아갈 곳이 없다).
function checkMark(rec, line, add, seenTurnIds, allTurnIds) {
  if (!isIso(rec.at)) add(line, '장면 표시(mark)의 시각(at)이 ISO 날짜 글자가 아닙니다(예: 2026-09-11T00:00:00.000Z).');
  if (!isId(rec.turnId)) {
    add(line, '장면 표시(mark)의 턴 id(turnId)가 올바르지 않습니다. 영문·숫자·밑줄·붙임표 1~64자만 쓸 수 있습니다.');
  } else if (!seenTurnIds.has(rec.turnId)) {
    add(line, allTurnIds.has(rec.turnId)
      ? `장면 표시가 뒤에 나오는 턴을 가리킵니다: ${rec.turnId}. 표시는 그 턴보다 뒤에 있어야 합니다.`
      : `표시한 장면이 가리키는 턴이 이 파일에 없습니다: ${rec.turnId}`);
  }
  if (typeof rec.marked !== 'boolean') add(line, '장면 표시(mark)의 marked는 true 또는 false여야 합니다.');
}

module.exports = { validateChatImport, MAX_IMPORT_BYTES, MAX_IMPORT_RECORDS, MAX_TURN_TEXT };
