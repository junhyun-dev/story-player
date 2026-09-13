'use strict';
// 로컬 v1 화면 로직. 사용자·캐릭터 텍스트는 항상 textContent로만 그린다(HTML 삽입 없음).
(() => {
  const $ = (id) => document.getElementById(id);
  const LS_KEY = 'psp.lastChatId';
  const state = {
    works: [], workId: null, chats: [], chat: null, busy: false, unconfirmed: null, recheckTimer: null,
    opening: null, query: '', archivedOpen: false, canCancel: false, recapShowAll: false, workDetail: null, startId: null,
  };

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function pad(n) { return String(n).padStart(2, '0'); }
  function fmtTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function newClientId() {
    try { return crypto.randomUUID(); } catch { return 'c-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10); }
  }
  function remember(chatId) { try { if (chatId) localStorage.setItem(LS_KEY, chatId); else localStorage.removeItem(LS_KEY); } catch { /* 저장 불가 환경 */ } }
  function recall() { try { return localStorage.getItem(LS_KEY); } catch { return null; } }
  function shorten(text, n) { return text.length > n ? `${text.slice(0, n)}…` : text; }

  async function api(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (!res.ok) {
      const err = new Error((data && data.error && data.error.message) || `HTTP ${res.status}`);
      err.code = (data && data.error && data.error.code) || 'HTTP';
      err.status = res.status;
      if (data && data.error && Array.isArray(data.error.details)) err.details = data.error.details;
      throw err;
    }
    return data;
  }

  function setStatus(text, kind) {
    const node = $('statusLine');
    node.textContent = text || '';
    node.className = 'status' + (kind ? ' ' + kind : '');
  }
  function setBusy(busy) {
    state.busy = busy;
    const archivedLock = Boolean(state.chat && (state.chat.archived || state.chat.ended));
    $('sendBtn').disabled = busy || archivedLock;
    $('retryBtn').disabled = busy;
    $('input').disabled = busy || archivedLock;
    $('newChatBtn').disabled = busy;
    for (const id of ['renameBtn', 'archiveBtn', 'exportBtn', 'toggleListBtn', 'importBtn', 'reconnectBtn']) $(id).disabled = busy;
    document.querySelectorAll('.msg .actions button, .info button, .list .inline, .endingblock .actions button').forEach((b) => { b.disabled = busy; });
  }

  // 기다리는 당사자 화면에도 '만드는 중'과 취소를 보인다(취소를 지원하는 응답기일 때). 응답이 오면 renderChat이 다시 그린다.
  function showWaiting(text) {
    if (!state.canCancel) return;
    $('pendingBox').hidden = false;
    $('pendingText').textContent = text;
    $('retryBtn').hidden = true;
    $('cancelBtn').hidden = false;
    $('cancelBtn').disabled = false;
  }

  // ---- 모바일: 목록과 채팅 중 하나만 보인다 ----
  function showPane(which) {
    document.body.classList.toggle('mobile-chat', which === 'chat');
    document.body.classList.toggle('mobile-list', which === 'list');
  }

  // ---- 작품 ----
  function renderWorks() {
    const list = $('workList');
    clear(list);
    $('workListState').hidden = state.works.length > 0;
    if (!state.works.length) $('workListState').textContent = '작품 파일이 없습니다. data/works 폴더에 작품 JSON을 넣고 새로고침하세요.';
    for (const w of state.works) {
      const li = el('li');
      const btn = el('button', w.id === state.workId ? 'active' : '');
      btn.type = 'button';
      if (w.unreadable) {
        btn.appendChild(el('span', '', `${w.id} (작품 파일을 읽을 수 없음)`));
        btn.appendChild(el('span', 'sub', w.error || ''));
        btn.disabled = true;
      } else {
        btn.appendChild(el('span', '', w.title));
        btn.appendChild(el('span', 'sub', `${w.character} · 기록 대사 ${w.scriptCount}개`));
        btn.addEventListener('click', () => selectWork(w.id));
      }
      li.appendChild(btn);
      list.appendChild(li);
    }
  }

  async function selectWork(id) {
    if (state.busy && id !== state.workId) { setStatus('처리 중에는 작품을 바꿀 수 없습니다.', 'err'); return; }
    state.workId = id;
    renderWorks();
    const w = state.works.find((x) => x.id === id);
    $('workDetail').hidden = !w;
    if (!w) return;
    $('workTitle').textContent = w.title;
    $('workTagline').textContent = w.tagline;
    $('workCharacter').textContent = `상대 캐릭터: ${w.character}`;
    await loadOpening(id);
    renderStartPicker();
    await loadChats();
  }

  // 시작 설정이 둘 이상이면 새 채팅 전에 고른다(크랙의 '시작 설정' 참고). 하나뿐이면 고르기 없이 그대로.
  function renderStartPicker() {
    const box = $('startOptions');
    clear(box);
    const starts = state.workDetail ? state.workDetail.starts : [];
    $('startPicker').hidden = starts.length <= 1;
    if (!starts.some((st) => st.id === state.startId)) state.startId = starts.length ? starts[0].id : null;
    for (const st of starts) {
      const label = el('label', st.id === state.startId ? 'selected' : '');
      const input = document.createElement('input');
      input.type = 'radio'; input.name = 'start'; input.value = st.id; input.checked = st.id === state.startId;
      input.addEventListener('change', () => { state.startId = st.id; renderStartPicker(); });
      label.appendChild(input);
      label.appendChild(el('span', 'name', st.name));
      if (st.situation) label.appendChild(el('span', 'sub', st.situation));
      label.appendChild(el('span', 'sub', `기록 대사 ${st.script.length}개${st.suggestedReplies.length ? ` · 추천 답변 ${st.suggestedReplies.length}개` : ''}`));
      box.appendChild(label);
    }
    // 버튼 이름은 항상 '새 채팅 시작'으로 고정한다(고른 시작은 위 목록의 선택 표시로 충분하고, 이름이 바뀌면 사용자·검사가 버튼을 못 찾는다)
  }

  function startFor(chat) {
    const d = state.workDetail;
    if (!d || d.id !== chat.workId) return null;
    return d.starts.find((st) => st.id === chat.startId) || d.starts[0] || null;
  }

  async function loadChats() {
    if (!state.workId) return;
    $('chatListState').hidden = false;
    try {
      const data = await api('GET', `/api/chats?work=${encodeURIComponent(state.workId)}`);
      state.chats = data.chats;
    } finally {
      $('chatListState').hidden = true;
    }
    renderChats();
  }

  function matchesQuery(c) {
    const q = state.query.trim().toLowerCase();
    if (!q) return true;
    return [c.name, c.lastUserText, c.firstTextAfterBranch].filter(Boolean).some((t) => t.toLowerCase().includes(q));
  }

  function chatButton(c) {
    const btn = el('button', state.chat && state.chat.id === c.id ? 'active' : '');
    btn.type = 'button';
    btn.dataset.chatId = c.id;
    if (c.unreadable) {
      btn.appendChild(el('span', '', `${c.id} (읽을 수 없는 파일)`));
      btn.disabled = true;
      return btn;
    }
    const name = el('span', 'name');
    if (c.branchOf) name.appendChild(el('span', 'branchmark', '↳'));
    name.appendChild(document.createTextNode(c.name || c.title));
    btn.appendChild(name);
    btn.appendChild(el('span', 'sub', `이어 하기 · ${fmtTime(c.lastSavedAt)}`));
    const sub = el('span', 'sub turns', `${c.turnCount}턴`);
    if (c.branchOf) sub.appendChild(el('span', 'tag', `분기 · ${c.branchOf.turnCount}턴에서`));
    if (c.pending) sub.appendChild(el('span', 'flag', '응답 없음'));
    if (c.damagedLines && c.damagedLines.length) sub.appendChild(el('span', 'flag', '손상 줄 있음'));
    if (c.branchIncomplete) sub.appendChild(el('span', 'flag', '잘린 분기'));
    if (c.ended) sub.appendChild(el('span', 'tag', `끝 · ${c.endingName}`));
    if (c.markCount) sub.appendChild(el('span', 'tag', `표시 ${c.markCount}`));
    if (c.startName && state.workDetail && state.workDetail.id === c.workId && state.workDetail.starts.length > 1) sub.appendChild(el('span', 'tag', c.startName));
    btn.appendChild(sub);
    // 같은 턴에서 갈라진 분기들을 구분할 단서: 분기점 뒤 첫 내 말(없으면 표시), 일반 채팅은 마지막 내 말
    const preview = c.branchOf
      ? (c.firstTextAfterBranch ? `다음 말: ${c.firstTextAfterBranch}` : '아직 이어 쓴 말 없음')
      : (c.lastUserText ? `마지막 말: ${c.lastUserText}` : '');
    if (preview) btn.appendChild(el('span', 'sub preview', shorten(preview, 40)));
    btn.addEventListener('click', () => openChat(c.id));
    return btn;
  }

  function renderChats() {
    const list = $('chatList');
    const archivedList = $('archivedList');
    clear(list);
    clear(archivedList);
    const visible = state.chats.filter(matchesQuery);
    const active = visible.filter((c) => !c.archived);
    const archived = visible.filter((c) => c.archived);
    const total = state.chats.filter((c) => !c.archived).length;
    $('chatListEmpty').hidden = !(total === 0 && !state.query.trim());
    $('chatListNoMatch').hidden = !(Boolean(state.query.trim()) && visible.length === 0);
    for (const c of active) { const li = el('li'); li.appendChild(chatButton(c)); list.appendChild(li); }
    const toggle = $('archiveToggle');
    const archivedTotal = state.chats.filter((c) => c.archived).length;
    const searching = Boolean(state.query.trim());
    // 검색 중에 보관된 채팅만 걸리면 빈 화면이 되지 않도록 보관 일치를 자동으로 펼치고 수를 보여준다
    const open = state.archivedOpen || (searching && archived.length > 0);
    toggle.hidden = archivedTotal === 0;
    toggle.textContent = searching
      ? `보관함 (${archivedTotal}) · 검색 일치 ${archived.length}`
      : `보관함 (${archivedTotal})${state.archivedOpen ? ' 접기' : ' 열기'}`;
    toggle.setAttribute('aria-expanded', String(open));
    archivedList.hidden = !open || archived.length === 0;
    for (const c of archived) {
      const li = el('li');
      li.appendChild(chatButton(c));
      const restore = el('button', 'linklike inline', '복구');
      restore.type = 'button';
      restore.disabled = state.busy;
      restore.addEventListener('click', () => setArchived(c.id, false));
      li.appendChild(restore);
      archivedList.appendChild(li);
    }
  }

  // ---- 채팅 ----
  async function newChat() {
    if (!state.workId || state.busy) return;
    setBusy(true);
    try {
      const data = await api('POST', '/api/chats', { workId: state.workId, startId: state.startId || undefined });
      await loadChats();
      showChat(data.chat);
      setStatus('새 채팅을 만들고 저장했습니다.', 'ok');
    } catch (err) {
      setStatus(`새 채팅을 만들지 못했습니다: ${err.message}`, 'err');
    } finally {
      setBusy(false);
    }
  }

  async function openChat(id) {
    if (state.busy) { setStatus('처리 중에는 다른 채팅으로 바꿀 수 없습니다. 잠시 뒤 다시 눌러 주세요.', 'err'); return false; }
    try {
      const data = await api('GET', `/api/chats/${encodeURIComponent(id)}`);
      if (data.chat.workId !== state.workId) await selectWork(data.chat.workId);
      showChat(data.chat);
      setStatus(`저장된 채팅을 다시 열었습니다 · 마지막 저장 ${fmtTime(data.chat.lastSavedAt)}`, 'ok');
      return true;
    } catch (err) {
      setStatus(`채팅을 열지 못했습니다: ${err.message}`, 'err');
      if (recall() === id) remember(null); // 시작 복원에 실패한 경우만 기억을 지운다. 보고 있던 채팅의 기억은 유지
      return false;
    }
  }

  function showChat(chat) {
    state.chat = chat;
    remember(chat.id);
    $('emptyState').hidden = true;
    $('connState').hidden = true;
    $('chatView').hidden = false;
    $('renameForm').hidden = true;
    renderChats();
    showPane('chat'); // 먼저 보여야 한다: 숨긴 채 그리면 scrollHeight가 0이라 모바일에서 맨 위(프롤로그)에 멈춘다
    renderChat();
    if (!chat.archived) $('input').focus();
  }

  function renderChat() {
    const chat = state.chat;
    const work = state.works.find((w) => w.id === chat.workId) || { character: chat.character || '캐릭터' };
    const start = startFor(chat);
    const multiStart = state.workDetail && state.workDetail.id === chat.workId && state.workDetail.starts.length > 1;
    $('chatTitle').textContent = `${chat.name || chat.title} · ${chat.character || work.character}${multiStart && start ? ` · ${start.name}` : ''}`;
    $('chatMeta').textContent = `${chat.turnCount}턴 · 마지막 저장 ${fmtTime(chat.lastSavedAt)} · ${chat.responderLabel || ''}`;
    $('archiveBtn').textContent = chat.archived ? '복구' : '보관';

    const notices = $('notices');
    clear(notices);
    if (chat.archived) {
      notices.appendChild(el('div', 'info archived', `보관된 채팅입니다(${fmtTime(chat.archivedAt)}). 읽을 수 있지만 이어 쓰려면 위의 '복구'를 누르세요. 여기서 새 전개를 만드는 것은 가능합니다.`));
    }
    if (chat.damagedLines && chat.damagedLines.length) {
      notices.appendChild(el('div', 'notice', `채팅 파일의 ${chat.damagedLines.join(', ')}번째 줄이 손상돼 건너뛰었습니다. 나머지 턴은 그대로 보입니다.`));
    }
    if (chat.chainBreaks && chat.chainBreaks.length) {
      notices.appendChild(el('div', 'notice', `턴 ${chat.chainBreaks.length}개의 이전 턴 연결이 어긋나 있습니다(파일이 편집됐거나 일부가 빠졌을 수 있음). 표시는 파일 순서를 따릅니다.`));
    }
    if (chat.branchIncomplete) {
      notices.appendChild(el('div', 'notice', `이 분기는 ${chat.branchOf.turnCount}턴을 복제했어야 하는데 ${chat.turnCount}턴만 있습니다(복제가 중단됐거나 파일이 편집됨). 출처 채팅에서 다시 새 전개를 만드는 편이 안전합니다.`));
    }
    if (chat.startMissing) {
      notices.appendChild(el('div', 'notice', `이 채팅의 시작 설정(${chat.startName || chat.startId})이 지금 작품 파일에 없습니다. 첫 시작 설정의 대본·안내로 이어 갑니다. 원문은 그대로입니다.`));
    }
    if (chat.importedFrom) {
      const wasArchived = chat.importedFrom.wasArchived ? ' 내보낼 때는 보관 상태였지만 활성 채팅으로 가져왔습니다(필요하면 다시 보관하세요).' : '';
      notices.appendChild(el('div', 'info', `가져온 채팅입니다(${fmtTime(chat.importedFrom.importedAt)}, 원래 id ${chat.importedFrom.originalId}). 원본 파일과는 별개의 채팅으로 저장됐습니다.${wasArchived}`));
    }
    if (chat.branchOf) {
      const dmg = chat.branchOf.sourceDamagedLines && chat.branchOf.sourceDamagedLines.length ? ' 출처에 손상 줄이 있었고 손상 앞 구간만 복제했습니다.' : '';
      if (chat.branchSourceExists === false) {
        notices.appendChild(el('div', 'info', `이 채팅은 다른 채팅의 ${chat.branchOf.turnCount}턴까지를 복제해 갈라져 나왔지만, 출처 채팅(id ${chat.branchOf.chatId})은 이 컴퓨터에 없습니다(가져온 파일이거나 출처가 옮겨졌을 수 있음).${dmg}`));
      } else {
        const info = el('div', 'info', `이 채팅은 다른 채팅의 ${chat.branchOf.turnCount}턴까지를 복제해 갈라져 나왔습니다. 출처는 그대로 남아 있습니다.${dmg} `);
        const openSrc = el('button', 'linklike', '출처 채팅 열기');
        openSrc.type = 'button';
        openSrc.disabled = state.busy;
        openSrc.addEventListener('click', () => openChat(chat.branchOf.chatId));
        info.appendChild(openSrc);
        notices.appendChild(info);
      }
    }

    const box = $('messages');
    clear(box);
    if (start) {
      const scene = el('div', 'scene');
      scene.appendChild(el('span', 'who', `시작 장면 · 작품 설정(대화 기록 아님)${multiStart ? ` · ${start.name}` : ''}`));
      scene.appendChild(document.createTextNode(start.opening));
      box.appendChild(scene);
    }
    for (const t of chat.turns) {
      const m = el('div', `msg ${t.role === 'user' ? 'user' : 'assistant'}`);
      m.dataset.role = t.role === 'user' ? 'user' : 'assistant';
      m.dataset.turnId = t.id;
      if (t.ending) m.classList.add('endingturn');
      const who = el('span', 'who', t.role === 'user' ? '나' : (chat.character || work.character));
      if (t.role === 'assistant') {
        const tagText = t.responder === 'recorded' ? '임시 응답' : (t.responder === 'model' ? `모델 응답${t.model ? ` · ${t.model}` : ''}` : (t.responder || '응답'));
        const tag = el('span', 'tag', tagText);
        if (t.ctx) {
          const c = t.ctx;
          const parts = [`문맥: 최근 ${c.includedTurns}턴(${c.droppedTurns}턴 생략), 히스토리 ${c.historyChars}자, 시스템 ${c.systemChars || '?'}자`];
          if (c.promptTokens || c.promptTokensEstimate) parts.push(`프롬프트 토큰 ${c.promptTokens || `약 ${c.promptTokensEstimate}`}`);
          if (c.shrinkSteps) parts.push(`예산 축소 ${c.shrinkSteps}회`);
          if (c.retriedAfterContextError) parts.push('문맥 초과로 재시도함');
          if (c.chainBreakCut) parts.push(`끊긴 사슬 앞 ${c.chainBreakCut}턴 제외`);
          tag.title = parts.join(' · ');
        }
        who.appendChild(tag);
      }
      m.appendChild(who);
      m.appendChild(document.createTextNode(t.text));
      const isMarked = Array.isArray(chat.marks) && chat.marks.some((mk) => mk.turnId === t.id);
      if (isMarked) { m.classList.add('marked'); who.appendChild(el('span', 'marktag', '표시한 장면')); }
      if (t.responder === 'recorded' && t.scriptIndex === null && !t.ending) {
        // 대본이 끝나 준비된 예비 문장임을 캐릭터 말풍선 밖에서 밝힌다(구현 사정이 대사에 섞이지 않게)
        m.appendChild(el('div', 'aside', '작품에 적힌 대사가 끝나 준비된 마무리 문장입니다.'));
      }
      const actions = el('div', 'actions');
      const markBtn = el('button', 'linklike', isMarked ? '표시 해제' : '장면 표시');
      markBtn.type = 'button';
      markBtn.disabled = state.busy || Boolean(chat.archived);
      markBtn.title = isMarked ? '다시 읽을 장면 표시를 해제합니다(원문은 그대로).' : '다시 읽을 장면으로 표시합니다. 사실 확정이나 캐릭터의 기억이 아닙니다.';
      markBtn.addEventListener('click', () => toggleMark(t.id, !isMarked));
      actions.appendChild(markBtn);
      const branchBtn = el('button', 'linklike', '여기서 새 전개');
      branchBtn.type = 'button';
      branchBtn.disabled = state.busy;
      branchBtn.title = '이 턴까지를 복제한 새 채팅을 만듭니다. 이 채팅은 그대로 남습니다.';
      branchBtn.addEventListener('click', () => branchFrom(t.id));
      actions.appendChild(branchBtn);
      m.appendChild(actions);
      box.appendChild(m);
    }
    if (chat.ended) box.appendChild(endingBlock(chat));
    box.appendChild(toLatestButton(chat));
    renderRecap(chat, work);
    renderStarters(chat);
    // 바닥으로 보내는 것은 지난 이야기·추천 답변이 자리를 잡은 뒤여야 한다(먼저 보내면 패널이 펼쳐지며 마지막 말이 가려진다)
    box.scrollTop = box.scrollHeight;
    updateToLatest();

    // pending: 사용자 턴 뒤 응답이 없다. inflight면 서버가 아직 만드는 중이므로 실패로 보이지 않게 하고 잠시 뒤 다시 확인한다.
    $('pendingBox').hidden = !chat.pending;
    $('pendingText').textContent = chat.inflight
      ? '응답을 만드는 중입니다(다른 탭이나 새로고침 전 요청). 잠시 뒤 자동으로 확인합니다.'
      : (chat.archived ? '이 입력에는 아직 응답이 없습니다. 복구한 뒤 다시 생성을 누르면 응답을 만듭니다.' : '이 입력에는 아직 응답이 없습니다. 입력은 저장돼 있고, 다시 생성을 누르면 응답을 만듭니다.');
    $('retryBtn').hidden = Boolean(chat.inflight) || Boolean(chat.archived);
    $('cancelBtn').hidden = !(chat.inflight && chat.canCancel); // 모델 응답기처럼 취소를 지원할 때만
    $('sendBtn').disabled = state.busy || Boolean(chat.archived);
    $('input').disabled = state.busy || Boolean(chat.archived);
    $('input').placeholder = chat.ended
      ? '이 이야기는 끝났습니다. 다른 시작으로 새 채팅을 시작하거나 앞 장면에서 새 전개를 만드세요'
      : (chat.archived ? '보관된 채팅은 복구한 뒤 이어 쓸 수 있습니다' : `${chat.character || work.character}에게 말을 건다…`);
    scheduleRecheck(chat);
  }

  // '지난 이야기' 패널: 저장된 마지막 발화(발화자 보존)와 내가 표시한 장면의 원문 발췌. 요약·새 사실을 만들지 않는다.
  function renderRecap(chat, work) {
    const recap = $('recap');
    const last = $('recapLast');
    const marksBox = $('recapMarks');
    clear(last); clear(marksBox);
    const speaker = (t) => (t.role === 'user' ? '나' : (chat.character || work.character));
    const excerpt = (t, n) => shorten(t.text.replace(/\s+/g, ' ').trim(), n);
    if (!chat.turns.length && !(chat.marks && chat.marks.length)) { recap.hidden = true; return; }
    recap.hidden = false;
    const marks = chat.marks || [];
    $('recapSummary').textContent = `지난 이야기 · 마지막 저장 ${fmtTime(chat.lastSavedAt)} · ${chat.turnCount}턴${marks.length ? ` · 표시한 장면 ${marks.length}개` : ''}`;
    // 마지막 장면: 저장된 마지막 두 발화를 발화자와 함께 그대로 인용한다
    const tail = chat.turns.slice(-2);
    for (const t of tail) {
      const line = el('div', 'line');
      line.appendChild(el('span', 'who', `${speaker(t)}:`));
      line.appendChild(el('span', 'excerpt', `"${excerpt(t, 120)}"`));
      last.appendChild(line);
    }
    if (chat.pending) {
      last.appendChild(el('div', 'line muted', chat.inflight
        ? '마지막 입력의 응답을 지금 만드는 중입니다.'
        : '마지막 입력은 저장됐지만 응답이 없습니다. 이어 쓰려면 다시 생성을 누르세요.'));
    }
    if (marks.length) {
      const LIMIT = 5;
      const showAll = state.recapShowAll;
      const list = el('ul');
      const items = showAll ? marks : marks.slice(0, LIMIT);
      for (const mk of items) {
        const t = chat.turns.find((x) => x.id === mk.turnId);
        if (!t) continue;
        const li = el('li');
        li.appendChild(el('span', 'who', `${speaker(t)}:`));
        li.appendChild(el('span', 'excerpt', `"${excerpt(t, 80)}"`));
        const go = el('button', 'linklike', '원문으로');
        go.type = 'button';
        go.addEventListener('click', () => jumpToTurn(t.id));
        li.appendChild(go);
        list.appendChild(li);
      }
      marksBox.appendChild(el('div', 'line', `표시한 장면 ${marks.length}개(원문 순서)`));
      marksBox.appendChild(list);
      if (marks.length > LIMIT) {
        const more = el('button', 'linklike', showAll ? '접기' : `모두 보기(${marks.length - LIMIT}개 더)`);
        more.type = 'button';
        more.addEventListener('click', () => { state.recapShowAll = !state.recapShowAll; renderRecap(chat, work); });
        marksBox.appendChild(more);
      }
      recap.open = true; // 표시가 있으면 다시 열 때 펼쳐 보인다
    }
  }

  // 완결: 이야기가 끝났을 때의 마무리 화면. 다음에 할 수 있는 일을 함께 둔다(다른 결말 만들기 / 처음부터 읽기).
  function endingBlock(chat) {
    const box = el('div', 'endingblock');
    box.appendChild(el('div', 'endtitle', `이야기의 끝 · ${chat.endingName}`));
    box.appendChild(el('div', 'line', `총 ${chat.turnCount}턴${chat.markCount ? ` · 표시한 장면 ${chat.markCount}개` : ''} · 마지막 저장 ${fmtTime(chat.lastSavedAt)}`));
    box.appendChild(el('div', 'line muted', '이 채팅은 여기서 끝납니다. 원문은 그대로 남아 언제든 다시 읽을 수 있습니다. 이 시작의 결말은 하나이며, 다른 결말은 다른 시작 설정에 있습니다.'));
    const actions = el('div', 'actions');
    const multi = state.workDetail && state.workDetail.id === chat.workId && state.workDetail.starts.length > 1;
    if (multi) {
      const other = el('button', 'linklike', '다른 시작으로 새 채팅');
      other.type = 'button';
      other.disabled = state.busy;
      other.title = '시작 설정마다 결말이 다릅니다. 왼쪽에서 다른 시작을 골라 새 채팅을 시작하세요.';
      other.addEventListener('click', () => {
        showPane('list');
        const picker = $('startPicker');
        picker.scrollIntoView({ block: 'center' });
        const next = state.workDetail.starts.find((st) => st.id !== chat.startId);
        if (next) { state.startId = next.id; renderStartPicker(); }
        setStatus('다른 시작 설정을 골랐습니다. 새 채팅 시작을 누르면 그 시작의 이야기가 열립니다.', 'ok');
      });
      actions.appendChild(other);
    }
    const toTop = el('button', 'linklike', '처음부터 읽기');
    toTop.type = 'button';
    toTop.addEventListener('click', () => { const m = $('messages'); m.scrollTop = 0; });
    actions.appendChild(toTop);
    box.appendChild(actions);
    return box;
  }

  function jumpToTurn(turnId) {
    const node = document.querySelector(`[data-turn-id="${turnId}"]`);
    if (!node) return;
    node.scrollIntoView({ block: 'center' });
    node.classList.add('flash');
    setTimeout(() => node.classList.remove('flash'), 1600);
    updateToLatest();
    setStatus('표시한 장면의 원문으로 갔습니다. 아래 "최근 대화로"를 누르면 마지막 말로 돌아옵니다.', 'ok');
  }

  // 최근 대화로: 원문으로 갔다가 마지막 말로 돌아오는 길. 긴 채팅에서 표시한 장면을 읽은 뒤 수십 화면을 손으로 내리지 않게 한다.
  // 스크롤 위치만 바꾸며 저장·표시·응답기에는 손대지 않는다. 바닥 가까이(마지막 말이 보일 때)에서는 숨긴다.
  function toLatestButton(chat) {
    const btn = el('button', 'tolatest', '최근 대화로 ↓');
    btn.id = 'toLatest';
    btn.type = 'button';
    btn.hidden = true;
    btn.title = `마지막 말(${chat.turnCount}턴)로 내려갑니다. 원문은 그대로입니다.`;
    btn.addEventListener('click', () => {
      const box = $('messages');
      box.scrollTop = box.scrollHeight;
      updateToLatest();
      setStatus('최근 대화로 돌아왔습니다.', 'ok');
    });
    return btn;
  }
  function updateToLatest() {
    const box = $('messages');
    const btn = $('toLatest');
    if (!btn) return;
    const fromBottom = box.scrollHeight - box.scrollTop - box.clientHeight;
    btn.hidden = fromBottom < 160; // 마지막 말이 보이는 거리면 필요 없다
  }

  // 장면 표시/해제. 안내는 실제 근거대로 네 갈래로 나눈다:
  // 저장 전 명확한 거부(4xx) / 저장 성공 / 저장 여부를 확정할 수 없는 응답(네트워크 오류·응답 소실·5xx) → 서버 상태를 한 번 다시 읽어 수렴,
  // 그것도 안 되면 '미확정' / 저장(또는 재확인) 뒤 목록 갱신 실패는 별도 안내. 화면은 항상 서버가 돌려준 상태로만 그린다(낙관적 표시 없음).
  async function refreshListAfterMark(okText) {
    try {
      await loadChats(); // 목록의 '표시 n' 갱신. 실패해도 저장 결과는 그대로다
      setStatus(okText, 'ok');
    } catch (err) {
      setStatus(`${okText} 다만 채팅 목록을 갱신하지 못해 목록의 '표시 n' 숫자가 오래됐을 수 있습니다(${err.message}).`, 'err');
    }
  }

  async function toggleMark(turnId, marked) {
    if (!state.chat || state.busy) return;
    const chatId = state.chat.id;
    const okText = marked ? '장면을 표시했습니다. 다시 열 때 지난 이야기에서 원문으로 갈 수 있습니다.' : '장면 표시를 해제했습니다. 원문은 그대로 있습니다.';
    setBusy(true);
    try {
      let saved;
      try {
        const data = await api('POST', `/api/chats/${encodeURIComponent(chatId)}/marks`, { turnId, marked });
        saved = data.chat;
      } catch (err) {
        if (err.status >= 400 && err.status < 500) { // 서버가 저장 전에 명확히 거부했다(잘못된 대상·보관 중 등) → 저장되지 않았음이 확실
          setStatus(`장면 표시를 저장하지 않았습니다: ${err.message}`, 'err');
          return;
        }
        // 네트워크 오류·응답 소실·5xx(저장 뒤 읽기 실패 등): 서버에 저장됐을 수도 있다 → 한 번 다시 읽어 실제 상태로 맞춘다
        setStatus('저장 여부를 확정할 수 없는 응답입니다. 서버 상태를 확인하는 중…', 'err');
        try {
          const check = await api('GET', `/api/chats/${encodeURIComponent(chatId)}`);
          const now = Boolean(check.chat.marks && check.chat.marks.some((mk) => mk.turnId === turnId));
          if (state.chat && state.chat.id === chatId) { state.chat = check.chat; renderChat(); }
          if (now === marked) await refreshListAfterMark(`${okText} (응답이 불확실해 서버 상태를 다시 확인했습니다.)`);
          else setStatus(marked ? '장면 표시가 저장되지 않았습니다. 다시 눌러 주세요.' : '장면 표시 해제가 저장되지 않았습니다. 다시 눌러 주세요.', 'err');
        } catch {
          // 확인도 안 되면 마지막으로 확인된 화면임을 밝히고 저장 여부를 단정하지 않는다
          setStatus('장면 표시가 저장됐는지 확인하지 못했습니다(서버에 닿지 않음). 지금 보이는 표시는 마지막으로 확인된 상태이며, 이 채팅을 다시 열면 실제 저장 상태로 맞춰집니다.', 'err');
        }
        return;
      }
      if (state.chat && state.chat.id === chatId) { state.chat = saved; renderChat(); }
      await refreshListAfterMark(okText);
    } finally {
      setBusy(false);
    }
  }

  function scheduleRecheck(chat) {
    if (state.recheckTimer) { clearTimeout(state.recheckTimer); state.recheckTimer = null; }
    if (!chat.pending || !chat.inflight) return;
    state.recheckTimer = setTimeout(async () => {
      state.recheckTimer = null;
      if (state.busy || !state.chat || state.chat.id !== chat.id) return;
      try { await refreshChat(); } catch { /* 서버 다운이면 다음 사용자 행동 때 다시 시도 */ }
      if (state.chat && state.chat.id === chat.id && !state.chat.pending) setStatus(`응답이 도착해 저장됐습니다 · ${fmtTime(state.chat.lastSavedAt)}`, 'ok');
    }, 1000);
  }

  async function refreshChat() {
    const data = await api('GET', `/api/chats/${encodeURIComponent(state.chat.id)}`);
    state.chat = data.chat;
    renderChat();
    await loadChats();
    return data.chat;
  }

  async function send() {
    if (!state.chat || state.busy) return;
    if (state.chat.archived) { setStatus('보관된 채팅입니다. 복구한 뒤 이어 쓸 수 있습니다.', 'err'); return; }
    const input = $('input');
    const text = input.value.trim();
    if (!text) { setStatus('빈 입력은 보낼 수 없습니다.', 'err'); return; }
    const chatId = state.chat.id;
    // 같은 채팅에서 서버에 닿았는지 확인 못 한 이전 전송과 같은 내용이면 같은 id를 재사용해 중복 저장을 막는다.
    const u = state.unconfirmed;
    const clientTurnId = (u && u.chatId === chatId && u.text === text) ? u.id : newClientId();
    setBusy(true);
    setStatus('입력 저장·응답 요청 중…');
    showWaiting('응답을 만드는 중입니다. 오래 걸리면 취소할 수 있습니다(입력은 저장돼 있습니다).');
    try {
      const data = await api('POST', `/api/chats/${encodeURIComponent(chatId)}/turns`, { text, clientTurnId });
      state.unconfirmed = null;
      if (!state.chat || state.chat.id !== chatId) { // 기다리는 동안 다른 채팅으로 옮겨 갔다면 그 화면을 건드리지 않는다
        await loadChats();
        setStatus('이전 채팅의 입력과 응답이 저장됐습니다. 지금 보는 채팅은 그대로입니다.', 'ok');
        return;
      }
      state.chat = data.chat;
      input.value = '';
      renderChat();
      await loadChats();
      if (data.chat.replied) setStatus(`저장됨 · ${fmtTime(data.chat.lastSavedAt)}${data.chat.duplicate ? ' (이미 저장된 입력이라 다시 저장하지 않음)' : ''}`, 'ok');
      else if (/취소/.test(data.chat.replyError || '')) setStatus('응답 요청을 취소했습니다. 입력은 저장돼 있고 다시 생성할 수 있습니다.', 'ok');
      else setStatus(`입력은 저장됐지만 응답을 만들지 못했습니다: ${data.chat.replyError || '원인 미상'}`, 'err');
    } catch (err) {
      if (err.code === 'PENDING' || err.code === 'BUSY' || err.code === 'ARCHIVED' || err.code === 'ENDED') {
        state.unconfirmed = null;
        if (state.chat && state.chat.id === chatId) await refreshChat();
        setStatus(err.message, 'err');
      } else if (err.status) {
        state.unconfirmed = null;
        setStatus(`보내지 못했습니다: ${err.message}`, 'err');
      } else {
        // 네트워크 실패: 서버가 입력을 저장했는지 알 수 없다 → 다시 읽어서 확인한다.
        state.unconfirmed = { id: clientTurnId, text, chatId };
        setStatus('서버에 닿지 못했습니다. 저장 여부를 확인하는 중…', 'err');
        try {
          if (!state.chat || state.chat.id !== chatId) return;
          const chat = await refreshChat();
          const saved = chat.turns.some((t) => t.role === 'user' && t.clientTurnId === clientTurnId);
          if (saved) {
            state.unconfirmed = null;
            input.value = '';
            setStatus(chat.pending ? '입력은 저장됐지만 응답이 없습니다. 다시 생성을 눌러 주세요.' : `저장됨 · ${fmtTime(chat.lastSavedAt)}`, chat.pending ? 'err' : 'ok');
          } else {
            setStatus('저장되지 않았습니다. 입력을 그대로 두었으니 다시 보내기를 눌러 주세요.', 'err');
          }
        } catch {
          setStatus('서버가 응답하지 않습니다. 서버를 확인한 뒤 같은 내용을 다시 보내면 중복 저장되지 않습니다.', 'err');
        }
      }
    } finally {
      setBusy(false);
      input.focus();
    }
  }

  // 분기: 이 턴까지 복제한 새 채팅을 만들고 그 채팅으로 이동한다. 원래 채팅은 바뀌지 않는다.
  async function branchFrom(turnId) {
    if (!state.chat || state.busy) { if (state.busy) setStatus('처리 중에는 새 전개를 만들 수 없습니다.', 'err'); return; }
    const sourceId = state.chat.id;
    const upTo = state.chat.turns.findIndex((t) => t.id === turnId) + 1;
    setBusy(true);
    setStatus('이 턴까지 복제해 새 채팅을 만드는 중…');
    try {
      const data = await api('POST', `/api/chats/${encodeURIComponent(sourceId)}/branch`, { turnId });
      await loadChats();
      showChat(data.chat);
      const fromUser = data.chat.pending;
      setStatus(fromUser
        ? `${upTo}턴까지 복제한 새 채팅입니다. 복제된 내 말은 그대로 두고 응답만 새로 만듭니다(다시 생성). 내 말을 바꾸려면 그 앞 캐릭터 말에서 새 전개를 누르세요.`
        : `${upTo}턴까지 복제한 새 채팅입니다. 여기부터 다른 말로 이어 가세요. 원래 채팅은 그대로 있습니다.`, 'ok');
    } catch (err) {
      setStatus(`새 전개를 만들지 못했습니다: ${err.message}`, 'err');
    } finally {
      setBusy(false);
    }
  }

  async function cancelReply() {
    if (!state.chat) return;
    const chatId = state.chat.id;
    $('cancelBtn').disabled = true; // 두 번 누름 방지
    try {
      const data = await api('POST', `/api/chats/${encodeURIComponent(chatId)}/cancel`, {});
      if (data.chat.cancelled) {
        // 같은 탭에서 기다리던 요청이면 그 요청이 취소 결과로 돌아와 화면을 그린다. 다른 탭 요청이었으면 여기서 다시 읽는다.
        if (!state.busy && state.chat && state.chat.id === chatId) await refreshChat();
        setStatus('응답 요청을 취소했습니다. 입력은 저장돼 있고 다시 생성할 수 있습니다.', 'ok');
      } else {
        setStatus('취소할 진행 중 요청이 없습니다.', 'err');
        if (!state.busy && state.chat && state.chat.id === chatId) await refreshChat();
      }
    } catch (err) {
      setStatus(`취소하지 못했습니다: ${err.message}`, 'err');
    } finally {
      $('cancelBtn').disabled = false;
    }
  }

  async function retry() {
    if (!state.chat || state.busy) return;
    const chatId = state.chat.id;
    setBusy(true);
    setStatus('응답을 다시 만드는 중…');
    showWaiting('응답을 다시 만드는 중입니다. 오래 걸리면 취소할 수 있습니다.');
    try {
      const data = await api('POST', `/api/chats/${encodeURIComponent(chatId)}/retry`, {});
      if (!state.chat || state.chat.id !== chatId) { await loadChats(); return; }
      state.chat = data.chat;
      renderChat();
      await loadChats();
      if (data.chat.replied) setStatus(data.chat.noop ? '이미 응답이 있어 새로 만들지 않았습니다.' : `응답을 저장했습니다 · ${fmtTime(data.chat.lastSavedAt)}`, 'ok');
      else setStatus(`다시 실패했습니다: ${data.chat.replyError || '원인 미상'}`, 'err');
    } catch (err) {
      setStatus(`다시 생성 실패: ${err.message}`, 'err');
      try { await refreshChat(); } catch { /* 서버 다운 */ }
    } finally {
      setBusy(false);
    }
  }

  // ---- 이름 바꾸기 · 보관 · 복구 · 내보내기 ----
  function startRename() {
    if (!state.chat || state.busy) return;
    $('renameForm').hidden = false;
    $('renameInput').value = state.chat.name || state.chat.title;
    $('renameInput').focus();
    $('renameInput').select();
  }

  async function submitRename() {
    if (!state.chat || state.busy) return;
    const name = $('renameInput').value.trim();
    if (!name) { setStatus('이름은 비울 수 없습니다.', 'err'); return; }
    const chatId = state.chat.id;
    setBusy(true);
    try {
      const data = await api('PATCH', `/api/chats/${encodeURIComponent(chatId)}`, { name });
      if (state.chat && state.chat.id === chatId) { state.chat = data.chat; renderChat(); }
      $('renameForm').hidden = true;
      await loadChats();
      setStatus(`이름을 '${data.chat.name}'으로 바꿨습니다.`, 'ok');
    } catch (err) {
      setStatus(`이름을 바꾸지 못했습니다: ${err.message}`, 'err');
    } finally {
      setBusy(false);
    }
  }

  async function setArchived(chatId, archived) {
    if (state.busy) return;
    setBusy(true);
    try {
      const data = await api('PATCH', `/api/chats/${encodeURIComponent(chatId)}`, { archived });
      if (state.chat && state.chat.id === chatId) { state.chat = data.chat; renderChat(); }
      if (archived) state.archivedOpen = true;
      await loadChats();
      setStatus(archived
        ? `'${data.chat.name}'을(를) 보관함으로 옮겼습니다. 파일은 그대로 있고 보관함에서 복구할 수 있습니다.`
        : `'${data.chat.name}'을(를) 복구했습니다. 이어 쓸 수 있습니다.`, 'ok');
    } catch (err) {
      setStatus(`${archived ? '보관' : '복구'}하지 못했습니다: ${err.message}`, 'err');
    } finally {
      setBusy(false);
    }
  }

  function exportChat() {
    if (!state.chat || state.busy) return;
    // 서버가 저장 파일을 그대로 내려준다(Content-Disposition). 새 탭 없이 다운로드된다.
    const a = document.createElement('a');
    a.href = `/api/chats/${encodeURIComponent(state.chat.id)}/export`;
    a.download = '';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setStatus('채팅 파일(JSONL)을 내려받습니다. 같은 작품이 있는 곳에서 가져오기로 별도 채팅으로 복원할 수 있습니다.', 'ok');
  }

  // ---- 가져오기: 내보낸 파일을 검증한 뒤 별도 채팅으로 저장한다 ----
  function showImportErrors(title, errors) {
    const box = $('importErrors');
    clear(box);
    box.hidden = false;
    box.appendChild(el('strong', '', title));
    if (errors && errors.length) {
      const ul = el('ul');
      for (const e of errors) ul.appendChild(el('li', '', e.line ? `${e.line}번째 줄: ${e.message}` : e.message));
      box.appendChild(ul);
    }
    const close = el('button', 'linklike', '닫기');
    close.type = 'button';
    close.addEventListener('click', () => { box.hidden = true; });
    box.appendChild(close);
  }

  async function importFile(file) {
    if (!file || state.busy) return;
    $('importErrors').hidden = true;
    if (file.size > 4 * 1024 * 1024) { showImportErrors(`'${file.name}'은(는) 4MB를 넘어 가져올 수 없습니다.`, []); return; }
    setBusy(true);
    setStatus(`'${file.name}' 검증 중…`);
    try {
      const text = await file.text();
      const data = await api('POST', '/api/chats/import', { jsonl: text });
      await loadChats();
      showChat(data.chat);
      const st = data.chat.importStats || {};
      const archNote = data.chat.importedFrom && data.chat.importedFrom.wasArchived ? ' 내보낼 때는 보관 상태였지만 활성으로 가져왔습니다.' : '';
      setStatus(`'${file.name}'을(를) 검증해 별도 채팅으로 가져왔습니다(${st.turnCount || data.chat.turnCount}턴). 원본 파일은 바뀌지 않습니다.${archNote}`, 'ok');
    } catch (err) {
      if (err.code === 'BAD_IMPORT') {
        const details = err.details || [];
        const capped = details.length >= 20 ? ' 문제가 더 있을 수 있어 처음 20개만 보여줍니다.' : '';
        showImportErrors(`'${file.name}'을(를) 가져올 수 없습니다. 아무것도 저장하지 않았습니다.${capped}`, details);
        setStatus('가져오기를 취소했습니다. 위 오류를 확인해 주세요.', 'err');
      } else {
        showImportErrors(`가져오기 실패: ${err.message}`, []);
        setStatus(`가져오기 실패: ${err.message}`, 'err');
      }
    } finally {
      setBusy(false);
      $('importFile').value = '';
    }
  }

  // ---- 시작 ----
  async function loadOpening(workId) {
    const data = await api('GET', `/api/works/${encodeURIComponent(workId)}`);
    state.workDetail = data.work; // starts 포함. 채팅마다 자기 시작 설정의 내용을 쓴다
    state.opening = { id: workId, text: data.work.opening, playGuide: data.work.playGuide || '', suggestedReplies: data.work.suggestedReplies || [] };
  }

  // 재시동 도움(모델 없음): 작품에 적힌 플레이 가이드(사용자 전용)와, 아직 아무 말도 없는 채팅에서만 보이는 시작 추천 답변.
  // 대화 중 추천 답변은 모델이 필요하므로 여기서는 만들지 않는다.
  function renderStarters(chat) {
    const info = startFor(chat);
    const guide = $('guide');
    const starters = $('starters');
    const chips = $('starterChips');
    clear(chips);
    const hint = info && info.ending && info.ending.hint ? info.ending.hint : '';
    if (!info || (!info.playGuide && !hint)) { guide.hidden = true; } else {
      guide.hidden = false;
      $('guideText').textContent = info.playGuide || '';
      const hintNode = $('guideHint');
      hintNode.hidden = !hint || chat.ended;
      hintNode.textContent = hint ? `끝을 향한 단서: ${hint}` : '';
    }
    const canStart = info && info.suggestedReplies.length && chat.turns.length === 0 && !chat.archived && !chat.ended;
    starters.hidden = !canStart;
    if (!canStart) return;
    for (const r of info.suggestedReplies) {
      const b = el('button', '', r);
      b.type = 'button';
      b.title = '입력창에 넣습니다. 고쳐서 보내도 됩니다.';
      b.addEventListener('click', () => { if (state.busy) return; $('input').value = r; $('input').focus(); setStatus('추천 답변을 입력창에 넣었습니다. 그대로 보내거나 고쳐서 보내세요.', 'ok'); });
      chips.appendChild(b);
    }
  }

  function bind() {
    $('sendForm').addEventListener('submit', (e) => { e.preventDefault(); send(); });
    $('input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
    });
    $('retryBtn').addEventListener('click', retry);
    $('cancelBtn').addEventListener('click', cancelReply);
    $('newChatBtn').addEventListener('click', newChat);
    $('renameBtn').addEventListener('click', startRename);
    $('renameForm').addEventListener('submit', (e) => { e.preventDefault(); submitRename(); });
    $('renameCancel').addEventListener('click', () => { $('renameForm').hidden = true; });
    $('archiveBtn').addEventListener('click', () => { if (state.chat) setArchived(state.chat.id, !state.chat.archived); });
    $('exportBtn').addEventListener('click', exportChat);
    $('archiveToggle').addEventListener('click', () => { state.archivedOpen = !state.archivedOpen; renderChats(); });
    $('chatSearch').addEventListener('input', (e) => { state.query = e.target.value; renderChats(); });
    $('toggleListBtn').addEventListener('click', () => showPane('list'));
    $('messages').addEventListener('scroll', updateToLatest, { passive: true });
    $('importBtn').addEventListener('click', () => { if (!state.busy) $('importFile').click(); });
    $('importFile').addEventListener('change', (e) => importFile(e.target.files && e.target.files[0]));
    $('reconnectBtn').addEventListener('click', init);
  }

  async function init() {
    $('connState').hidden = true;
    $('workListState').hidden = false;
    $('workListState').textContent = '불러오는 중…';
    $('responderBadge').textContent = '응답기 확인 중…';
    try {
      const meta = await api('GET', '/api/meta');
      $('responderBadge').textContent = meta.responderLabel;
      state.canCancel = Boolean(meta.canCancel);
      const data = await api('GET', '/api/works');
      state.works = data.works;
      renderWorks();
      if (state.works.length) await selectWork(state.works[0].id);
      const last = recall();
      if (last) await openChat(last);
      if (!state.chat) showPane('list');
    } catch (err) {
      const serverError = Boolean(err.status);
      $('responderBadge').textContent = serverError ? '서버 오류' : '서버 연결 실패';
      $('workListState').textContent = serverError ? '서버가 오류를 돌려줬습니다.' : '서버에 연결하지 못했습니다.';
      $('connText').textContent = serverError
        ? `서버가 오류를 돌려줬습니다: ${err.message}`
        : `서버에 연결하지 못했습니다(${err.message}). 터미널에서 node server.js 가 켜져 있는지 확인한 뒤 다시 연결을 누르세요.`;
      $('emptyState').hidden = true;
      $('connState').hidden = false;
      setStatus(serverError ? `서버가 오류를 돌려줬습니다: ${err.message}` : `서버에 연결하지 못했습니다: ${err.message}`, 'err');
    }
  }

  bind();
  init();
})();
