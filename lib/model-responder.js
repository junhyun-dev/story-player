'use strict';
// 실제 모델 응답기(준비 단계). OpenAI 호환 /v1/chat/completions(예: llama.cpp의 llama-server + Qwen3-4B)에
// 이 채팅 파일의 턴(= 한 경로)만으로 문맥을 조립해 보낸다. 서버 기동·종료는 하지 않으며, 호출은 사용자 승인 뒤에만 켠다(RESPONDER=model).
const { fail } = require('./store');

const DEFAULTS = {
  baseUrl: 'http://127.0.0.1:8081',
  model: 'qwen3-4b',
  timeoutMs: 120000,     // 사전 확인 + 완성 요청 + 재시도까지 한 턴 전체에 적용. CPU 4B 모델은 수십 초가 걸릴 수 있다
  maxTokens: 320,        // 응답 예약. 프롬프트 예산 = ctxSize - maxTokens
  maxTurns: 12,          // 히스토리는 최근 N턴만
  maxHistoryChars: 3000, // 문자 예산. 한국어 토큰 비율은 미확인이라 보수적으로 두고, 실제 판정은 /tokenize 사전 확인이 맡는다
  maxSystemChars: 1500,  // 시스템 메시지(설정+시작 장면+규칙) 상한. 넘으면 설명·시작 장면을 잘라 넣는다
  temperature: 0.8,
  enableThinking: false, // Qwen3 thinking 끄기(chat_template_kwargs)
  ctxSize: 4096,         // 소유자(agent-main)가 확정한 서버 문맥
  precheck: true,        // POST /tokenize 로 프롬프트 토큰을 먼저 세어 예산을 넘으면 히스토리를 줄인다(추론 아님)
  perMessageOverhead: 8, // 채팅 템플릿이 메시지마다 붙이는 토큰의 보수 추정
  label: null,
};

const RULES = '규칙: 한국어로, 오직 이 인물의 말과 행동만 2~4문장으로 답합니다. 사용자의 말을 대신 쓰지 않고, 설정에 없는 사실을 단정하지 않습니다.';

function stripThink(text) {
  // thinking을 껐어도 모델이 <think>…</think>를 내면 사용자에게 보이지 않게 뗀다.
  return String(text).replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
}

function cut(text, max) {
  const t = String(text || '');
  return t.length > max ? `${t.slice(0, Math.max(0, max - 1))}…` : t;
}

class ModelResponder {
  constructor(options = {}) {
    // 환경변수가 비어 undefined로 넘어온 옵션이 기본값을 덮어쓰지 않게 한다(실제 실행 1회에서 precheck·예산이 꺼진 원인).
    const given = Object.fromEntries(Object.entries(options || {}).filter(([, v]) => v !== undefined && !(typeof v === 'number' && Number.isNaN(v))));
    this.opts = { ...DEFAULTS, ...given };
    this.kind = 'model';
    this.label = this.opts.label || `모델 응답(${this.opts.model})`;
    this.canCancel = true;
    this.fetchImpl = this.opts.fetch || globalThis.fetch;
    this.inflight = new Map(); // chatId → AbortController (취소용)
  }

  buildSystem(work) {
    const head = `당신은 이야기 "${cut(work.title, 80)}"의 등장인물 ${cut(work.character.name, 40)}입니다.`;
    const fixed = head.length + RULES.length + 40; // 라벨·줄바꿈 여유
    const room = Math.max(200, this.opts.maxSystemChars - fixed);
    const description = cut(work.character.description || '', Math.floor(room * 0.4));
    const opening = cut(work.opening || '', room - description.length);
    return [head, `설정: ${description}`, `시작 장면: ${opening}`, RULES].join('\n');
  }

  // 문맥 조립: 이 채팅(=한 경로)의 턴만 쓴다. 사슬이 끊긴 파일이면 마지막으로 이어진 구간만 쓴다(다른 경로 턴 유입 차단).
  buildMessages({ work, chat }, budget = {}) {
    const maxTurns = Math.max(1, budget.maxTurns || this.opts.maxTurns);
    const maxHistoryChars = Math.max(1, budget.maxHistoryChars || this.opts.maxHistoryChars);
    const system = this.buildSystem(work);
    let all = chat.turns.filter((t) => (t.role === 'user' || t.role === 'assistant') && typeof t.text === 'string');
    let chainBreakCut = 0;
    if (Array.isArray(chat.chainBreaks) && chat.chainBreaks.length) {
      const lastBreak = Math.max(...chat.chainBreaks.map((id) => all.findIndex((t) => t.id === id)));
      if (lastBreak > 0) { chainBreakCut = lastBreak; all = all.slice(lastBreak); }
    }
    const recent = all.slice(-maxTurns);
    let chars = 0;
    const picked = [];
    for (let i = recent.length - 1; i >= 0; i -= 1) { // 최신 턴부터 예산 안에 담는다(마지막 사용자 턴은 항상 포함)
      const t = recent[i];
      if (picked.length > 0 && chars + t.text.length > maxHistoryChars) break;
      picked.unshift(t);
      chars += t.text.length;
    }
    return {
      messages: [{ role: 'system', content: system }, ...picked.map((t) => ({ role: t.role, content: t.text }))],
      ctx: {
        includedTurns: picked.length,
        firstTurnId: picked.length ? picked[0].id : null,
        lastTurnId: picked.length ? picked[picked.length - 1].id : null,
        droppedTurns: chat.turns.length - picked.length,
        chainBreakCut,
        historyChars: chars,
        systemChars: system.length,
        budget: { maxTurns, maxHistoryChars },
      },
    };
  }

  // POST /tokenize 로 프롬프트 토큰 수를 어림한다(메시지 내용 + 템플릿 여유). 실패하면 null(사전 확인 생략). 취소·타임아웃 신호를 따른다.
  async countPromptTokens(messages, signal) {
    try {
      const res = await this.fetchImpl(`${this.opts.baseUrl.replace(/\/$/, '')}/tokenize`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
        body: JSON.stringify({ content: messages.map((m) => m.content).join('\n') }),
      });
      if (!res.ok) return null;
      const body = await res.json();
      if (!body || !Array.isArray(body.tokens)) return null;
      return body.tokens.length + messages.length * this.opts.perMessageOverhead;
    } catch (err) {
      if (signal && signal.aborted) throw err; // 취소·타임아웃은 위로 올린다
      return null;
    }
  }

  static parseContextError(text) {
    // llama.cpp: HTTP 400 {"error":{"code":400,"message":"...","type":"exceed_context_size_error","n_prompt_tokens":N,"n_ctx":4096}}
    try {
      const j = JSON.parse(text);
      const e = j && j.error ? j.error : j;
      if (e && (e.type === 'exceed_context_size_error' || /exceed_context_size|context size/i.test(String(e.type || e.message || '')))) {
        return { promptTokens: e.n_prompt_tokens, ctx: e.n_ctx };
      }
    } catch { /* not json */ }
    return /exceed_context_size/i.test(String(text)) ? {} : null;
  }

  abortError(controller) {
    const reason = controller.signal.reason && controller.signal.reason.message;
    if (reason === 'timeout') return fail('RESPONDER_TIMEOUT', `모델 서버가 ${Math.round(this.opts.timeoutMs / 1000)}초 안에 답하지 않았습니다. 잠시 뒤 다시 생성해 주세요`);
    return fail('RESPONDER_CANCELLED', '응답 요청이 취소됐습니다(서버 종료 또는 사용자 취소). 입력은 저장돼 있으니 다시 생성할 수 있습니다');
  }

  async reply({ work, chat }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), this.opts.timeoutMs); // 사전 확인부터 재시도까지 한 턴 전체
    this.inflight.set(chat.id, controller);
    try {
      const promptBudget = this.opts.ctxSize - this.opts.maxTokens; // 소유자 확정: n_ctx 4096, 응답 예약 320 → 3,776
      let budget = { maxTurns: this.opts.maxTurns, maxHistoryChars: this.opts.maxHistoryChars };
      let shrinkSteps = 0;
      const shrink = () => { budget = { maxTurns: Math.max(1, Math.floor(budget.maxTurns / 2)), maxHistoryChars: Math.max(200, Math.floor(budget.maxHistoryChars / 2)) }; shrinkSteps += 1; };
      let built = this.buildMessages({ work, chat }, budget);
      let promptTokens = null;
      if (this.opts.precheck) {
        try {
          promptTokens = await this.countPromptTokens(built.messages, controller.signal);
          while (promptTokens !== null && promptTokens > promptBudget && built.ctx.includedTurns > 1 && shrinkSteps < 4) {
            shrink();
            built = this.buildMessages({ work, chat }, budget);
            promptTokens = await this.countPromptTokens(built.messages, controller.signal);
          }
        } catch (err) {
          if (controller.signal.aborted) throw this.abortError(controller);
          throw err;
        }
        if (promptTokens !== null && promptTokens > promptBudget) {
          // 줄일 히스토리가 없는데도 예산을 넘으면 보내지 않는다(조용히 잘린 문맥으로 '정상 응답'이 오는 것을 막는다)
          throw fail('RESPONDER_CONTEXT', `프롬프트가 모델 문맥 예산을 넘습니다(약 ${promptTokens}/${promptBudget} 토큰). 마지막 말을 줄이거나 작품 설정·시작 장면을 짧게 하거나, 앞 캐릭터 말에서 새 전개를 만들어 이어 주세요`);
        }
      }
      let retriedAfterContextError = false;
      for (;;) {
        const attempt = await this.requestCompletion({ messages: built.messages, controller });
        const overflow = attempt.contextError || (attempt.truncated ? { truncated: true, promptTokens: attempt.promptTokens } : null);
        if (overflow && !retriedAfterContextError && built.ctx.includedTurns > 1) {
          // 서버가 문맥 초과(400) 또는 잘림(truncated)을 알리면 예산을 줄여 한 번만 다시 시도한다(사용자 턴은 이미 저장돼 있다)
          retriedAfterContextError = true;
          shrink();
          built = this.buildMessages({ work, chat }, budget);
          continue;
        }
        if (overflow) {
          const n = overflow.promptTokens ? `(${overflow.promptTokens}/${overflow.ctx || this.opts.ctxSize} 토큰)` : '';
          throw fail('RESPONDER_CONTEXT', overflow.truncated
            ? `모델이 문맥을 잘라 앞 이야기를 보지 못한 상태로 답했습니다${n}. 잘린 응답은 저장하지 않았습니다. 마지막 말을 줄이거나 앞 캐릭터 말에서 새 전개를 만들어 주세요`
            : `프롬프트가 모델 문맥 한도를 넘었습니다${n}. 마지막 말을 줄이거나 앞 캐릭터 말에서 새 전개를 만들어 이어 주세요`);
        }
        return { ...attempt.result, ctx: { ...built.ctx, promptTokensEstimate: promptTokens, promptTokens: attempt.promptTokens, shrinkSteps, retriedAfterContextError } };
      }
    } finally {
      clearTimeout(timer);
      this.inflight.delete(chat.id);
    }
  }

  async requestCompletion({ messages, controller }) {
    const url = `${this.opts.baseUrl.replace(/\/$/, '')}/v1/chat/completions`;
    let res;
    let bodyText;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.opts.model,
          messages,
          max_tokens: this.opts.maxTokens,
          temperature: this.opts.temperature,
          stream: false,
          chat_template_kwargs: { enable_thinking: this.opts.enableThinking },
        }),
      });
      bodyText = await res.text(); // 본문 읽기도 같은 타이머·취소 안에서 끝낸다
    } catch (err) {
      if (controller.signal.aborted) throw this.abortError(controller);
      if (res) throw fail('RESPONDER_BAD_REPLY', '모델 서버 응답을 끝까지 받지 못했습니다');
      throw fail('RESPONDER_UNREACHABLE', `모델 서버(${this.opts.baseUrl})에 연결할 수 없습니다. 로컬 모델 서버가 켜져 있는지 확인해 주세요`);
    }
    if (!res.ok) {
      const contextError = ModelResponder.parseContextError(bodyText); // 상태 코드가 400이 아니어도 본문 형태로 판별
      if (contextError) return { contextError };
      const detail = String(bodyText || '').slice(0, 200);
      throw fail('RESPONDER_HTTP', `모델 서버가 오류를 돌려줬습니다(HTTP ${res.status})${detail ? `: ${detail}` : ''}`);
    }
    let body;
    try { body = JSON.parse(bodyText); } catch { throw fail('RESPONDER_BAD_REPLY', '모델 서버 응답을 JSON으로 읽을 수 없습니다'); }
    const choice = body && body.choices && body.choices[0];
    const promptTokens = body && body.usage ? body.usage.prompt_tokens : undefined;
    if (body && body.truncated === true) return { truncated: true, promptTokens }; // llama.cpp: "if the context size was exceeded"
    const raw = choice && choice.message ? choice.message.content : null;
    const text = typeof raw === 'string' ? stripThink(raw) : '';
    if (!text) throw fail('RESPONDER_EMPTY', '모델 서버가 빈 응답을 돌려줬습니다. 다시 생성해 주세요');
    return {
      promptTokens,
      result: {
        text,
        responder: this.kind,
        scriptIndex: null,
        model: (body && body.model) || this.opts.model,
        usage: body && body.usage ? body.usage : undefined,
        finishReason: choice ? choice.finish_reason : undefined,
      },
    };
  }

  // /health 200 {"status":"ok"} 이면 준비됨. 추론은 아니지만 모델 서버에 닿는 호출이므로 필요할 때만 쓴다.
  async health() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      const res = await this.fetchImpl(`${this.opts.baseUrl.replace(/\/$/, '')}/health`, { signal: controller.signal });
      return { ok: res.ok, status: res.status };
    } catch (err) {
      return { ok: false, status: 0, error: err.message };
    } finally { clearTimeout(timer); }
  }

  abortAll(reason = 'shutdown') {
    for (const [, c] of this.inflight) c.abort(new Error(reason));
    this.inflight.clear();
  }

  abort(chatId, reason = 'cancel') {
    const c = this.inflight.get(chatId);
    if (c) c.abort(new Error(reason));
    return Boolean(c);
  }
}

module.exports = { ModelResponder, DEFAULTS, stripThink, RULES };
