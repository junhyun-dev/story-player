'use strict';
// 기록 응답기: 모델 없이 작품 파일의 대사를 순서대로 돌려준다.
// 저장·화면 검사용 임시 수단이며 실제 LLM의 기억·재미·지연 품질을 증명하지 않는다.
const { fail } = require('./store');

const FAIL_TOKEN = '[[실패]]';

class RecordedResponder {
  constructor({ failToken = FAIL_TOKEN, delayMs = 0 } = {}) {
    this.kind = 'recorded';
    this.label = '임시 응답(모델 없음)';
    this.failToken = failToken;
    this.delayMs = Number(delayMs) > 0 ? Number(delayMs) : 0; // 통제 실험용: 느린 모델처럼 응답을 늦춘다
    this.failedOnce = new Set(); // 개발용: 같은 사용자 턴은 첫 시도만 실패시킨다(일시 장애 재현)
  }

  async reply({ work, chat, userText, userTurnId }) {
    const attemptKey = `${chat.id}:${userTurnId}`; // 턴 id는 분기 복제로 파일 간 중복될 수 있어 채팅 id와 함께 쓴다
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    if (typeof userText === 'string' && userText.includes(this.failToken) && !this.failedOnce.has(attemptKey)) {
      // 개발용 실패 스위치: 응답 실패 → 다시 생성 흐름을 화면에서 직접 눌러보기 위한 것. 다시 생성하면 성공한다.
      this.failedOnce.add(attemptKey);
      throw fail('RESPONDER_FAIL', `개발용 실패 스위치 ${this.failToken} 때문에 이번 시도는 응답을 만들지 않았습니다. 다시 생성하면 성공합니다`);
    }
    const n = chat.turns.filter((t) => t.role === 'assistant').length;
    const scripted = n < work.script.length;
    if (scripted) return { text: work.script[n], responder: this.kind, scriptIndex: n };
    // 대본이 끝났다: 이 시작에 엔딩이 있으면 마지막 장면으로 이야기를 닫고, 없으면 예비 문장을 이어 준다.
    if (work.ending) return { text: work.ending.text, responder: this.kind, scriptIndex: null, ending: work.ending.name };
    return { text: work.fallback || '(기록된 대사가 끝났습니다.)', responder: this.kind, scriptIndex: null };
  }
}

module.exports = { RecordedResponder, FAIL_TOKEN };
