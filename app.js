/* =========================================================
   Otaku Chat — App logic
   Single public room. Persistent identity. Swipe/long-press
   reply. Full emoji reactions. Paginated history.
   ========================================================= */

(() => {
  'use strict';

  // ---------- Config ----------
  const firebaseConfig = {
    apiKey: "AIzaSyDTVX_LM8wtrgAGgCzFAOVb5AV5d_ieI9k",
    authDomain: "otaku2-e2764.firebaseapp.com",
    databaseURL: "https://otaku2-e2764-default-rtdb.firebaseio.com",
    projectId: "otaku2-e2764",
    storageBucket: "otaku2-e2764.firebasestorage.app",
    messagingSenderId: "1006295063792",
    appId: "1:1006295063792:web:c848a9714ee3ada87af635",
    measurementId: "G-1MR57ZC92C"
  };

  const PAGE_SIZE = 30;
  const SWIPE_TRIGGER_PX = 64;   // distance to trigger reply
  const SWIPE_MAX_PX = 88;       // visual cap on drag distance
  const LS_UID_KEY = 'otaku_uid_v1';
  const LS_NAME_KEY = 'otaku_name_v1';

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const nameOverlay = $('nameOverlay');
  const nameInput = $('nameInput');
  const joinBtn = $('joinBtn');
  const nameErr = $('nameErr');

  const messagesWrap = $('messagesWrap');
  const messagesList = $('messagesList');
  const welcomeCard = $('welcomeCard');
  const loadMoreRow = $('loadMoreRow');
  const loadMoreBtn = $('loadMoreBtn');

  const statusDot = $('statusDot');
  const statusText = $('statusText');
  const onlineCount = $('onlineCount');

  const replyPreview = $('replyPreview');
  const replyPreviewWho = $('replyPreviewWho');
  const replyPreviewTxt = $('replyPreviewTxt');
  const replyCancelBtn = $('replyCancelBtn');

  const messageInput = $('messageInput');
  const sendBtn = $('sendBtn');
  const emojiToggleBtn = $('emojiToggleBtn');
  const emojiPanel = $('emojiPanel');
  const emojiTabs = $('emojiTabs');
  const emojiGrid = $('emojiGrid');
  const typingRow = $('typingRow');
  const typingNames = $('typingNames');

  // ---------- State ----------
  let db = null;
  let firebaseReady = false;
  let myUid = '';
  let myName = '';
  let isConnected = false;

  let messagesRef = null;
  let usersRef = null;
  let typingRef = null;

  let oldestLoadedKey = null;   // for pagination (push key)
  let oldestLoadedTs = null;
  let allMessagesByKey = new Map(); // key -> {data, el}
  let hasMoreHistory = true;
  let initialLoadDone = false;

  let activeReply = null;       // {key, sender, text}
  let openReactionPickerFor = null;
  let typingTimeoutLocal = null;
  let typingDebounce = null;

  // ========================================================
  // Identity (persistent, localStorage, survives refresh)
  // ========================================================
  function uuidv4() {
    if (crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  function loadIdentity() {
    try {
      myUid = localStorage.getItem(LS_UID_KEY) || '';
      myName = localStorage.getItem(LS_NAME_KEY) || '';
    } catch (e) {
      myUid = ''; myName = '';
    }
    if (!myUid) {
      myUid = uuidv4();
      try { localStorage.setItem(LS_UID_KEY, myUid); } catch (e) {}
    }
  }

  function saveName(name) {
    myName = name;
    try { localStorage.setItem(LS_NAME_KEY, name); } catch (e) {}
  }

  // ========================================================
  // Sanitization (XSS safety) — we NEVER use innerHTML with
  // user-supplied text. Text nodes only.
  // ========================================================
  function clampText(str, max) {
    return (str || '').toString().slice(0, max);
  }

  function sanitizeName(raw) {
    // allow letters (incl. Arabic), numbers, spaces, basic emoji; strip control/HTML chars
    let s = clampText(raw, 20).replace(/<|>/g, '').trim();
    return s;
  }

  function sanitizeMessage(raw) {
    let s = clampText(raw, 1000).replace(/<|>/g, '');
    return s;
  }

  // ========================================================
  // Firebase init
  // ========================================================
  function initFirebase() {
    try {
      firebase.initializeApp(firebaseConfig);
      db = firebase.database();
      firebaseReady = true;
    } catch (e) {
      console.error('Firebase init error', e);
      firebaseReady = false;
    }
  }

  // ========================================================
  // Name modal flow
  // ========================================================
  function showNameOverlay(prefill) {
    nameOverlay.style.display = 'flex';
    if (prefill) nameInput.value = prefill;
    setTimeout(() => nameInput.focus(), 200);
  }
  function hideNameOverlay() {
    nameOverlay.style.display = 'none';
  }

  function attemptJoin() {
    const name = sanitizeName(nameInput.value);
    if (name.length < 2) {
      nameErr.textContent = 'يرجى إدخال لقب صحيح (حرفين على الأقل) 🙏';
      return;
    }
    saveName(name);
    hideNameOverlay();
    bootChat();
    spawnSakuraLoop();
  }

  joinBtn.addEventListener('click', attemptJoin);
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); attemptJoin(); }
  });

  // ========================================================
  // Connection + presence
  // ========================================================
  function updateConnectionUI() {
    if (isConnected && firebaseReady) {
      statusDot.classList.remove('off');
      statusText.textContent = 'متصل';
      sendBtn.disabled = false;
    } else {
      statusDot.classList.add('off');
      statusText.textContent = 'منقطع';
      sendBtn.disabled = true;
    }
  }

  function setupPresence() {
    const connectedRef = db.ref('.info/connected');
    connectedRef.on('value', (snap) => {
      isConnected = !!snap.val();
      updateConnectionUI();
      if (isConnected) {
        const myUserRef = usersRef.child(myUid);
        myUserRef.set({
          name: myName,
          lastSeen: firebase.database.ServerValue.TIMESTAMP,
          online: true
        });
        myUserRef.onDisconnect().remove();

        // clear my typing flag on disconnect too
        const myTypingRef = typingRef.child(myUid);
        myTypingRef.onDisconnect().remove();
      }
    });

    usersRef.on('value', (snap) => {
      const users = snap.val() || {};
      onlineCount.textContent = Object.keys(users).length;
    });
  }

  // ========================================================
  // Typing indicator
  // ========================================================
  function setupTyping() {
    typingRef.on('value', (snap) => {
      const typers = snap.val() || {};
      const names = Object.keys(typers)
        .filter(uid => uid !== myUid)
        .map(uid => typers[uid] && typers[uid].name)
        .filter(Boolean);
      if (names.length === 0) {
        typingRow.classList.remove('show');
      } else {
        const label = names.length === 1
          ? `${names[0]} يكتب`
          : `${names.slice(0,2).join('، ')} يكتبون`;
        typingNames.textContent = label;
        typingRow.classList.add('show');
      }
    });
  }

  function pingTyping() {
    if (!isConnected) return;
    const myTypingRef = typingRef.child(myUid);
    myTypingRef.set({ name: myName, ts: firebase.database.ServerValue.TIMESTAMP });
    clearTimeout(typingTimeoutLocal);
    typingTimeoutLocal = setTimeout(() => {
      myTypingRef.remove();
    }, 2500);
  }

  messageInput.addEventListener('input', () => {
    autoGrow();
    clearTimeout(typingDebounce);
    typingDebounce = setTimeout(pingTyping, 120);
  });

  function autoGrow() {
    messageInput.style.height = 'auto';
    messageInput.style.height = Math.min(messageInput.scrollHeight, 110) + 'px';
  }

  // ========================================================
  // Messages: initial load + pagination + live updates
  // ========================================================
  function bootChat() {
    if (!firebaseReady) {
      showSystemError('لا يمكن الاتصال بقاعدة البيانات. تحقق من إعدادات Firebase.');
      return;
    }
    messagesRef = db.ref('chat/messages');
    usersRef = db.ref('chat/presence');
    typingRef = db.ref('chat/typing');

    setupPresence();
    setupTyping();
    loadInitialMessages();
    listenForNewMessages();
    addSystemLine(`انضم ${myName} إلى الدردشة! 🌟`);
  }

  function loadInitialMessages() {
    messagesRef.limitToLast(PAGE_SIZE).once('value', (snap) => {
      const val = snap.val() || {};
      const keys = Object.keys(val).sort((a, b) => (val[a].timestamp||0) - (val[b].timestamp||0));
      keys.forEach(key => renderMessage(key, val[key], false));
      if (keys.length > 0) {
        oldestLoadedKey = keys[0];
        oldestLoadedTs = val[keys[0]].timestamp || 0;
      }
      hasMoreHistory = keys.length === PAGE_SIZE;
      loadMoreRow.style.display = hasMoreHistory ? 'flex' : 'none';
      initialLoadDone = true;
      scrollToBottom(true);
    });
  }

  function loadOlderMessages() {
    if (!hasMoreHistory || !oldestLoadedKey) return;
    loadMoreBtn.classList.add('loading');
    loadMoreBtn.textContent = 'جارٍ التحميل...';

    messagesRef.orderByKey().endBefore(oldestLoadedKey).limitToLast(PAGE_SIZE).once('value', (snap) => {
      const val = snap.val() || {};
      const keys = Object.keys(val).sort((a, b) => (val[a].timestamp||0) - (val[b].timestamp||0));

      const prevHeight = messagesWrap.scrollHeight;
      keys.forEach(key => renderMessage(key, val[key], false, true));

      if (keys.length > 0) {
        oldestLoadedKey = keys[0];
      }
      hasMoreHistory = keys.length === PAGE_SIZE;
      loadMoreRow.style.display = hasMoreHistory ? 'flex' : 'none';
      loadMoreBtn.classList.remove('loading');
      loadMoreBtn.textContent = 'تحميل رسائل أقدم ⬆️';

      // maintain scroll position after prepending
      requestAnimationFrame(() => {
        messagesWrap.scrollTop += (messagesWrap.scrollHeight - prevHeight);
      });
    });
  }

  loadMoreBtn.addEventListener('click', loadOlderMessages);

  function listenForNewMessages() {
    // only react to messages newer than what we've already rendered via initial load
    messagesRef.limitToLast(1).on('child_added', (snap) => {
      if (!initialLoadDone) return; // initial batch handled separately
      const key = snap.key;
      if (allMessagesByKey.has(key)) return;
      const data = snap.val();
      renderMessage(key, data, true);
      scrollToBottomIfNear();
    });

    // reactions live updates are attached per-message (see renderMessage)
    // edits/removals of messages (not required by spec, but keep structure open)
    messagesRef.on('child_changed', (snap) => {
      const key = snap.key;
      const entry = allMessagesByKey.get(key);
      if (entry) {
        updateReactionsUI(key, snap.val().reactions || {});
      }
    });
  }

  function addSystemLine(text) {
    const div = document.createElement('div');
    div.className = 'system-msg';
    div.textContent = text;
    messagesList.appendChild(div);
    scrollToBottomIfNear();
  }

  function showSystemError(text) {
    const div = document.createElement('div');
    div.className = 'error-msg';
    div.textContent = text;
    messagesList.appendChild(div);
    scrollToBottomIfNear();
  }

  function scrollToBottom(instant) {
    requestAnimationFrame(() => {
      messagesWrap.scrollTop = messagesWrap.scrollHeight;
    });
  }

  function scrollToBottomIfNear() {
    const threshold = 140;
    const nearBottom = messagesWrap.scrollHeight - messagesWrap.scrollTop - messagesWrap.clientHeight < threshold;
    if (nearBottom) scrollToBottom();
  }

  // ========================================================
  // Rendering a message row
  // ========================================================
  function formatTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    return d.toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit', hour12: true });
  }

  function renderMessage(key, data, isNew, prepend) {
    if (!data || !data.text) return;
    const mine = data.senderUid === myUid;

    const row = document.createElement('div');
    row.className = `msg-row ${mine ? 'mine' : 'theirs'}`;
    row.dataset.key = key;
    if (isNew) row.classList.add('appear');

    const shell = document.createElement('div');
    shell.className = 'msg-bubble-shell';

    if (!mine) {
      const sender = document.createElement('div');
      sender.className = 'msg-sender';
      sender.textContent = data.senderName || 'مجهول';
      shell.appendChild(sender);
    }

    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';

    // reply quote block
    if (data.replyTo && data.replyTo.key) {
      const quote = document.createElement('div');
      quote.className = 'reply-quote';
      const bar = document.createElement('div'); bar.className = 'bar';
      const info = document.createElement('div'); info.className = 'info';
      const who = document.createElement('div'); who.className = 'who';
      who.textContent = data.replyTo.sender || 'مجهول';
      const txt = document.createElement('div'); txt.className = 'txt';
      txt.textContent = data.replyTo.text || '';
      info.appendChild(who); info.appendChild(txt);
      quote.appendChild(bar); quote.appendChild(info);
      quote.addEventListener('click', (e) => {
        e.stopPropagation();
        jumpToMessage(data.replyTo.key);
      });
      bubble.appendChild(quote);
    }

    const textDiv = document.createElement('div');
    textDiv.className = 'msg-text';
    textDiv.textContent = data.text; // textContent => safe from XSS
    bubble.appendChild(textDiv);

    const meta = document.createElement('div');
    meta.className = 'msg-meta';
    meta.textContent = formatTime(data.timestamp);
    bubble.appendChild(meta);

    shell.appendChild(bubble);

    // reactions row (created now, filled by updateReactionsUI)
    const reactionsRow = document.createElement('div');
    reactionsRow.className = 'reactions-row';
    shell.appendChild(reactionsRow);

    row.appendChild(shell);

    // swipe reply icon
    const swipeIcon = document.createElement('div');
    swipeIcon.className = 'reply-swipe-icon';
    swipeIcon.textContent = '↩️';
    row.appendChild(swipeIcon);

    // hover/long-press action bar (reply + react)
    const actions = document.createElement('div');
    actions.className = 'msg-actions';
    const replyBtn = document.createElement('button');
    replyBtn.textContent = '↩️';
    replyBtn.title = 'رد';
    replyBtn.addEventListener('click', (e) => { e.stopPropagation(); startReply(key, data); closeActions(row); });
    const reactBtn = document.createElement('button');
    reactBtn.textContent = '❤';
    reactBtn.title = 'تفاعل';
    reactBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleReactionPicker(row, key); });
    actions.appendChild(replyBtn);
    actions.appendChild(reactBtn);
    row.appendChild(actions);

    attachGestures(row, shell, swipeIcon, actions, key, data);

    if (prepend) {
      messagesList.insertBefore(row, messagesList.firstChild);
    } else {
      messagesList.appendChild(row);
    }

    allMessagesByKey.set(key, { data, el: row });
    welcomeCard.style.display = 'none';

    // live listen to this message's reactions
    db.ref(`chat/messages/${key}/reactions`).on('value', (snap) => {
      updateReactionsUI(key, snap.val() || {});
    });

    if (data.reactions) updateReactionsUI(key, data.reactions);
  }

  function jumpToMessage(key) {
    const entry = allMessagesByKey.get(key);
    if (!entry) return;
    entry.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const bubble = entry.el.querySelector('.msg-bubble');
    bubble.classList.remove('highlight');
    void bubble.offsetWidth;
    bubble.classList.add('highlight');
  }

  function closeActions(row) {
    const el = row.querySelector('.msg-actions');
    if (el) el.classList.remove('show');
  }
  function closeAllActions() {
    document.querySelectorAll('.msg-actions.show').forEach(el => el.classList.remove('show'));
  }

  // ========================================================
  // Swipe-to-reply + long-press gesture handling
  // One pointer-driven implementation shared by touch & mouse.
  // ========================================================
  function attachGestures(row, shell, swipeIcon, actions, key, data) {
    let startX = 0, startY = 0, dx = 0, dy = 0;
    let dragging = false;       // true once we've committed to a horizontal drag
    let decided = false;        // true once we've decided drag vs scroll
    let pointerId = null;
    let longPressTimer = null;
    let longPressFired = false;
    const DIR = 1; // RTL: swipe towards the row's trailing edge triggers reply (drag left->right visually reversed)
    // We allow swipe in either horizontal direction - whichever the user naturally does -
    // and only commit once movement is clearly horizontal.

    function onPointerDown(e) {
      if (e.button !== undefined && e.button !== 0) return;
      pointerId = e.pointerId;
      startX = e.clientX;
      startY = e.clientY;
      dx = 0; dy = 0;
      dragging = false;
      decided = false;
      longPressFired = false;

      longPressTimer = setTimeout(() => {
        longPressFired = true;
        closeAllActions();
        actions.classList.add('show');
        if (navigator.vibrate) navigator.vibrate(12);
      }, 420);

      row.addEventListener('pointermove', onPointerMove);
      row.addEventListener('pointerup', onPointerUp);
      row.addEventListener('pointercancel', onPointerUp);
    }

    function onPointerMove(e) {
      if (pointerId !== e.pointerId) return;
      dx = e.clientX - startX;
      dy = e.clientY - startY;

      if (!decided) {
        if (Math.abs(dx) > 8 || Math.abs(dy) > 8) {
          decided = true;
          if (Math.abs(dx) > Math.abs(dy) * 1.3) {
            dragging = true;
            clearTimeout(longPressTimer);
          } else {
            // vertical intent -> let the browser scroll, abort drag tracking
            dragging = false;
            clearTimeout(longPressTimer);
            cleanup();
            return;
          }
        } else {
          return;
        }
      }

      if (!dragging) return;

      // cancel long press once real horizontal drag starts
      clearTimeout(longPressTimer);

      e.preventDefault();
      let clamped = dx;
      if (Math.abs(clamped) > SWIPE_MAX_PX) {
        const over = Math.abs(clamped) - SWIPE_MAX_PX;
        const damped = SWIPE_MAX_PX + over * 0.25;
        clamped = clamped < 0 ? -damped : damped;
      }
      shell.classList.add('dragging');
      shell.style.transform = `translateX(${clamped}px)`;

      const progress = Math.min(Math.abs(dx) / SWIPE_TRIGGER_PX, 1);
      swipeIcon.style.left = '';
      swipeIcon.classList.add('show');
      swipeIcon.style.opacity = String(progress);
      swipeIcon.style.transform = `translateY(-50%) scale(${0.4 + progress * 0.6})`;
      if (progress >= 1) {
        swipeIcon.classList.add('ready');
      } else {
        swipeIcon.classList.remove('ready');
      }
    }

    function onPointerUp(e) {
      clearTimeout(longPressTimer);
      const triggeredReply = dragging && Math.abs(dx) >= SWIPE_TRIGGER_PX;

      shell.classList.remove('dragging');
      shell.style.transform = '';
      swipeIcon.classList.remove('show', 'ready');
      swipeIcon.style.opacity = '';
      swipeIcon.style.transform = '';

      if (triggeredReply) {
        if (navigator.vibrate) navigator.vibrate(18);
        startReply(key, data);
      } else if (!dragging && !longPressFired) {
        // plain tap/click - toggle action bar visibility briefly on mobile is noisy,
        // so a simple tap does nothing but could be used to open the reaction picker in future.
      }

      cleanup();
    }

    function cleanup() {
      row.removeEventListener('pointermove', onPointerMove);
      row.removeEventListener('pointerup', onPointerUp);
      row.removeEventListener('pointercancel', onPointerUp);
      pointerId = null;
      dragging = false;
      decided = false;
    }

    row.addEventListener('pointerdown', onPointerDown);

    // desktop: right-click also opens quick actions (extra convenience, doesn't replace long-press)
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      closeAllActions();
      actions.classList.add('show');
    });
  }

  // close any open action bar / reaction picker when tapping elsewhere
  document.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('.msg-actions') && !e.target.closest('.msg-bubble-shell')) {
      closeAllActions();
    }
    if (openReactionPickerFor && !e.target.closest('.reaction-picker') && !e.target.closest('.msg-actions')) {
      closeReactionPicker();
    }
  }, true);

  // ========================================================
  // Reply flow
  // ========================================================
  function startReply(key, data) {
    activeReply = { key, sender: data.senderName || 'مجهول', text: data.text || '' };
    replyPreviewWho.textContent = activeReply.sender;
    replyPreviewTxt.textContent = activeReply.text;
    replyPreview.style.display = 'flex';
    messageInput.focus();
  }

  function cancelReply() {
    activeReply = null;
    replyPreview.style.display = 'none';
  }
  replyCancelBtn.addEventListener('click', cancelReply);

  // ========================================================
  // Sending messages
  // ========================================================
  function sendMessage() {
    const raw = messageInput.value;
    const text = sanitizeMessage(raw).trim();
    if (!text) return;
    if (!firebaseReady || !isConnected) {
      showSystemError('لا يمكن إرسال الرسالة. تحقق من الاتصال بالإنترنت.');
      return;
    }

    const payload = {
      text,
      senderUid: myUid,
      senderName: myName,
      timestamp: firebase.database.ServerValue.TIMESTAMP
    };
    if (activeReply) {
      payload.replyTo = {
        key: activeReply.key,
        sender: activeReply.sender,
        text: activeReply.text.slice(0, 120)
      };
    }

    messagesRef.push(payload).then(() => {
      messageInput.value = '';
      autoGrow();
      cancelReply();
      sendBtn.classList.remove('pop');
      void sendBtn.offsetWidth;
      sendBtn.classList.add('pop');
      if (navigator.vibrate) navigator.vibrate(30);
      typingRef.child(myUid).remove();
    }).catch((err) => {
      console.error('send error', err);
      showSystemError('فشل في إرسال الرسالة');
    });
  }

  sendBtn.addEventListener('click', sendMessage);
  messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // ========================================================
  // Reactions
  // ========================================================
  function toggleReactionPicker(row, key) {
    if (openReactionPickerFor === key) {
      closeReactionPicker();
      return;
    }
    closeReactionPicker();
    closeAllActions();

    const shell = row.querySelector('.msg-bubble-shell');
    const picker = document.createElement('div');
    picker.className = 'reaction-picker';

    QUICK_REACTIONS.forEach(em => {
      const span = document.createElement('span');
      span.textContent = em;
      span.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleMyReaction(key, em);
        closeReactionPicker();
      });
      picker.appendChild(span);
    });

    const more = document.createElement('div');
    more.className = 'more-btn';
    more.textContent = '➕';
    more.title = 'كل الإيموجيات';
    more.addEventListener('click', (e) => {
      e.stopPropagation();
      closeReactionPicker();
      openFullEmojiPickerForReaction(key);
    });
    picker.appendChild(more);

    shell.appendChild(picker);
    openReactionPickerFor = key;
  }

  function closeReactionPicker() {
    if (!openReactionPickerFor) return;
    const entry = allMessagesByKey.get(openReactionPickerFor);
    if (entry) {
      const existing = entry.el.querySelector('.reaction-picker');
      if (existing) existing.remove();
    }
    openReactionPickerFor = null;
  }

  function openFullEmojiPickerForReaction(key) {
    pendingReactionTargetKey = key;
    openEmojiPanel();
  }

  function toggleMyReaction(key, emoji) {
    const reactionRef = db.ref(`chat/messages/${key}/reactions/${emoji}/${myUid}`);
    reactionRef.once('value').then(snap => {
      if (snap.exists()) {
        reactionRef.remove();
      } else {
        reactionRef.set({ name: myName, ts: firebase.database.ServerValue.TIMESTAMP });
      }
    });
  }

  function updateReactionsUI(key, reactions) {
    const entry = allMessagesByKey.get(key);
    if (!entry) return;
    const row = entry.el;
    const reactionsRow = row.querySelector('.reactions-row');
    reactionsRow.innerHTML = '';

    const emojiKeys = Object.keys(reactions || {}).filter(em => reactions[em] && Object.keys(reactions[em]).length > 0);
    emojiKeys.forEach(emoji => {
      const usersMap = reactions[emoji];
      const uids = Object.keys(usersMap);
      const count = uids.length;
      const chip = document.createElement('div');
      chip.className = 'reaction-chip' + (usersMap[myUid] ? ' mine' : '');
      const emoSpan = document.createElement('span');
      emoSpan.textContent = emoji;
      const countSpan = document.createElement('span');
      countSpan.className = 'count';
      countSpan.textContent = count;
      chip.appendChild(emoSpan);
      chip.appendChild(countSpan);

      chip.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleMyReaction(key, emoji);
      });
      let pressTimer = null;
      chip.addEventListener('pointerdown', () => {
        pressTimer = setTimeout(() => showWhoReacted(emoji, usersMap), 380);
      });
      chip.addEventListener('pointerup', () => clearTimeout(pressTimer));
      chip.addEventListener('pointerleave', () => clearTimeout(pressTimer));

      reactionsRow.appendChild(chip);
    });
  }

  function showWhoReacted(emoji, usersMap) {
    const backdrop = document.createElement('div');
    backdrop.className = 'sheet-backdrop';
    const sheet = document.createElement('div');
    sheet.className = 'sheet';
    const handle = document.createElement('div');
    handle.className = 'sheet-handle';
    const h4 = document.createElement('h4');
    h4.textContent = `${emoji} تفاعل بها`;
    sheet.appendChild(handle);
    sheet.appendChild(h4);

    Object.values(usersMap).forEach(u => {
      const row = document.createElement('div');
      row.className = 'sheet-row';
      const nameSpan = document.createElement('span');
      nameSpan.textContent = (u && u.name) || 'مجهول';
      const emoSpan = document.createElement('span');
      emoSpan.className = 'emo';
      emoSpan.textContent = emoji;
      row.appendChild(nameSpan);
      row.appendChild(emoSpan);
      sheet.appendChild(row);
    });

    backdrop.appendChild(sheet);
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) backdrop.remove();
    });
    document.body.appendChild(backdrop);
  }

  // ========================================================
  // Emoji picker (composer + reaction "more" entry point)
  // ========================================================
  let emojiPanelOpen = false;
  let pendingReactionTargetKey = null;

  function buildEmojiPanel() {
    emojiTabs.innerHTML = '';
    emojiGrid.innerHTML = '';

    EMOJI_CATEGORIES.forEach((cat, idx) => {
      const tabBtn = document.createElement('button');
      tabBtn.textContent = cat.icon;
      tabBtn.dataset.cat = cat.key;
      if (idx === 0) tabBtn.classList.add('active');
      tabBtn.addEventListener('click', () => selectEmojiCategory(cat.key));
      emojiTabs.appendChild(tabBtn);
    });

    renderEmojiGrid(EMOJI_CATEGORIES[0].key);
  }

  function renderEmojiGrid(catKey) {
    emojiGrid.innerHTML = '';
    const cat = EMOJI_CATEGORIES.find(c => c.key === catKey);
    if (!cat) return;
    const label = document.createElement('div');
    label.className = 'emoji-cat-label';
    label.textContent = cat.name;
    emojiGrid.appendChild(label);
    cat.emojis.forEach(em => {
      const span = document.createElement('span');
      span.textContent = em;
      span.addEventListener('click', () => onEmojiPicked(em));
      emojiGrid.appendChild(span);
    });
  }

  function selectEmojiCategory(key) {
    [...emojiTabs.children].forEach(b => b.classList.toggle('active', b.dataset.cat === key));
    renderEmojiGrid(key);
  }

  function onEmojiPicked(emoji) {
    if (pendingReactionTargetKey) {
      toggleMyReaction(pendingReactionTargetKey, emoji);
      pendingReactionTargetKey = null;
      closeEmojiPanel();
      return;
    }
    const start = messageInput.selectionStart || messageInput.value.length;
    const end = messageInput.selectionEnd || messageInput.value.length;
    const val = messageInput.value;
    messageInput.value = val.slice(0, start) + emoji + val.slice(end);
    const newPos = start + emoji.length;
    messageInput.setSelectionRange(newPos, newPos);
    messageInput.focus();
    autoGrow();
  }

  function openEmojiPanel() {
    emojiPanel.classList.add('open');
    emojiToggleBtn.classList.add('active');
    emojiPanelOpen = true;
  }
  function closeEmojiPanel() {
    emojiPanel.classList.remove('open');
    emojiToggleBtn.classList.remove('active');
    emojiPanelOpen = false;
    pendingReactionTargetKey = null;
  }
  emojiToggleBtn.addEventListener('click', () => {
    if (emojiPanelOpen) closeEmojiPanel(); else openEmojiPanel();
  });

  // ========================================================
  // Sakura ambiance
  // ========================================================
  function spawnSakuraLoop() {
    setInterval(() => {
      if (Math.random() < 0.3) {
        const s = document.createElement('div');
        s.textContent = '⭐';
        s.className = 'sakura';
        s.style.left = Math.random() * 100 + '%';
        s.style.fontSize = (Math.random()*10+14) + 'px';
        const dur = (Math.random()*3+7);
        s.style.animationDuration = dur + 's';
        document.body.appendChild(s);
        setTimeout(() => s.remove(), dur*1000 + 200);
      }
    }, 2200);
  }

  // ========================================================
  // Init
  // ========================================================
  function init() {
    loadIdentity();
    initFirebase();
    buildEmojiPanel();
    updateConnectionUI();

    if (myName) {
      hideNameOverlay();
      bootChat();
      spawnSakuraLoop();
    } else {
      showNameOverlay();
    }
  }

  document.addEventListener('touchstart', () => {}, { passive: true });
  init();
})();
