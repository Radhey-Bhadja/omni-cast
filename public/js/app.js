/**
 * OmniCast — Simple, Clean & 100% Functional Screen Sharing
 * Built with PeerJS & WebRTC with Public Google STUN servers.
 */

(() => {
  'use strict';

  // Public Google & OpenRelay STUN servers for reliable cross-network connection
  const PEER_CONFIG = {
    config: {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:openrelay.metered.ca:80' }
      ]
    },
    debug: 1
  };

  const CHUNK_SIZE = 64 * 1024; // 64KB per file slice

  // Application State
  const state = {
    peer: null,
    myCode: null,
    targetCode: null,
    isHost: false,
    activeConn: null, // DataConnection
    activeCall: null, // MediaConnection
    localStream: null, // Host Screen MediaStream
    incomingFile: null,
    unreadChatCount: 0,
    isChatOpen: false,
    connectTimeoutTimer: null
  };

  // Simple Audio Beeps (Zero dependencies)
  const sound = {
    ctx: null,
    play(freq, dur) {
      try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!this.ctx && AudioCtx) this.ctx = new AudioCtx();
        if (!this.ctx) return;
        if (this.ctx.state === 'suspended') this.ctx.resume();
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.08, this.ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + dur);
        osc.connect(gain);
        gain.connect(this.ctx.destination);
        osc.start();
        osc.stop(this.ctx.currentTime + dur);
      } catch (e) {}
    },
    ring() {
      this.play(800, 0.15);
      setTimeout(() => this.play(950, 0.25), 150);
    },
    success() {
      this.play(520, 0.12);
      setTimeout(() => this.play(680, 0.2), 120);
    },
    end() {
      this.play(440, 0.1);
      setTimeout(() => this.play(330, 0.18), 100);
    }
  };

  // DOM Elements
  const el = {
    connectionStatus: document.getElementById('connectionStatus'),
    statusLabel: document.getElementById('statusLabel'),
    mainView: document.getElementById('mainView'),
    myCodeDisplay: document.getElementById('myCodeDisplay'),
    btnCopyCode: document.getElementById('btnCopyCode'),
    copyBtnText: document.getElementById('copyBtnText'),
    btnNewCode: document.getElementById('btnNewCode'),
    targetCodeInput: document.getElementById('targetCodeInput'),
    connectForm: document.getElementById('connectForm'),
    btnConnect: document.getElementById('btnConnect'),
    connectBtnText: document.getElementById('connectBtnText'),
    connectSpinner: document.getElementById('connectSpinner'),
    
    // Session
    sessionView: document.getElementById('sessionView'),
    remoteVideo: document.getElementById('remoteVideo'),
    loaderOverlay: document.getElementById('loaderOverlay'),
    loaderTitle: document.getElementById('loaderTitle'),
    loaderSubtitle: document.getElementById('loaderSubtitle'),
    btnCancelConnect: document.getElementById('btnCancelConnect'),
    sessionPartnerName: document.getElementById('sessionPartnerName'),
    btnOpenChat: document.getElementById('btnOpenChat'),
    chatBadge: document.getElementById('chatBadge'),
    btnOpenFile: document.getElementById('btnOpenFile'),
    filePickerInput: document.getElementById('filePickerInput'),
    btnFullscreen: document.getElementById('btnFullscreen'),
    btnStopSession: document.getElementById('btnStopSession'),

    // Host Floating Notice
    hostNotice: document.getElementById('hostNotice'),
    hostNoticeSub: document.getElementById('hostNoticeSub'),
    btnHostStop: document.getElementById('btnHostStop'),

    // Incoming Permission Modal
    modalIncoming: document.getElementById('modalIncoming'),
    incomingFriendCode: document.getElementById('incomingFriendCode'),
    btnAccept: document.getElementById('btnAccept'),
    btnDecline: document.getElementById('btnDecline'),

    // Chat Drawer
    chatDrawer: document.getElementById('chatDrawer'),
    btnCloseChat: document.getElementById('btnCloseChat'),
    chatMessages: document.getElementById('chatMessages'),
    chatForm: document.getElementById('chatForm'),
    chatInput: document.getElementById('chatInput'),

    // File Banner
    fileBanner: document.getElementById('fileBanner'),
    fileName: document.getElementById('fileName'),
    fileProgressFill: document.getElementById('fileProgressFill'),
    fileStatusText: document.getElementById('fileStatusText'),
    btnCloseFileBanner: document.getElementById('btnCloseFileBanner'),

    // Toast Container
    toastContainer: document.getElementById('toastContainer')
  };

  // Helper Functions
  function getRandom6Digits() {
    return String(Math.floor(100000 + Math.random() * 900000));
  }

  function formatDisplay(raw) {
    if (!raw) return '--- ---';
    const digits = String(raw).replace(/\D/g, '').slice(0, 6);
    if (digits.length <= 3) return digits;
    return `${digits.slice(0, 3)} ${digits.slice(3)}`;
  }

  function cleanDigits(str) {
    return String(str || '').replace(/\D/g, '').slice(0, 6);
  }

  function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    el.toastContainer.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(-10px)';
      setTimeout(() => toast.remove(), 250);
    }, 3500);
  }

  // =========================================================================
  // Initialize PeerJS
  // =========================================================================
  function initPeer() {
    let saved = localStorage.getItem('omnicast_my_code');
    if (!saved || saved.length !== 6) {
      saved = getRandom6Digits();
      localStorage.setItem('omnicast_my_code', saved);
    }
    state.myCode = saved;
    el.myCodeDisplay.textContent = formatDisplay(saved);

    el.statusLabel.textContent = 'Connecting...';
    el.connectionStatus.className = 'status-badge status-connecting';

    if (state.peer) {
      try { state.peer.destroy(); } catch (e) {}
    }

    try {
      state.peer = new Peer('omni-' + state.myCode, PEER_CONFIG);

      // Connected to Broker
      state.peer.on('open', (id) => {
        console.log('[OmniCast Peer Open]', id);
        el.statusLabel.textContent = 'Ready';
        el.connectionStatus.className = 'status-badge status-online';
      });

      // Handle Errors
      state.peer.on('error', (err) => {
        console.warn('[PeerJS]', err.type, err.message);
        if (err.type === 'unavailable-id') {
          // If code was recently used, immediately get a fresh one
          const fresh = getRandom6Digits();
          state.myCode = fresh;
          localStorage.setItem('omnicast_my_code', fresh);
          el.myCodeDisplay.textContent = formatDisplay(fresh);
          initPeer();
        } else if (err.type === 'peer-unavailable') {
          showToast('That code is offline. Check with your friend!', 'error');
          resetConnectButton();
        }
      });

      // HOST: Listen for incoming connection from a friend
      state.peer.on('connection', (conn) => {
        console.log('[Incoming Connection from]', conn.peer);
        state.activeConn = conn;
        listenToDataChannel(conn);
      });

      // VIEWER: Listen for incoming screen call from Host
      state.peer.on('call', (call) => {
        console.log('[Incoming Screen Call from]', call.peer);
        state.activeCall = call;
        call.answer(); // Viewer answers (receive-only)

        call.on('stream', (stream) => {
          console.log('[Stream Received on Viewer]');
          el.remoteVideo.srcObject = stream;
          el.loaderOverlay.classList.add('hidden');
          sound.success();
          showToast('Connected! You are now watching their screen.', 'success');
        });

        call.on('close', () => {
          stopAllSessions('Your friend stopped sharing their screen.');
        });
      });

    } catch (e) {
      console.error('[PeerJS Init Error]', e);
    }
  }

  // =========================================================================
  // Data Channel Messaging (Chat, File, Handshake)
  // =========================================================================
  function listenToDataChannel(conn) {
    conn.on('data', (data) => {
      if (!data) return;

      // 1. Friend asks permission to connect (Host receives this)
      if (data.type === 'ask-permission') {
        const callerCode = data.fromCode || conn.peer.replace('omni-', '');
        sound.ring();
        el.incomingFriendCode.textContent = formatDisplay(callerCode);
        el.modalIncoming.classList.remove('hidden');
      }

      // 2. Friend accepted! (Viewer receives this)
      else if (data.type === 'accepted') {
        el.loaderTitle.textContent = 'Starting video stream...';
        el.loaderSubtitle.textContent = 'Getting 60 FPS live picture';
        sound.success();
      }

      // 3. Friend declined (Viewer receives this)
      else if (data.type === 'declined') {
        sound.end();
        showToast('Your friend declined the screen share request.', 'warning');
        resetConnectButton();
      }

      // 4. Friend cancelled screen selection
      else if (data.type === 'cancelled') {
        sound.end();
        showToast('Your friend cancelled screen selection.', 'warning');
        resetConnectButton();
      }

      // 5. Chat message received
      else if (data.type === 'chat') {
        appendChatMessage(data.text, 'theirs');
        if (!state.isChatOpen) {
          state.unreadChatCount++;
          el.chatBadge.textContent = state.unreadChatCount;
          el.chatBadge.classList.remove('hidden');
          sound.play(700, 0.1);
        }
      }

      // 6. File transfer
      else if (data.type === 'file-start') {
        state.incomingFile = {
          name: data.name,
          size: data.size,
          mime: data.mime,
          chunks: [],
          receivedBytes: 0
        };
        el.fileBanner.classList.remove('hidden');
        el.fileName.textContent = data.name;
        el.fileProgressFill.style.width = '0%';
        el.fileStatusText.textContent = 'Receiving file... 0%';
        sound.play(600, 0.1);
      } else if (data.type === 'file-chunk') {
        if (!state.incomingFile) return;
        state.incomingFile.chunks.push(data.chunk);
        state.incomingFile.receivedBytes += data.chunk.byteLength;
        const pct = Math.min(100, Math.round((state.incomingFile.receivedBytes / state.incomingFile.size) * 100));
        el.fileProgressFill.style.width = `${pct}%`;
        el.fileStatusText.textContent = `Receiving... ${pct}%`;
      } else if (data.type === 'file-end') {
        if (!state.incomingFile) return;
        const blob = new Blob(state.incomingFile.chunks, { type: state.incomingFile.mime });
        const url = URL.createObjectURL(blob);
        el.fileStatusText.innerHTML = `<a href="${url}" download="${state.incomingFile.name}" style="color: #3b82f6; font-weight: 700; text-decoration: underline;">Download File</a>`;
        showToast(`Received ${state.incomingFile.name}!`, 'success');
        sound.success();

        // Auto trigger download
        const a = document.createElement('a');
        a.href = url;
        a.download = state.incomingFile.name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        state.incomingFile = null;
      }

      // 7. End session
      else if (data.type === 'end-session') {
        stopAllSessions(data.reason || 'Your friend ended the session.');
      }
    });

    conn.on('close', () => {
      stopAllSessions('Connection closed.');
    });
  }

  // =========================================================================
  // Viewer Connect Action
  // =========================================================================
  function startConnect() {
    const raw = el.targetCodeInput.value;
    const clean = cleanDigits(raw);

    if (clean.length !== 6) {
      showToast('Please enter a 6-digit code (e.g. 482 910)', 'warning');
      el.targetCodeInput.focus();
      return;
    }

    if (clean === state.myCode) {
      showToast('Cannot connect to your own computer code!', 'warning');
      return;
    }

    state.targetCode = clean;

    // Show loading button
    el.btnConnect.disabled = true;
    el.connectBtnText.textContent = 'Connecting...';
    el.connectSpinner.classList.remove('hidden');

    try {
      const conn = state.peer.connect('omni-' + clean, { reliable: true });
      state.activeConn = conn;
      listenToDataChannel(conn);

      // Set timeout in case target is offline
      state.connectTimeoutTimer = setTimeout(() => {
        if (!el.sessionView.classList.contains('hidden') && el.loaderOverlay.classList.contains('hidden') === false) {
          showToast('Could not connect: Your friend might be offline.', 'error');
          resetConnectButton();
        }
      }, 18000);

      conn.on('open', () => {
        console.log('[Connected to Friend DataChannel] Asking permission...');
        conn.send({
          type: 'ask-permission',
          fromCode: state.myCode
        });

        // Switch to session view waiting overlay
        el.mainView.classList.add('hidden');
        el.sessionView.classList.remove('hidden');
        el.loaderOverlay.classList.remove('hidden');
        el.loaderTitle.textContent = `Asking friend (${formatDisplay(clean)})...`;
        el.loaderSubtitle.textContent = 'Waiting for them to click "Allow" on their screen';
        el.sessionPartnerName.textContent = `Watching Screen (${formatDisplay(clean)})`;
      });

    } catch (e) {
      showToast('Failed to connect: ' + e.message, 'error');
      resetConnectButton();
    }
  }

  function resetConnectButton() {
    if (state.connectTimeoutTimer) clearTimeout(state.connectTimeoutTimer);
    el.btnConnect.disabled = false;
    el.connectBtnText.textContent = 'Connect Now';
    el.connectSpinner.classList.add('hidden');
    el.sessionView.classList.add('hidden');
    el.mainView.classList.remove('hidden');
  }

  // =========================================================================
  // Host Response Actions (Allow / Decline)
  // =========================================================================
  async function hostAcceptScreenShare() {
    el.modalIncoming.classList.add('hidden');

    try {
      // Pick screen / window
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 60, max: 60 } },
        audio: true
      });
      state.localStream = stream;
      state.isHost = true;

      // Handle when host clicks "Stop sharing" on the browser native bar
      stream.getVideoTracks()[0].onended = () => {
        stopAllSessions('You stopped sharing your screen.');
      };

      // Call Viewer with the video stream
      if (state.activeConn) {
        state.activeCall = state.peer.call(state.activeConn.peer, stream);
        state.activeConn.send({ type: 'accepted' });
      }

      // Show top-right floating notice on host machine
      el.hostNotice.classList.remove('hidden');
      el.hostNoticeSub.textContent = `Friend connected: ${el.incomingFriendCode.textContent}`;

      sound.success();
      showToast('You are now sharing your screen!', 'success');

    } catch (err) {
      console.warn('[Screen Share Cancelled]', err);
      if (state.activeConn) {
        state.activeConn.send({ type: 'cancelled' });
      }
      showToast('Screen share cancelled', 'info');
    }
  }

  function hostDecline() {
    el.modalIncoming.classList.add('hidden');
    if (state.activeConn) {
      state.activeConn.send({ type: 'declined' });
      try { state.activeConn.close(); } catch (e) {}
    }
    showToast('Declined request', 'info');
  }

  // =========================================================================
  // Chat Functions
  // =========================================================================
  function appendChatMessage(text, side) {
    const bubble = document.createElement('div');
    bubble.className = `msg-bubble ${side}`;
    bubble.textContent = text;
    el.chatMessages.appendChild(bubble);
    el.chatMessages.scrollTop = el.chatMessages.scrollHeight;
  }

  function sendChatMessage(e) {
    e.preventDefault();
    const text = el.chatInput.value.trim();
    if (!text || !state.activeConn) return;

    state.activeConn.send({
      type: 'chat',
      text
    });

    appendChatMessage(text, 'mine');
    el.chatInput.value = '';
  }

  // =========================================================================
  // File Transfer Function
  // =========================================================================
  function sendFileToFriend(file) {
    if (!state.activeConn) {
      showToast('No active connection to send file!', 'error');
      return;
    }

    el.fileBanner.classList.remove('hidden');
    el.fileName.textContent = file.name;
    el.fileProgressFill.style.width = '0%';
    el.fileStatusText.textContent = `Sending... 0%`;

    state.activeConn.send({
      type: 'file-start',
      name: file.name,
      size: file.size,
      mime: file.type || 'application/octet-stream'
    });

    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    let chunkIndex = 0;
    const reader = new FileReader();

    function readNext() {
      const start = chunkIndex * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, file.size);
      reader.readAsArrayBuffer(file.slice(start, end));
    }

    reader.onload = (e) => {
      state.activeConn.send({
        type: 'file-chunk',
        chunk: e.target.result
      });

      chunkIndex++;
      const pct = Math.round((chunkIndex / totalChunks) * 100);
      el.fileProgressFill.style.width = `${pct}%`;
      el.fileStatusText.textContent = `Sending... ${pct}%`;

      if (chunkIndex < totalChunks) {
        setTimeout(readNext, 10);
      } else {
        state.activeConn.send({ type: 'file-end' });
        el.fileStatusText.textContent = 'Sent Successfully!';
        showToast(`Sent ${file.name}!`, 'success');
        setTimeout(() => el.fileBanner.classList.add('hidden'), 2500);
      }
    };

    readNext();
  }

  // =========================================================================
  // Stop Session / Disconnect
  // =========================================================================
  function stopAllSessions(reason = 'Session ended.') {
    if (state.connectTimeoutTimer) clearTimeout(state.connectTimeoutTimer);

    if (state.localStream) {
      state.localStream.getTracks().forEach((t) => t.stop());
      state.localStream = null;
    }

    if (state.activeCall) {
      try { state.activeCall.close(); } catch (e) {}
      state.activeCall = null;
    }

    if (state.activeConn) {
      try {
        state.activeConn.send({ type: 'end-session', reason });
        state.activeConn.close();
      } catch (e) {}
      state.activeConn = null;
    }

    if (el.remoteVideo.srcObject) {
      el.remoteVideo.srcObject = null;
    }

    if (document.fullscreenElement) {
      try { document.exitFullscreen(); } catch (e) {}
    }

    // Reset UI
    el.sessionView.classList.add('hidden');
    el.hostNotice.classList.add('hidden');
    el.modalIncoming.classList.add('hidden');
    el.chatDrawer.classList.add('hidden');
    el.fileBanner.classList.add('hidden');
    el.mainView.classList.remove('hidden');
    resetConnectButton();

    sound.end();
    showToast(reason, 'info');
  }

  // =========================================================================
  // UI Event Bindings
  // =========================================================================
  function bindUI() {
    // Copy Code Button
    el.btnCopyCode.addEventListener('click', () => {
      navigator.clipboard.writeText(state.myCode).then(() => {
        el.btnCopyCode.classList.add('copied');
        el.copyBtnText.textContent = 'Copied!';
        showToast('Code copied! Send it to your friend.', 'success');
        setTimeout(() => {
          el.btnCopyCode.classList.remove('copied');
          el.copyBtnText.textContent = 'Copy';
        }, 2000);
      });
    });

    // Get New Code
    el.btnNewCode.addEventListener('click', () => {
      const fresh = getRandom6Digits();
      state.myCode = fresh;
      localStorage.setItem('omnicast_my_code', fresh);
      el.myCodeDisplay.textContent = formatDisplay(fresh);
      initPeer();
      showToast('Generated a new code!', 'info');
    });

    // Partner Code Input: Auto-formats to XXX XXX
    el.targetCodeInput.addEventListener('input', (e) => {
      const clean = cleanDigits(e.target.value);
      e.target.value = formatDisplay(clean);
    });

    // Connect Form Submit
    el.connectForm.addEventListener('submit', startConnect);
    el.btnCancelConnect.addEventListener('click', () => stopAllSessions('Cancelled connection.'));

    // Host Incoming Modal Buttons
    el.btnAccept.addEventListener('click', hostAcceptScreenShare);
    el.btnDecline.addEventListener('click', hostDecline);
    el.btnHostStop.addEventListener('click', () => stopAllSessions('You stopped sharing.'));

    // Chat Drawer Toggle
    el.btnOpenChat.addEventListener('click', () => {
      state.isChatOpen = !state.isChatOpen;
      el.chatDrawer.classList.toggle('hidden', !state.isChatOpen);
      if (state.isChatOpen) {
        state.unreadChatCount = 0;
        el.chatBadge.classList.add('hidden');
        el.chatInput.focus();
      }
    });
    el.btnCloseChat.addEventListener('click', () => {
      state.isChatOpen = false;
      el.chatDrawer.classList.add('hidden');
    });
    el.chatForm.addEventListener('submit', sendChatMessage);

    // Send File Button
    el.btnOpenFile.addEventListener('click', () => el.filePickerInput.click());
    el.filePickerInput.addEventListener('change', (e) => {
      if (e.target.files && e.target.files[0]) {
        sendFileToFriend(e.target.files[0]);
      }
    });
    el.btnCloseFileBanner.addEventListener('click', () => el.fileBanner.classList.add('hidden'));

    // Fullscreen Toggle
    el.btnFullscreen.addEventListener('click', () => {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(() => {});
      } else {
        document.exitFullscreen().catch(() => {});
      }
    });

    // Stop Watching Button
    el.btnStopSession.addEventListener('click', () => stopAllSessions('You stopped watching.'));
  }

  // Start Application
  function init() {
    bindUI();
    initPeer();
    console.log('[OmniCast Simple] Initialized.');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
