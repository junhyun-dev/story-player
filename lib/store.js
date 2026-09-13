'use strict';
// 원본 저장소: 채팅은 파일당 JSONL(한 줄 한 레코드, 추가만). 요약·기억 층은 이 파일에 없다.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_NAME = 80;

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function assertId(id, label) {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw fail('BAD_ID', `${label} 형식이 잘못됐습니다`);
  return id;
}

function newId(prefix) {
  const ts = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `${prefix}-${ts}-${crypto.randomBytes(3).toString('hex')}`;
}

function isPending(turns) {
  const last = turns[turns.length - 1];
  return Boolean(last && last.role === 'user');
}

class Store {
  // create: false 면 폴더를 만들지 않는다(원고 미리보기처럼 읽기만 하는 쓰임). 기본값은 예전대로 만든다.
  constructor(dataDir, { create = true } = {}) {
    this.dataDir = dataDir;
    this.worksDir = path.join(dataDir, 'works');
    this.chatsDir = path.join(dataDir, 'chats');
    if (create) {
      fs.mkdirSync(this.worksDir, { recursive: true });
      fs.mkdirSync(this.chatsDir, { recursive: true });
    }
  }

  // ---- 작품 ----
  listWorks() {
    // 작품 파일 하나가 깨져도 나머지 작품과 앱은 살아 있어야 한다. 깨진 파일은 unreadable로 개별 표시한다.
    return fs.readdirSync(this.worksDir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((f) => {
        const id = f.slice(0, -5);
        try {
          const w = this.getWork(id);
          if (!w) return null;
          return { id: w.id, title: w.title, tagline: w.tagline || '', character: w.character.name, scriptCount: w.script.length, startCount: w.starts.length, starts: w.starts.map((st) => ({ id: st.id, name: st.name, situation: st.situation })) };
        } catch (err) {
          return { id, unreadable: true, error: err.message };
        }
      })
      .filter(Boolean);
  }

  getWork(id) {
    assertId(id, '작품 id');
    const file = path.join(this.worksDir, `${id}.json`);
    if (!fs.existsSync(file)) return null;
    let work;
    try {
      work = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      throw fail('BAD_WORK', `작품 파일을 읽을 수 없습니다: ${id}`);
    }
    const hasLegacyOpening = work && typeof work.opening === 'string' && work.opening.trim();
    const hasStarts = work && Array.isArray(work.starts) && work.starts.some((st) => st && typeof st === 'object' && typeof st.opening === 'string' && st.opening.trim());
    if (!work || typeof work.title !== 'string' || !work.character || typeof work.character.name !== 'string' || !(hasLegacyOpening || hasStarts)
      || (work.script !== undefined && !Array.isArray(work.script))) {
      throw fail('BAD_WORK', `작품 파일 형식이 잘못됐습니다: ${id}`);
    }
    // 시작 설정(starts): 한 작품에서 여러 상황으로 시작할 수 있게 하는 콘텐츠 단위(크랙의 '시작 설정'을 참고 — 이름·상황·프롤로그,
    // 사용자 전용 플레이 가이드, 작가 지정 추천 답변, 그리고 우리 기록 응답기의 대본). 옛 형식(top-level opening/script)은 시작 하나로 읽는다.
    const cleanGuide = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 2000) : '');
    const cleanReplies = (v) => (Array.isArray(v) ? v.filter((r) => typeof r === 'string' && r.trim()).map((r) => r.trim().slice(0, 200)).slice(0, 3) : []);
    const cleanScript = (v) => (Array.isArray(v) ? v.filter((l) => typeof l === 'string') : []);
    // 엔딩(선택): 이 시작의 대본이 끝났을 때 보여 줄 마지막 장면. 이름·본문은 작품이 쓴 독자 콘텐츠이며 모델이 만들지 않는다.
    const cleanEnding = (v) => {
      if (!v || typeof v !== 'object' || typeof v.text !== 'string' || !v.text.trim()) return null;
      return {
        name: typeof v.name === 'string' && v.name.trim() ? v.name.trim().slice(0, 20) : '엔딩',
        text: v.text.trim(),
        hint: typeof v.hint === 'string' ? v.hint.trim().slice(0, 200) : '',
      };
    };
    const rawStarts = Array.isArray(work.starts) ? work.starts : [];
    let starts = rawStarts
      .filter((st) => st && typeof st === 'object' && typeof st.opening === 'string' && st.opening.trim())
      .map((st, i) => ({
        id: typeof st.id === 'string' && ID_RE.test(st.id) ? st.id : `start-${i + 1}`,
        name: typeof st.name === 'string' && st.name.trim() ? st.name.trim().slice(0, 60) : `시작 ${i + 1}`,
        situation: typeof st.situation === 'string' ? st.situation.trim().slice(0, 300) : '',
        opening: st.opening.trim(),
        playGuide: cleanGuide(st.playGuide !== undefined ? st.playGuide : work.playGuide),
        suggestedReplies: cleanReplies(st.suggestedReplies !== undefined ? st.suggestedReplies : work.suggestedReplies),
        script: cleanScript(st.script !== undefined ? st.script : work.script),
        fallback: typeof st.fallback === 'string' ? st.fallback : work.fallback,
        ending: cleanEnding(st.ending !== undefined ? st.ending : work.ending),
      }));
    const seen = new Set();
    starts = starts.filter((st) => (seen.has(st.id) ? false : (seen.add(st.id), true)));
    if (!starts.length) {
      starts = [{ id: 'default', name: '기본 시작', situation: '', opening: work.opening, playGuide: cleanGuide(work.playGuide), suggestedReplies: cleanReplies(work.suggestedReplies), script: cleanScript(work.script), fallback: work.fallback, ending: cleanEnding(work.ending) }];
    }
    const first = starts[0];
    // 호환: 최상위 opening/script/playGuide/suggestedReplies는 첫 시작을 가리킨다(시작을 모르는 옛 소비자용)
    return { ...work, id, starts, opening: first.opening, script: first.script, playGuide: first.playGuide, suggestedReplies: first.suggestedReplies, fallback: first.fallback, ending: first.ending };
  }

  // ---- 채팅 파일 ----
  chatFile(chatId) {
    assertId(chatId, '채팅 id');
    return path.join(this.chatsDir, `${chatId}.jsonl`);
  }

  // 시작 설정 찾기: 채팅 meta의 startId → 작품의 시작. 없거나 사라졌으면 첫 시작으로 읽되 startMissing을 알린다.
  static startFor(work, startId) {
    const st = startId ? work.starts.find((x) => x.id === startId) : null;
    return { start: st || work.starts[0], startMissing: Boolean(startId) && !st };
  }

  createChat(workId, startId) {
    const work = this.getWork(workId);
    if (!work) throw fail('NOT_FOUND', '작품이 없습니다');
    if (startId !== undefined && startId !== null) {
      if (typeof startId !== 'string' || !work.starts.some((st) => st.id === startId)) throw fail('BAD_INPUT', '이 작품에 그런 시작 설정이 없습니다');
    }
    const start = startId ? work.starts.find((st) => st.id === startId) : work.starts[0];
    const id = newId('chat');
    const meta = {
      type: 'meta',
      id,
      workId: work.id,
      title: work.title,
      character: work.character.name,
      createdAt: new Date().toISOString(),
      startId: start.id,
      startName: start.name,
    };
    this.appendLine(id, meta, { exclusive: true });
    return this.readChat(id);
  }

  // 분기: 출처 채팅의 턴을 turnId까지 복제한 새 채팅 파일을 만든다. 출처 파일은 바꾸지 않는다.
  // 같은 파일 안에 트리를 넣지 않고 파일을 나누므로 readChat의 한 경로 규칙이 그대로 성립한다.
  branchChat(sourceId, turnId) {
    const source = this.readChat(sourceId);
    if (!source) throw fail('NOT_FOUND', '출처 채팅이 없습니다');
    if (typeof turnId !== 'string') throw fail('BAD_INPUT', 'turnId가 필요합니다');
    const idx = source.turns.findIndex((t) => t.id === turnId);
    if (idx < 0) throw fail('NOT_FOUND', '출처 채팅에 그 턴이 없습니다');
    const prefix = source.turns.slice(0, idx + 1);
    // 복제 구간 안에 사슬이 끊긴 턴(손상 줄로 빠진 턴 뒤)이 있으면 손실을 조용히 승계하지 않고 거부한다.
    if (prefix.some((t) => source.chainBreaks.includes(t.id))) {
      throw fail('BAD_INPUT', '출처의 손상된 구간을 포함해서는 분기할 수 없습니다. 손상 줄 앞 턴에서 새 전개를 만들어 주세요');
    }
    const id = newId('chat');
    const meta = {
      type: 'meta',
      id,
      workId: source.workId,
      title: source.title,
      character: source.character,
      createdAt: new Date().toISOString(),
      branchOf: { chatId: source.id, turnId, turnCount: prefix.length, sourceDamagedLines: source.damagedLines.slice() },
    };
    if (source.startId) { meta.startId = source.startId; meta.startName = source.startName; } // 분기는 같은 시작 설정을 이어받는다
    // 복제 턴에 대응하는 '현재 유효한' 표시 상태만 이어받는다(레코드가 쓰인 시각·위치가 아니라 접힌 상태 기준 →
    // 뒤늦게 표시한 앞 장면도 따라오고, 분기점 뒤 턴의 표시는 섞이지 않는다). 이후 부모/자식의 표시는 서로 독립이다.
    const prefixIds = new Set(prefix.map((t) => t.id));
    const carried = source.marks.filter((m) => prefixIds.has(m.turnId)).map((m) => ({ type: 'mark', at: m.at, turnId: m.turnId, marked: true, carriedFrom: source.id }));
    // 원자적 복제: 임시 파일에 전부 쓰고 fsync한 뒤 rename한다. 중간에 끊겨도 반쪽 분기 파일이 남지 않는다.
    this.writeChatAtomically(id, [meta, ...prefix.map((t) => ({ type: 'turn', ...t })), ...carried]);
    return this.readChat(id);
  }

  // 가져오기: 검증을 통과한 레코드로 새 채팅 파일을 만든다. 원본 파일이나 같은 id의 기존 채팅은 절대 덮어쓰지 않는다.
  importChat({ meta, turns, updates, marks }) {
    if (!meta || !Array.isArray(turns)) throw fail('BAD_INPUT', '가져올 채팅 정보가 없습니다');
    const id = newId('chat');
    const now = new Date().toISOString();
    const ups = (updates || []).map((u) => ({ ...u, type: 'meta-update' }));
    // 가져오기는 '복원' 동작이다: 내보낼 때 보관 상태였어도 활성 채팅으로 들어오고, 그 사실은 기록으로 남긴다.
    const wasArchived = ups.reduce((acc, u) => (typeof u.archived === 'boolean' ? u.archived : acc), false);
    if (wasArchived) ups.push({ type: 'meta-update', at: now, archived: false, reason: 'import' });
    const newMeta = {
      ...meta,
      id,
      importedFrom: {
        originalId: meta.id,
        importedAt: now,
        turnCount: turns.length,
        wasArchived,
        ...(meta.importedFrom ? { previous: meta.importedFrom } : {}), // 두 번 가져오면 이전 출처를 중첩해 남긴다
      },
    };
    // mark 레코드는 검증기가 같은 파일의 앞선 턴을 가리키는지 확인한 것만 넘어온다. 턴 뒤에 순서대로 두면 접기 결과가 같다.
    const turnIds = new Set(turns.map((t) => t.id));
    const mks = (marks || []).filter((m) => turnIds.has(m.turnId)).map((m) => ({ ...m, type: 'mark' }));
    const records = [newMeta, ...turns.map((t) => ({ ...t, type: 'turn' })), ...mks, ...ups];
    this.writeChatAtomically(id, records);
    return this.readChat(id);
  }

  writeChatAtomically(id, records) {
    const finalFile = this.chatFile(id);
    const tmpFile = path.join(this.chatsDir, `.${id}.tmp`);
    const body = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
    const fd = fs.openSync(tmpFile, 'wx');
    try { fs.writeSync(fd, body); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmpFile, finalFile);
  }

  appendLine(chatId, record, { exclusive = false } = {}) {
    const file = this.chatFile(chatId);
    let line = JSON.stringify(record) + '\n';
    const fd = fs.openSync(file, exclusive ? 'ax' : 'a+');
    try {
      if (!exclusive) {
        // 이전 쓰기가 중간에 끊겨 줄바꿈 없이 끝났으면 새 레코드가 그 줄에 붙지 않게 한다.
        const size = fs.fstatSync(fd).size;
        if (size > 0) {
          const buf = Buffer.alloc(1);
          fs.readSync(fd, buf, 0, 1, size - 1);
          if (buf[0] !== 0x0a) line = '\n' + line;
        }
      }
      fs.writeSync(fd, line);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  // 이름 바꾸기·보관·복구: 첫 줄(meta)은 그대로 두고 meta-update 레코드를 덧붙인다. 영구 삭제는 없다.
  updateChat(chatId, { name, archived } = {}) {
    const chat = this.readChat(chatId);
    if (!chat) throw fail('NOT_FOUND', '채팅이 없습니다');
    const rec = { type: 'meta-update', at: new Date().toISOString() };
    if (name !== undefined) {
      if (typeof name !== 'string' || !name.trim() || name.trim().length > MAX_NAME) throw fail('BAD_INPUT', `이름은 1~${MAX_NAME}자여야 합니다`);
      rec.name = name.trim();
    }
    if (archived !== undefined) {
      if (typeof archived !== 'boolean') throw fail('BAD_INPUT', 'archived는 true/false여야 합니다');
      rec.archived = archived;
    }
    if (rec.name === undefined && rec.archived === undefined) throw fail('BAD_INPUT', '바꿀 내용이 없습니다');
    this.appendLine(chatId, rec);
    return this.readChat(chatId);
  }

  // 장면 표시/해제: 이 채팅의 실제 턴만 대상으로 mark 레코드를 덧붙인다. 원문·다른 레코드는 바뀌지 않는다.
  setMark(chatId, turnId, marked) {
    const chat = this.readChat(chatId);
    if (!chat) throw fail('NOT_FOUND', '채팅이 없습니다');
    if (typeof turnId !== 'string' || !ID_RE.test(turnId)) throw fail('BAD_INPUT', 'turnId 형식이 잘못됐습니다');
    if (typeof marked !== 'boolean') throw fail('BAD_INPUT', 'marked는 true/false여야 합니다');
    if (!chat.turns.some((t) => t.id === turnId)) throw fail('NOT_FOUND', '이 채팅에 그 턴이 없습니다. 다른 채팅의 장면은 표시할 수 없습니다');
    this.appendLine(chatId, { type: 'mark', at: new Date().toISOString(), turnId, marked });
    return this.readChat(chatId);
  }

  appendTurn(chatId, turn) {
    this.appendLine(chatId, { type: 'turn', ...turn });
    return turn;
  }

  readChat(chatId) {
    const file = this.chatFile(chatId);
    if (!fs.existsSync(file)) return null;
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    let meta = null;
    const turns = [];
    const damagedLines = [];
    const updates = []; // meta-update: 이름·보관 같은 바뀌는 속성은 첫 줄을 고치지 않고 레코드를 덧붙여 접는다
    const markRecords = []; // mark: 사용자가 다시 읽으려고 표시한 장면(턴). 사실 확정·기억이 아니다. turnId별 마지막 레코드가 유효 상태
    lines.forEach((line, i) => {
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        damagedLines.push(i + 1);
        return;
      }
      if (rec && rec.type === 'meta' && !meta) meta = rec;
      else if (rec && rec.type === 'turn' && typeof rec.id === 'string') turns.push(rec);
      else if (rec && rec.type === 'meta-update' && typeof rec.at === 'string') updates.push(rec);
      else if (rec && rec.type === 'mark' && typeof rec.turnId === 'string' && typeof rec.marked === 'boolean') markRecords.push(rec);
      else damagedLines.push(i + 1);
    });
    if (!meta) throw fail('BAD_CHAT', `채팅 파일에 meta가 없습니다: ${chatId}`);
    let name = meta.title;
    let archived = false;
    let archivedAt = null;
    let renamedAt = null;
    for (const u of updates) {
      if (typeof u.name === 'string') { name = u.name; renamedAt = u.at; }
      if (typeof u.archived === 'boolean') { archived = u.archived; archivedAt = u.archived ? u.at : null; }
    }
    // 한 파일은 한 경로다: 각 턴의 parentId는 바로 앞 턴의 id여야 한다(첫 턴은 null). 어긋나면 알리되 버리지 않는다.
    // 분기(후속 후보)는 같은 파일에 트리로 넣지 않고 별도 채팅 파일로 복제해 meta.branchOf에 출처를 적는다.
    const chainBreaks = [];
    turns.forEach((t, i) => {
      const expected = i === 0 ? null : turns[i - 1].id;
      if ((t.parentId === undefined ? null : t.parentId) !== expected) chainBreaks.push(t.id);
    });
    const last = turns[turns.length - 1];
    // 완결: 마지막 턴이 엔딩 장면이면 이 이야기는 끝났다(이어 쓰기 대신 새 전개·다른 시작으로 간다).
    const ended = Boolean(last && last.role === 'assistant' && typeof last.ending === 'string' && last.ending);
    const endingName = ended ? last.ending : null;
    // 분기 파일은 meta.branchOf.turnCount 개의 복제 턴으로 시작해야 한다. 모자라면 잘린 분기다.
    const branchIncomplete = Boolean(meta.branchOf && typeof meta.branchOf.turnCount === 'number' && turns.length < meta.branchOf.turnCount);
    // 분기 출처가 이 데이터 디렉터리에 실제로 있는지(가져온 분기·이동한 파일은 없을 수 있다)
    const branchSourceExists = meta.branchOf && meta.branchOf.chatId && ID_RE.test(String(meta.branchOf.chatId))
      ? fs.existsSync(path.join(this.chatsDir, `${meta.branchOf.chatId}.jsonl`))
      : null;
    // 표시 상태 접기: 실제 존재하는 턴만, 파일 순서상 마지막 레코드가 결정. 결과는 턴 순서로 정렬한다.
    const turnIndex = new Map(turns.map((t, i) => [t.id, i]));
    const markState = new Map();
    for (const m of markRecords) if (turnIndex.has(m.turnId)) markState.set(m.turnId, { marked: m.marked, at: m.at });
    const marks = [...markState.entries()].filter(([, v]) => v.marked).map(([turnId, v]) => ({ turnId, at: v.at })).sort((a, b) => turnIndex.get(a.turnId) - turnIndex.get(b.turnId));
    const lastMarkAt = markRecords.length ? markRecords[markRecords.length - 1].at : null;
    const lastUpdateAt = [updates.length ? updates[updates.length - 1].at : null, lastMarkAt].filter(Boolean).sort().pop() || null;
    const lastSavedAt = [last ? last.createdAt : meta.createdAt, lastUpdateAt].filter(Boolean).sort().pop();
    return {
      ...meta,
      name,
      archived,
      archivedAt,
      renamedAt,
      turns,
      turnCount: turns.length,
      lastSavedAt,
      pending: isPending(turns),
      damagedLines,
      chainBreaks,
      branchIncomplete,
      branchSourceExists,
      marks,
      markCount: marks.length,
      ended,
      endingName,
    };
  }

  listChats(workId) {
    if (workId !== undefined) assertId(workId, '작품 id');
    const out = [];
    for (const f of fs.readdirSync(this.chatsDir)) {
      if (!f.endsWith('.jsonl') || f.startsWith('.')) continue;
      let chat;
      try {
        chat = this.readChat(f.slice(0, -6));
      } catch {
        out.push({ id: f.slice(0, -6), unreadable: true });
        continue;
      }
      if (!chat || (workId && chat.workId !== workId)) continue;
      const { turns, ...summary } = chat;
      // 목록에서 채팅을 구분할 단서: 마지막 내 말, 분기라면 분기점 뒤 첫 내 말
      const users = turns.filter((t) => t.role === 'user');
      summary.lastUserText = users.length ? users[users.length - 1].text : '';
      if (chat.branchOf) {
        const after = turns.slice(chat.branchOf.turnCount).find((t) => t.role === 'user');
        summary.firstTextAfterBranch = after ? after.text : '';
      }
      out.push(summary);
    }
    return out.sort((a, b) => String(b.lastSavedAt || '').localeCompare(String(a.lastSavedAt || '')));
  }
}

module.exports = { Store, newId, assertId, isPending, fail, ID_RE, MAX_NAME };
