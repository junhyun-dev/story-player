'use strict';
// 채팅 흐름: 사용자 턴을 먼저 저장하고, 응답기 결과를 별도 턴으로 저장한다.
// 응답 실패 시 사용자 턴만 남고(pending) '다시 생성'으로 응답만 다시 만든다.
const { newId, fail, ID_RE } = require('./store');
const { validateChatImport } = require('./import');

const MAX_TEXT = 2000;

class ChatService {
  constructor(store, responder) {
    this.store = store;
    this.responder = responder;
    this.inflight = new Set();
  }

  listWorks() { return this.store.listWorks(); }

  // 진행 중인 모델 요청을 모두 취소한다(서버 종료 시). 응답기가 취소를 지원하지 않으면 아무 일도 없다.
  abortAll(reason) {
    if (typeof this.responder.abortAll === 'function') this.responder.abortAll(reason);
  }

  // 사용자 취소: 이 채팅의 진행 중 요청만 끊는다. 사용자 턴은 남고 응답 없음(pending)이 된다.
  cancel(chatId) {
    const chat = this.getChat(chatId);
    if (!this.inflight.has(chatId) || typeof this.responder.abort !== 'function') return { ...chat, cancelled: false };
    const cancelled = this.responder.abort(chatId, 'cancel');
    return { ...chat, cancelled };
  }

  decorateMeta() {
    return { responder: this.responder.kind, responderLabel: this.responder.label, canCancel: Boolean(this.responder.canCancel) };
  }

  getWork(id) {
    const work = this.store.getWork(id);
    if (!work) throw fail('NOT_FOUND', '작품이 없습니다');
    return work;
  }

  listChats(workId) { return this.store.listChats(workId); }

  createChat(workId, startId) {
    if (typeof workId !== 'string') throw fail('BAD_INPUT', 'workId가 필요합니다');
    return this.decorate(this.store.createChat(workId, startId));
  }

  // 채팅이 속한 시작 설정으로 작품 내용을 맞춘다(프롤로그·대본·가이드·추천 답변). 응답기는 이 결과를 받는다.
  workForChat(chat) {
    const work = this.getWork(chat.workId);
    const { Store } = require('./store');
    const { start, startMissing } = Store.startFor(work, chat.startId);
    return { ...work, opening: start.opening, script: start.script, fallback: start.fallback, playGuide: start.playGuide, suggestedReplies: start.suggestedReplies, ending: start.ending, start, startMissing };
  }

  // 내보내기: 저장 파일을 그대로 준다(가져오기 형식과 동일).
  exportChat(chatId) {
    const chat = this.getChat(chatId);
    const raw = require('node:fs').readFileSync(this.store.chatFile(chatId), 'utf8');
    return { chat, raw, filename: `${(chat.name || chat.title).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 60)}-${chat.id}.jsonl` };
  }

  // 가져오기: 텍스트를 엄격 검증하고 통과하면 별도 채팅으로 저장한다. 실패하면 줄 번호가 있는 오류 목록을 돌려준다.
  importChat(text) {
    const result = validateChatImport(text, { workExists: (id) => Boolean(this.store.getWork(id)) });
    if (!result.ok) {
      const err = fail('BAD_IMPORT', `가져올 수 없습니다. 문제 ${result.errors.length}건을 확인해 주세요`);
      err.details = result.errors;
      throw err;
    }
    return { ...this.decorate(this.store.importChat(result)), importStats: result.stats };
  }

  // 장면 표시/해제. 보관된 채팅은 읽기 전용이라 복구 뒤에만 표시를 바꿀 수 있다.
  mark(chatId, turnId, marked) {
    const chat = this.getChat(chatId);
    if (chat.archived) throw fail('ARCHIVED', '보관된 채팅입니다. 복구한 뒤 장면을 표시할 수 있습니다');
    return this.decorate(this.store.setMark(chatId, turnId, marked));
  }

  update(chatId, fields) {
    if (!fields || typeof fields !== 'object') throw fail('BAD_INPUT', '바꿀 내용이 필요합니다');
    return this.decorate(this.store.updateChat(chatId, { name: fields.name, archived: fields.archived }));
  }

  branch(sourceId, turnId) {
    if (this.inflight.has(sourceId)) throw fail('BUSY', '출처 채팅이 아직 처리 중입니다. 잠시 뒤 다시 시도해 주세요');
    return this.decorate(this.store.branchChat(sourceId, turnId));
  }

  getChat(chatId) {
    const chat = this.store.readChat(chatId);
    if (!chat) throw fail('NOT_FOUND', '채팅이 없습니다');
    return this.decorate(chat);
  }

  decorate(chat) {
    // inflight: 이 프로세스가 지금 이 채팅의 응답을 만드는 중(다른 탭·새로고침 전 요청). pending이지만 실패가 아니다.
    let startMissing = false;
    try { startMissing = this.workForChat(chat).startMissing; } catch { startMissing = false; }
    return { ...chat, inflight: this.inflight.has(chat.id), startMissing, ...this.decorateMeta() };
  }

  async send(chatId, { text, clientTurnId } = {}) {
    if (typeof text !== 'string') throw fail('BAD_INPUT', 'text는 문자열이어야 합니다');
    const trimmed = text.trim();
    if (!trimmed) throw fail('BAD_INPUT', '빈 입력은 보낼 수 없습니다');
    if (trimmed.length > MAX_TEXT) throw fail('BAD_INPUT', `입력은 ${MAX_TEXT}자 이하여야 합니다`);
    if (clientTurnId !== undefined && (typeof clientTurnId !== 'string' || !ID_RE.test(clientTurnId))) {
      throw fail('BAD_INPUT', 'clientTurnId 형식이 잘못됐습니다');
    }
    const chat = this.getChat(chatId);
    if (chat.archived) throw fail('ARCHIVED', '보관된 채팅입니다. 복구한 뒤 이어 쓸 수 있습니다'); // 중복 판정보다 먼저: 보관 중엔 '저장됨'처럼 보이는 응답을 주지 않는다
    if (chat.ended) throw fail('ENDED', `이 이야기는 '${chat.endingName}'으로 끝났습니다. 마지막 장면 앞에서 새 전개를 만들거나 다른 시작으로 새 채팅을 시작하세요`);
    if (clientTurnId) {
      const dup = chat.turns.find((t) => t.role === 'user' && t.clientTurnId === clientTurnId);
      if (dup) return { ...chat, duplicate: true, replied: !chat.pending };
    }
    if (chat.pending) throw fail('PENDING', '이전 입력의 응답이 아직 없습니다. 다시 생성을 눌러 주세요');
    if (this.inflight.has(chatId)) throw fail('BUSY', '이 채팅은 아직 처리 중입니다');
    const last = chat.turns[chat.turns.length - 1];
    const userTurn = {
      id: newId('turn'),
      role: 'user',
      text: trimmed,
      createdAt: new Date().toISOString(),
      parentId: last ? last.id : null,
    };
    if (clientTurnId) userTurn.clientTurnId = clientTurnId;
    this.store.appendTurn(chatId, userTurn);
    return this.reply(chatId);
  }

  async retry(chatId) {
    const chat = this.getChat(chatId);
    if (chat.archived) throw fail('ARCHIVED', '보관된 채팅입니다. 복구한 뒤 다시 생성할 수 있습니다');
    if (!chat.pending) return { ...chat, noop: true, replied: true };
    if (this.inflight.has(chatId)) throw fail('BUSY', '이 채팅은 아직 처리 중입니다');
    return this.reply(chatId);
  }

  async reply(chatId) {
    this.inflight.add(chatId);
    let outcome;
    try {
      const chat = this.getChat(chatId);
      const last = chat.turns[chat.turns.length - 1];
      let result;
      try {
        const work = this.workForChat(chat); // 작품 파일이 깨지면 응답 실패로 남기고 고친 뒤 다시 생성할 수 있게 한다. 채팅의 시작 설정에 맞춘 내용
        result = await this.responder.reply({ work, chat, userText: last.text, userTurnId: last.id });
      } catch (err) {
        outcome = { replied: false, replyError: err.message || String(err) };
      }
      if (!outcome) {
        if (!result || typeof result.text !== 'string') {
          outcome = { replied: false, replyError: '응답기가 빈 결과를 돌려줬습니다' };
        } else {
          const turn = {
            id: newId('turn'),
            role: 'assistant',
            text: result.text,
            createdAt: new Date().toISOString(),
            parentId: last.id,
            responder: result.responder || this.responder.kind,
            scriptIndex: result.scriptIndex === undefined ? null : result.scriptIndex,
          };
          if (result.ending) turn.ending = result.ending; // 엔딩 장면 표시(이 턴이 이야기의 끝)
          if (result.model) turn.model = result.model;
          if (result.ctx) turn.ctx = result.ctx; // 어떤 문맥으로 만들었는지("왜 잊었나"를 추적하는 근거)
          if (result.usage) turn.usage = result.usage;
          if (result.finishReason) turn.finishReason = result.finishReason;
          this.store.appendTurn(chatId, turn);
          outcome = { replied: true };
        }
      }
    } finally {
      this.inflight.delete(chatId); // 결과 객체는 inflight 해제 뒤에 만든다(완성된 응답이 '만드는 중'으로 보이지 않게)
    }
    return { ...this.getChat(chatId), ...outcome };
  }
}

module.exports = { ChatService, MAX_TEXT };
