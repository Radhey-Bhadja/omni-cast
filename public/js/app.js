/**
 * OmniCast — 100% Functional WebRTC Remote Desktop (AnyDesk Grade)
 * Production & Vercel Live Ready — Full Mouse, Keyboard, Wheel, Special Keys & P2P Engine.
 */

(() => {
  'use strict';

  // Global Public Google & Twilio STUN servers for cross-network WebRTC traversal
  const PEER_CONFIG = {
    config: {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:stun4.l.google.com:19302' },
        { urls: 'stun:global.stun.twilio.com:3478' }
      ],
      iceCandidatePoolSize: 10
    },
    debug: 0
  };

  const CHUNK_SIZE = 64 * 1024; // 64KB per file slice

  // Safe DOM Helper
  const $ = (id) => document.getElementById(id);
  const on = (el, evt, fn, opts) => {
    if (el) el.addEventListener(evt, fn, opts);
  };

  // Immediate Code Generation
  function getOrGenerateCode() {
    let saved = '';
    try {
      saved = localStorage.getItem('omnicast_my_code');
    } catch (e) {}
    if (!saved || saved.length !== 6 || !/^\d{6}$/.test(saved)) {
      saved = String(Math.floor(100000 + Math.random() * 900000));
      try {
        localStorage.setItem('omnicast_my_code', saved);
      } catch (e) {}
    }
    return saved;
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

  // Application State
  const state = {
    peer: null,
    myCode: getOrGenerateCode(),
    targetCode: null,
    isHost: false,
    activeConn: null, // RTCDataConnection
    activeCall: null, // MediaConnection
    localStream: null, // Host Screen MediaStream
    incomingFile: null,
    unreadChatCount: 0,
    isChatOpen: false,
    isKeysOpen: false,
    mode: 'control', // 'control' | 'laser'
    pingInterval: null,
    connectTimeoutTimer: null,
    lastMouseMoveTime: 0,
    hasServerApi: false,
    reconnectTimer: null
  };

  // Sound Engine (Web Audio API)
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

  // Toast Alerts
  function showToast(message, type = 'info') {
    const container = $('toastContainer');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(-10px)';
      setTimeout(() => toast.remove(), 250);
    }, 3500);
  }

  // Laser Pointer Engine
  let laserCtx = null;
  let ripples = [];
  let laserPoint = null;
  let animFrameId = null;

  function initLaserCanvas() {
    const canvas = $('laserCanvas');
    if (!canvas) return;
    laserCtx = canvas.getContext('2d');
    resizeLaserCanvas();
    window.addEventListener('resize', resizeLaserCanvas);
    startLaserLoop();
  }

  function resizeLaserCanvas() {
    const canvas = $('laserCanvas');
    if (!canvas) return;
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }

  function startLaserLoop() {
    if (animFrameId) cancelAnimationFrame(animFrameId);
    function loop() {
      renderLaser();
      animFrameId = requestAnimationFrame(loop);
    }
    animFrameId = requestAnimationFrame(loop);
  }

  function renderLaser() {
    const canvas = $('laserCanvas');
    if (!laserCtx || !canvas) return;
    laserCtx.clearRect(0, 0, canvas.width, canvas.height);

    if (laserPoint && (Date.now() - laserPoint.time < 1200)) {
      const x = laserPoint.x * canvas.width;
      const y = laserPoint.y * canvas.height;

      const radGrad = laserCtx.createRadialGradient(x, y, 0, x, y, 22);
      radGrad.addColorStop(0, 'rgba(239, 68, 68, 0.9)');
      radGrad.addColorStop(0.4, 'rgba(239, 68, 68, 0.4)');
      radGrad.addColorStop(1, 'rgba(239, 68, 68, 0)');
      laserCtx.fillStyle = radGrad;
      laserCtx.beginPath();
      laserCtx.arc(x, y, 22, 0, Math.PI * 2);
      laserCtx.fill();

      laserCtx.fillStyle = '#ffffff';
      laserCtx.beginPath();
      laserCtx.arc(x, y, 4, 0, Math.PI * 2);
      laserCtx.fill();
    }

    const now = Date.now();
    for (let i = ripples.length - 1; i >= 0; i--) {
      const r = ripples[i];
      const progress = (now - r.start) / 600;
      if (progress >= 1) {
        ripples.splice(i, 1);
        continue;
      }
      const radius = 6 + progress * 32;
      const alpha = (1 - progress) * 0.8;
      const x = r.x * canvas.width;
      const y = r.y * canvas.height;

      laserCtx.strokeStyle = `rgba(239, 68, 68, ${alpha})`;
      laserCtx.lineWidth = 2.5 * (1 - progress);
      laserCtx.beginPath();
      laserCtx.arc(x, y, radius, 0, Math.PI * 2);
      laserCtx.stroke();
    }
  }

  function triggerLaserRipple(normX, normY) {
    ripples.push({ x: normX, y: normY, start: Date.now() });
  }

  // Local Host Input Server check (if running via server.js)
  async function checkLocalInputServer() {
    try {
      const res = await fetch('/api/status', { method: 'GET' });
      if (res.ok) {
        const data = await res.json();
        if (data && data.osControlAvailable) {
          state.hasServerApi = true;
          console.log('[OmniCast] Native Windows OS Controller is READY!');
        }
      }
    } catch (e) {
      state.hasServerApi = false;
    }
  }

  function relayToNativeHost(event) {
    if (!state.isHost || !state.hasServerApi) return;
    fetch('/api/host-input', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event })
    }).catch(() => {});
  }

  // Recent Connections
  function getRecentConnections() {
    try {
      const stored = localStorage.getItem('omnicast_recents');
      return stored ? JSON.parse(stored) : [];
    } catch (e) {
      return [];
    }
  }

  function saveRecentConnection(code) {
    if (!code || code.length !== 6) return;
    let recents = getRecentConnections().filter(c => c !== code);
    recents.unshift(code);
    recents = recents.slice(0, 4);
    try {
      localStorage.setItem('omnicast_recents', JSON.stringify(recents));
    } catch (e) {}
    renderRecentChips();
  }

  function renderRecentChips() {
    const chipsContainer = $('recentChips');
    const wrap = $('recentContainer');
    if (!chipsContainer || !wrap) return;
    const recents = getRecentConnections();
    chipsContainer.innerHTML = '';
    if (recents.length === 0) {
      wrap.classList.add('hidden');
      return;
    }
    wrap.classList.remove('hidden');
    recents.forEach(code => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'recent-chip';
      chip.textContent = formatDisplay(code);
      chip.title = `Connect to ${formatDisplay(code)}`;
      chip.addEventListener('click', () => {
        const input = $('targetCodeInput');
        if (input) input.value = formatDisplay(code);
        startConnect();
      });
      chipsContainer.appendChild(chip);
    });
  }

  // Ping Monitor
  function startPingHeartbeat() {
    stopPingHeartbeat();
    state.pingInterval = setInterval(() => {
      if (state.activeConn && state.activeConn.open) {
        state.activeConn.send({ type: 'ping', t: Date.now() });
      }
    }, 2000);
  }

  function stopPingHeartbeat() {
    if (state.pingInterval) {
      clearInterval(state.pingInterval);
      state.pingInterval = null;
    }
    const pingEl = $('sessionPing');
    if (pingEl) pingEl.textContent = '-- ms';
  }

  // Host Key HUD Notification
  let hudTimer = null;
  function showHostKeyHUD(text) {
    const hud = $('hostKeyHUD');
    const hudText = $('hostKeyHUDText');
    if (!hud || !hudText) return;
    hudText.textContent = text;
    hud.classList.remove('hidden');
    if (hudTimer) clearTimeout(hudTimer);
    hudTimer = setTimeout(() => {
      hud.classList.add('hidden');
    }, 1400);
  }

  // =========================================================================
  // Initialize PeerJS
  // =========================================================================
  function initPeer() {
    const codeDisplay = $('myCodeDisplay');
    if (codeDisplay) {
      codeDisplay.textContent = formatDisplay(state.myCode);
    }

    const statusLabel = $('statusLabel');
    const connectionStatus = $('connectionStatus');
    if (statusLabel) statusLabel.textContent = 'Connecting...';
    if (connectionStatus) connectionStatus.className = 'status-badge status-connecting';

    if (state.peer) {
      try { state.peer.destroy(); } catch (e) {}
      state.peer = null;
    }

    if (typeof Peer === 'undefined') {
      console.warn('[OmniCast] Waiting for PeerJS to load...');
      setTimeout(initPeer, 500);
      return;
    }

    try {
      state.peer = new Peer('omni-' + state.myCode, PEER_CONFIG);

      state.peer.on('open', (id) => {
        console.log('[OmniCast Peer Open]', id);
        if (statusLabel) statusLabel.textContent = 'Ready (Online)';
        if (connectionStatus) connectionStatus.className = 'status-badge status-online';
      });

      state.peer.on('error', (err) => {
        console.warn('[PeerJS]', err.type, err.message);
        if (err.type === 'unavailable-id') {
          const fresh = String(Math.floor(100000 + Math.random() * 900000));
          state.myCode = fresh;
          try { localStorage.setItem('omnicast_my_code', fresh); } catch (e) {}
          if (codeDisplay) codeDisplay.textContent = formatDisplay(fresh);
          initPeer();
        } else if (err.type === 'peer-unavailable') {
          showToast('That Desk Code is currently offline. Ensure partner has OmniCast open!', 'error');
          resetConnectButton();
        } else if (err.type === 'network' || err.type === 'server-error') {
          if (statusLabel) statusLabel.textContent = 'Reconnecting...';
          if (connectionStatus) connectionStatus.className = 'status-badge status-connecting';
          if (!state.reconnectTimer) {
            state.reconnectTimer = setTimeout(() => {
              state.reconnectTimer = null;
              initPeer();
            }, 3000);
          }
        }
      });

      // HOST: Listen for incoming connection
      state.peer.on('connection', (conn) => {
        console.log('[Incoming Connection from]', conn.peer);
        state.activeConn = conn;
        listenToDataChannel(conn);
      });

      // VIEWER: Listen for incoming stream call from Host
      state.peer.on('call', (call) => {
        console.log('[Incoming Screen Call from]', call.peer);
        state.activeCall = call;
        call.answer(); // Viewer answers

        call.on('stream', (stream) => {
          console.log('[Stream Received on Viewer]', stream.id);
          const video = $('remoteVideo');
          if (video) {
            video.srcObject = stream;
            video.muted = true;
            video.play().catch(e => console.log('Autoplay hint:', e));
          }

          const loader = $('loaderOverlay');
          if (loader) loader.classList.add('hidden');
          const videoContainer = $('videoContainer');
          if (videoContainer) videoContainer.focus();

          sound.success();
          showToast('Connected! You are viewing & controlling remote screen.', 'success');
          startPingHeartbeat();
          if (state.targetCode) saveRecentConnection(state.targetCode);
        });

        call.on('close', () => {
          stopAllSessions('Your partner stopped sharing their screen.');
        });
      });

    } catch (e) {
      console.error('[PeerJS Init Error]', e);
    }
  }

  // =========================================================================
  // Data Channel Messaging
  // =========================================================================
  function listenToDataChannel(conn) {
    conn.on('data', (data) => {
      if (!data) return;

      // 1. Partner asks permission (Host receives this)
      if (data.type === 'ask-permission') {
        const callerCode = data.fromCode || conn.peer.replace('omni-', '');
        state.targetCode = callerCode;
        sound.ring();
        const friendCodeEl = $('incomingFriendCode');
        if (friendCodeEl) friendCodeEl.textContent = formatDisplay(callerCode);
        const modal = $('modalIncoming');
        if (modal) modal.classList.remove('hidden');
      }

      // 2. Partner accepted (Viewer receives this)
      else if (data.type === 'accepted') {
        const title = $('loaderTitle');
        const sub = $('loaderSubtitle');
        if (title) title.textContent = 'Starting video stream...';
        if (sub) sub.textContent = 'Streaming 60 FPS ultra-low latency WebRTC';
        sound.success();
      }

      // 3. Partner declined
      else if (data.type === 'declined') {
        sound.end();
        showToast('Your partner declined the screen share request.', 'warning');
        resetConnectButton();
      }

      // 4. Partner cancelled screen selection
      else if (data.type === 'cancelled') {
        sound.end();
        showToast('Your partner cancelled screen selection.', 'warning');
        resetConnectButton();
      }

      // 5. Ping & Pong
      else if (data.type === 'ping') {
        if (conn.open) conn.send({ type: 'pong', t: data.t });
      } else if (data.type === 'pong') {
        const rtt = Math.max(1, Math.round(Date.now() - data.t));
        const pingEl = $('sessionPing');
        if (pingEl) {
          pingEl.textContent = `${rtt} ms`;
          pingEl.style.color = rtt < 80 ? '#34d399' : (rtt < 160 ? '#fbbf24' : '#f87171');
        }
      }

      // 6. Laser Pointer
      else if (data.type === 'laser') {
        laserPoint = { x: data.x, y: data.y, time: Date.now() };
        if (data.click) {
          triggerLaserRipple(data.x, data.y);
          sound.play(750, 0.04);
        }
      }

      // 7. Remote Input Event (Mouse / Keyboard Relay to Host)
      else if (data.type === 'input') {
        const ev = data.event;
        if (!ev) return;

        relayToNativeHost(ev);

        // Update Host Remote Cursor
        if (ev.type === 'mousemove') {
          const cursor = $('hostRemoteCursor');
          if (cursor) {
            cursor.classList.remove('hidden');
            const screenX = ev.xPercent * window.innerWidth;
            const screenY = ev.yPercent * window.innerHeight;
            cursor.style.left = `${screenX}px`;
            cursor.style.top = `${screenY}px`;
          }
        } else if (ev.type === 'mousedown') {
          const btnName = ev.button === 2 ? 'Right Click' : (ev.button === 1 ? 'Middle Click' : 'Left Click');
          showHostKeyHUD(`🖱️ Remote: ${btnName}`);
          sound.play(600, 0.05);
        } else if (ev.type === 'keydown') {
          const keyLabel = ev.key && ev.key.length === 1 ? `"${ev.key}"` : `[${ev.key}]`;
          showHostKeyHUD(`⌨️ Remote Typed: ${keyLabel}`);
          sound.play(540, 0.04);

          // Type into host test pad if visible
          const pad = $('hostScratchpadInput');
          if (pad) {
            if (ev.key === 'Backspace') {
              pad.value = pad.value.slice(0, -1);
            } else if (ev.key === 'Enter') {
              pad.value += '\n';
            } else if (ev.key && ev.key.length === 1) {
              pad.value += ev.key;
            }
          }
        }
      }

      // 8. Special Keys
      else if (data.type === 'special-key') {
        relayToNativeHost({ type: 'special', action: data.action });
        showHostKeyHUD(`⚡ Remote Special: [${data.action}]`);
        sound.play(700, 0.08);
      }

      // 9. Custom String Typing
      else if (data.type === 'type-string') {
        showHostKeyHUD(`⌨️ Remote Typed: "${data.text}"`);
        const pad = $('hostScratchpadInput');
        if (pad && data.text) pad.value += data.text + ' ';
        if (data.text && state.hasServerApi) {
          for (let i = 0; i < data.text.length; i++) {
            const char = data.text[i];
            setTimeout(() => {
              relayToNativeHost({ type: 'keydown', key: char, keyCode: char.charCodeAt(0) });
              relayToNativeHost({ type: 'keyup', key: char, keyCode: char.charCodeAt(0) });
            }, i * 30);
          }
        }
        sound.success();
      }

      // 10. Live Chat
      else if (data.type === 'chat') {
        appendChatMessage(data.text, 'theirs');
        if (!state.isChatOpen) {
          state.unreadChatCount++;
          const badge = $('chatBadge');
          if (badge) {
            badge.textContent = state.unreadChatCount;
            badge.classList.remove('hidden');
          }
          sound.play(700, 0.1);
        }
      }

      // 11. Chunked File Transfer
      else if (data.type === 'file-start') {
        state.incomingFile = {
          name: data.name,
          size: data.size,
          mime: data.mime,
          chunks: [],
          receivedBytes: 0
        };
        const banner = $('fileBanner');
        if (banner) banner.classList.remove('hidden');
        const nameEl = $('fileName');
        if (nameEl) nameEl.textContent = data.name;
        const fill = $('fileProgressFill');
        if (fill) fill.style.width = '0%';
        const status = $('fileStatusText');
        if (status) status.textContent = 'Receiving file... 0%';
        sound.play(600, 0.1);
      } else if (data.type === 'file-chunk') {
        if (!state.incomingFile) return;
        state.incomingFile.chunks.push(data.chunk);
        state.incomingFile.receivedBytes += data.chunk.byteLength;
        const pct = Math.min(100, Math.round((state.incomingFile.receivedBytes / state.incomingFile.size) * 100));
        const fill = $('fileProgressFill');
        if (fill) fill.style.width = `${pct}%`;
        const status = $('fileStatusText');
        if (status) status.textContent = `Receiving... ${pct}%`;
      } else if (data.type === 'file-end') {
        if (!state.incomingFile) return;
        const blob = new Blob(state.incomingFile.chunks, { type: state.incomingFile.mime });
        const url = URL.createObjectURL(blob);
        const status = $('fileStatusText');
        if (status) {
          status.innerHTML = `<a href="${url}" download="${state.incomingFile.name}" style="color: #3b82f6; font-weight: 700; text-decoration: underline;">Download File</a>`;
        }
        showToast(`Received ${state.incomingFile.name}!`, 'success');
        sound.success();

        const a = document.createElement('a');
        a.href = url;
        a.download = state.incomingFile.name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        state.incomingFile = null;
      }

      // 12. End session
      else if (data.type === 'end-session') {
        stopAllSessions(data.reason || 'Your partner ended the session.');
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
    const input = $('targetCodeInput');
    const clean = cleanDigits(input ? input.value : '');

    if (clean.length !== 6) {
      showToast('Please enter a 6-digit Desk Code (e.g. 482 910)', 'warning');
      if (input) input.focus();
      return;
    }

    if (clean === state.myCode) {
      showToast('Cannot connect to your own computer code!', 'warning');
      return;
    }

    state.targetCode = clean;

    const btnConnect = $('btnConnect');
    const btnText = $('connectBtnText');
    const spinner = $('connectSpinner');
    if (btnConnect) btnConnect.disabled = true;
    if (btnText) btnText.textContent = 'Connecting...';
    if (spinner) spinner.classList.remove('hidden');

    try {
      const conn = state.peer.connect('omni-' + clean, { reliable: true });
      state.activeConn = conn;
      listenToDataChannel(conn);

      state.connectTimeoutTimer = setTimeout(() => {
        const sessionView = $('sessionView');
        const loader = $('loaderOverlay');
        if (sessionView && !sessionView.classList.contains('hidden') && loader && !loader.classList.contains('hidden')) {
          showToast('Connection timed out. Partner may be offline.', 'error');
          resetConnectButton();
        }
      }, 18000);

      conn.on('open', () => {
        console.log('[Connected to Partner DataChannel] Asking permission...');
        conn.send({
          type: 'ask-permission',
          fromCode: state.myCode
        });

        const mainView = $('mainView');
        const sessionView = $('sessionView');
        const loader = $('loaderOverlay');
        const title = $('loaderTitle');
        const sub = $('loaderSubtitle');
        const partnerName = $('sessionPartnerName');

        if (mainView) mainView.classList.add('hidden');
        if (sessionView) sessionView.classList.remove('hidden');
        if (loader) loader.classList.remove('hidden');
        if (title) title.textContent = `Asking partner (${formatDisplay(clean)})...`;
        if (sub) sub.textContent = 'Waiting for them to click "Allow" on their screen';
        if (partnerName) partnerName.textContent = `Remote Screen (${formatDisplay(clean)})`;
      });

    } catch (e) {
      showToast('Failed to connect: ' + e.message, 'error');
      resetConnectButton();
    }
  }

  function resetConnectButton() {
    if (state.connectTimeoutTimer) clearTimeout(state.connectTimeoutTimer);
    const btnConnect = $('btnConnect');
    const btnText = $('connectBtnText');
    const spinner = $('connectSpinner');
    const sessionView = $('sessionView');
    const mainView = $('mainView');

    if (btnConnect) btnConnect.disabled = false;
    if (btnText) btnText.textContent = 'Connect Now';
    if (spinner) spinner.classList.add('hidden');
    if (sessionView) sessionView.classList.add('hidden');
    if (mainView) mainView.classList.remove('hidden');
  }

  // =========================================================================
  // Host Response Actions (Allow / Decline)
  // =========================================================================
  async function hostAcceptScreenShare() {
    const modal = $('modalIncoming');
    if (modal) modal.classList.add('hidden');

    try {
      let stream;
      try {
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: { cursor: 'always', frameRate: { ideal: 60, max: 60 } },
          audio: false
        });
      } catch (e1) {
        try {
          stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
        } catch (e2) {
          stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
        }
      }

      state.localStream = stream;
      state.isHost = true;

      if (stream.getVideoTracks() && stream.getVideoTracks()[0]) {
        stream.getVideoTracks()[0].onended = () => {
          stopAllSessions('You stopped sharing your screen.');
        };
      }

      if (state.activeConn) {
        state.activeCall = state.peer.call(state.activeConn.peer, stream);
        state.activeConn.send({ type: 'accepted' });
      }

      const notice = $('hostNotice');
      const noticeSub = $('hostNoticeSub');
      const friendCode = $('incomingFriendCode');
      const testPad = $('hostTestPad');

      if (notice) notice.classList.remove('hidden');
      if (noticeSub && friendCode) noticeSub.textContent = `Partner controlling: ${friendCode.textContent}`;
      if (testPad) testPad.classList.remove('hidden');

      sound.success();
      showToast('Screen streaming & remote control is LIVE!', 'success');
      startPingHeartbeat();
      if (state.targetCode) saveRecentConnection(state.targetCode);

    } catch (err) {
      console.warn('[Screen Share Cancelled / Not Allowed]', err);
      if (state.activeConn) {
        state.activeConn.send({ type: 'cancelled' });
      }
      showToast('Screen share permission cancelled or not allowed', 'info');
    }
  }

  function hostDecline() {
    const modal = $('modalIncoming');
    if (modal) modal.classList.add('hidden');
    if (state.activeConn) {
      state.activeConn.send({ type: 'declined' });
      try { state.activeConn.close(); } catch (e) {}
    }
    showToast('Declined request', 'info');
  }

  // =========================================================================
  // Normalized Coordinates Calculation
  // =========================================================================
  function getNormalizedCoords(e) {
    const video = $('remoteVideo');
    if (!video) return null;
    const rect = video.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;

    const clientX = e.clientX - rect.left;
    const clientY = e.clientY - rect.top;

    const videoWidth = video.videoWidth || rect.width;
    const videoHeight = video.videoHeight || rect.height;

    const videoRatio = videoWidth / videoHeight;
    const elementRatio = rect.width / rect.height;

    let actualWidth = rect.width;
    let actualHeight = rect.height;
    let offsetX = 0;
    let offsetY = 0;

    if (elementRatio > videoRatio) {
      actualWidth = rect.height * videoRatio;
      offsetX = (rect.width - actualWidth) / 2;
    } else {
      actualHeight = rect.width / videoRatio;
      offsetY = (rect.height - actualHeight) / 2;
    }

    const relativeX = clientX - offsetX;
    const relativeY = clientY - offsetY;

    const xPercent = Math.max(0, Math.min(1, relativeX / actualWidth));
    const yPercent = Math.max(0, Math.min(1, relativeY / actualHeight));

    return { xPercent, yPercent };
  }

  function sendRemoteInput(event) {
    if (!state.activeConn || !state.activeConn.open) return;
    state.activeConn.send({
      type: 'input',
      event
    });
  }

  // =========================================================================
  // Chat Functions
  // =========================================================================
  function appendChatMessage(text, side) {
    const container = $('chatMessages');
    if (!container) return;
    const bubble = document.createElement('div');
    bubble.className = `msg-bubble ${side}`;
    bubble.textContent = text;
    container.appendChild(bubble);
    container.scrollTop = container.scrollHeight;
  }

  function sendChatMessage(e) {
    if (e) e.preventDefault();
    const input = $('chatInput');
    const text = input ? input.value.trim() : '';
    if (!text || !state.activeConn) return;

    state.activeConn.send({
      type: 'chat',
      text
    });

    appendChatMessage(text, 'mine');
    if (input) input.value = '';
  }

  // =========================================================================
  // File Transfer Function
  // =========================================================================
  function sendFileToFriend(file) {
    if (!state.activeConn) {
      showToast('No active connection to send file!', 'error');
      return;
    }

    const banner = $('fileBanner');
    const nameEl = $('fileName');
    const fill = $('fileProgressFill');
    const status = $('fileStatusText');

    if (banner) banner.classList.remove('hidden');
    if (nameEl) nameEl.textContent = file.name;
    if (fill) fill.style.width = '0%';
    if (status) status.textContent = 'Sending... 0%';

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
      if (fill) fill.style.width = `${pct}%`;
      if (status) status.textContent = `Sending... ${pct}%`;

      if (chunkIndex < totalChunks) {
        setTimeout(readNext, 10);
      } else {
        state.activeConn.send({ type: 'file-end' });
        if (status) status.textContent = 'Sent Successfully!';
        showToast(`Sent ${file.name}!`, 'success');
        setTimeout(() => {
          if (banner) banner.classList.add('hidden');
        }, 2500);
      }
    };

    readNext();
  }

  // =========================================================================
  // Stop Session / Disconnect
  // =========================================================================
  function stopAllSessions(reason = 'Session ended.') {
    if (state.connectTimeoutTimer) clearTimeout(state.connectTimeoutTimer);
    stopPingHeartbeat();

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

    const video = $('remoteVideo');
    if (video && video.srcObject) {
      video.srcObject = null;
    }

    if (document.fullscreenElement) {
      try { document.exitFullscreen(); } catch (e) {}
    }

    const cursor = $('hostRemoteCursor');
    const hud = $('hostKeyHUD');
    const sessionView = $('sessionView');
    const hostNotice = $('hostNotice');
    const modal = $('modalIncoming');
    const drawer = $('chatDrawer');
    const banner = $('fileBanner');
    const dropdown = $('keysDropdown');
    const testPad = $('hostTestPad');
    const dropZone = $('dropZoneOverlay');
    const mainView = $('mainView');

    if (cursor) cursor.classList.add('hidden');
    if (hud) hud.classList.add('hidden');
    if (sessionView) sessionView.classList.add('hidden');
    if (hostNotice) hostNotice.classList.add('hidden');
    if (modal) modal.classList.add('hidden');
    if (drawer) drawer.classList.add('hidden');
    if (banner) banner.classList.add('hidden');
    if (dropdown) dropdown.classList.add('hidden');
    if (testPad) testPad.classList.add('hidden');
    if (dropZone) dropZone.classList.add('hidden');
    if (mainView) mainView.classList.remove('hidden');

    resetConnectButton();
    sound.end();
    showToast(reason, 'info');
  }

  // =========================================================================
  // UI Event Bindings
  // =========================================================================
  function bindUI() {
    // Theme Toggle Handler
    on($('btnThemeToggle'), 'click', () => {
      const isLight = document.body.classList.toggle('light-theme');
      const icon = $('themeIcon');
      if (icon) icon.textContent = isLight ? '🌙' : '☀️';
      try {
        localStorage.setItem('omnicast_theme', isLight ? 'light' : 'dark');
      } catch (e) {}
      showToast(isLight ? 'Light Theme Enabled' : 'Dark Theme Enabled', 'info');
    });

    // Dismiss file banner if present
    on($('btnDismissScheme'), 'click', () => {
      const banner = $('fileSchemeBanner');
      if (banner) banner.classList.add('hidden');
    });

    // Copy Code Button
    on($('btnCopyCode'), 'click', () => {
      navigator.clipboard.writeText(state.myCode).then(() => {
        const btn = $('btnCopyCode');
        const text = $('copyBtnText');
        if (btn) btn.classList.add('copied');
        if (text) text.textContent = 'Copied!';
        showToast('Code copied! Send it to your partner.', 'success');
        setTimeout(() => {
          if (btn) btn.classList.remove('copied');
          if (text) text.textContent = 'Copy Code';
        }, 2000);
      });
    });

    // Get New Code
    on($('btnNewCode'), 'click', () => {
      const fresh = String(Math.floor(100000 + Math.random() * 900000));
      state.myCode = fresh;
      try {
        localStorage.setItem('omnicast_my_code', fresh);
      } catch (e) {}
      const disp = $('myCodeDisplay');
      if (disp) disp.textContent = formatDisplay(fresh);
      initPeer();
      showToast('Generated a new code!', 'info');
    });

    // Partner Code Input & Paste
    on($('targetCodeInput'), 'input', (e) => {
      const clean = cleanDigits(e.target.value);
      e.target.value = formatDisplay(clean);
    });

    on($('targetCodeInput'), 'paste', (e) => {
      e.preventDefault();
      const text = (e.clipboardData || window.clipboardData).getData('text');
      const clean = cleanDigits(text);
      const input = $('targetCodeInput');
      if (input) input.value = formatDisplay(clean);
    });

    // Connect Form Submit
    on($('connectForm'), 'submit', startConnect);
    on($('btnCancelConnect'), 'click', () => stopAllSessions('Cancelled connection.'));

    // Host Incoming Modal Buttons
    on($('btnAccept'), 'click', hostAcceptScreenShare);
    on($('btnDecline'), 'click', hostDecline);
    on($('btnHostStop'), 'click', () => stopAllSessions('You stopped sharing.'));

    // Mode Switch: Control vs Laser
    on($('btnToggleControl'), 'click', () => {
      state.mode = 'control';
      const btnControl = $('btnToggleControl');
      const btnPointer = $('btnTogglePointer');
      const video = $('remoteVideo');
      if (btnControl) btnControl.classList.add('active');
      if (btnPointer) btnPointer.classList.remove('active');
      if (video) video.classList.add('control-active');
      showToast('🎮 Remote Control: Live Mouse & Keyboard Active', 'info');
    });

    on($('btnTogglePointer'), 'click', () => {
      state.mode = 'laser';
      const btnControl = $('btnToggleControl');
      const btnPointer = $('btnTogglePointer');
      const video = $('remoteVideo');
      if (btnPointer) btnPointer.classList.add('active');
      if (btnControl) btnControl.classList.remove('active');
      if (video) video.classList.remove('control-active');
      showToast('🔴 Laser Highlight Mode Active', 'info');
    });

    // Audio Mute / Unmute Toggle
    on($('btnToggleAudio'), 'click', () => {
      const video = $('remoteVideo');
      const label = $('audioLabel');
      const icon = $('audioIcon');
      if (!video) return;
      video.muted = !video.muted;
      if (label) label.textContent = video.muted ? 'Muted' : 'Sound On';
      if (icon) {
        icon.innerHTML = video.muted 
          ? '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><line x1="23" y1="9" x2="17" y2="15"></line><line x1="17" y1="9" x2="23" y2="15"></line>'
          : '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path>';
      }
      showToast(video.muted ? 'Remote Audio Muted' : 'Remote Audio Unmuted', 'info');
    });

    // Fit Screen vs Stretch Toggle
    on($('btnToggleFit'), 'click', () => {
      const video = $('remoteVideo');
      if (!video) return;
      const isStretch = video.classList.toggle('fit-stretch');
      showToast(isStretch ? 'Mode: Stretch Full View' : 'Mode: Fit Aspect Ratio', 'info');
    });

    // Special Keys Dropdown Toggle
    on($('btnSpecialKeys'), 'click', (e) => {
      e.stopPropagation();
      state.isKeysOpen = !state.isKeysOpen;
      const dropdown = $('keysDropdown');
      if (dropdown) dropdown.classList.toggle('hidden', !state.isKeysOpen);
    });

    document.addEventListener('click', (e) => {
      const dropdown = $('keysDropdown');
      const btn = $('btnSpecialKeys');
      if (dropdown && !dropdown.contains(e.target) && e.target !== btn) {
        state.isKeysOpen = false;
        dropdown.classList.add('hidden');
      }
    });

    function sendSpecialAction(action) {
      if (!state.activeConn || !state.activeConn.open) {
        showToast('No active session connected!', 'warning');
        return;
      }
      state.activeConn.send({ type: 'special-key', action });
      showToast(`Sent [${action}] to remote partner!`, 'success');
      state.isKeysOpen = false;
      const dropdown = $('keysDropdown');
      if (dropdown) dropdown.classList.add('hidden');
    }

    on($('btnKeyCAD'), 'click', () => sendSpecialAction('CAD'));
    on($('btnKeyWin'), 'click', () => sendSpecialAction('WIN'));
    on($('btnKeyAltTab'), 'click', () => sendSpecialAction('ALTTAB'));

    function sendCustomText() {
      const input = $('textSenderInput');
      const text = input ? input.value : '';
      if (!text) return;
      if (!state.activeConn || !state.activeConn.open) {
        showToast('No active session connected!', 'warning');
        return;
      }
      state.activeConn.send({ type: 'type-string', text });
      showToast(`Typed "${text}" on remote partner's screen!`, 'success');
      if (input) input.value = '';
      state.isKeysOpen = false;
      const dropdown = $('keysDropdown');
      if (dropdown) dropdown.classList.add('hidden');
    }

    on($('btnSendTextToRemote'), 'click', sendCustomText);
    on($('textSenderInput'), 'keydown', (e) => {
      if (e.key === 'Enter') sendCustomText();
    });

    // Drag & Drop File Transfer on Video Container
    const videoContainer = $('videoContainer');
    const dropZone = $('dropZoneOverlay');

    on(videoContainer, 'dragover', (e) => {
      e.preventDefault();
      if (dropZone) dropZone.classList.remove('hidden');
    });

    on(videoContainer, 'dragleave', (e) => {
      if (e.relatedTarget === null || !videoContainer.contains(e.relatedTarget)) {
        if (dropZone) dropZone.classList.add('hidden');
      }
    });

    on(videoContainer, 'drop', (e) => {
      e.preventDefault();
      if (dropZone) dropZone.classList.add('hidden');
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        sendFileToFriend(e.dataTransfer.files[0]);
      }
    });

    // Remote Video Mouse Events
    const video = $('remoteVideo');
    on(video, 'mousemove', (e) => {
      const coords = getNormalizedCoords(e);
      if (!coords) return;

      if (state.mode === 'laser') {
        if (state.activeConn && state.activeConn.open) {
          laserPoint = { x: coords.xPercent, y: coords.yPercent, time: Date.now() };
          state.activeConn.send({
            type: 'laser',
            x: coords.xPercent,
            y: coords.yPercent,
            click: false
          });
        }
      } else {
        const now = Date.now();
        if (now - state.lastMouseMoveTime > 16) {
          state.lastMouseMoveTime = now;
          sendRemoteInput({
            type: 'mousemove',
            xPercent: coords.xPercent,
            yPercent: coords.yPercent
          });
        }
      }
    });

    on(video, 'mousedown', (e) => {
      const container = $('videoContainer');
      if (container) container.focus();
      const coords = getNormalizedCoords(e);
      if (!coords) return;

      if (state.mode === 'laser') {
        triggerLaserRipple(coords.xPercent, coords.yPercent);
        if (state.activeConn && state.activeConn.open) {
          state.activeConn.send({
            type: 'laser',
            x: coords.xPercent,
            y: coords.yPercent,
            click: true
          });
        }
      } else {
        sendRemoteInput({
          type: 'mousedown',
          button: e.button,
          xPercent: coords.xPercent,
          yPercent: coords.yPercent
        });
      }
    });

    on(video, 'mouseup', (e) => {
      if (state.mode !== 'control') return;
      const coords = getNormalizedCoords(e);
      if (!coords) return;
      sendRemoteInput({
        type: 'mouseup',
        button: e.button,
        xPercent: coords.xPercent,
        yPercent: coords.yPercent
      });
    });

    on(video, 'contextmenu', (e) => {
      e.preventDefault();
      if (state.mode === 'control') {
        const coords = getNormalizedCoords(e);
        if (coords) {
          sendRemoteInput({ type: 'mousedown', button: 2, xPercent: coords.xPercent, yPercent: coords.yPercent });
          setTimeout(() => {
            sendRemoteInput({ type: 'mouseup', button: 2, xPercent: coords.xPercent, yPercent: coords.yPercent });
          }, 50);
        }
      }
    });

    on(video, 'wheel', (e) => {
      if (state.mode !== 'control') return;
      e.preventDefault();
      sendRemoteInput({
        type: 'wheel',
        deltaY: e.deltaY
      });
    }, { passive: false });

    // Keyboard Relay
    window.addEventListener('keydown', (e) => {
      const sessionView = $('sessionView');
      if (!sessionView || sessionView.classList.contains('hidden') || state.mode !== 'control') return;

      const chatInput = $('chatInput');
      const textInput = $('textSenderInput');
      if (document.activeElement === chatInput || document.activeElement === textInput) return;

      if (['Tab', 'Backspace', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(e.key)) {
        e.preventDefault();
      }

      sendRemoteInput({
        type: 'keydown',
        key: e.key,
        keyCode: e.keyCode || e.which,
        ctrlKey: e.ctrlKey,
        shiftKey: e.shiftKey,
        altKey: e.altKey
      });
    });

    window.addEventListener('keyup', (e) => {
      const sessionView = $('sessionView');
      if (!sessionView || sessionView.classList.contains('hidden') || state.mode !== 'control') return;

      const chatInput = $('chatInput');
      const textInput = $('textSenderInput');
      if (document.activeElement === chatInput || document.activeElement === textInput) return;

      sendRemoteInput({
        type: 'keyup',
        key: e.key,
        keyCode: e.keyCode || e.which
      });
    });

    // Chat
    on($('btnOpenChat'), 'click', () => {
      state.isChatOpen = !state.isChatOpen;
      const drawer = $('chatDrawer');
      if (drawer) drawer.classList.toggle('hidden', !state.isChatOpen);
      if (state.isChatOpen) {
        state.unreadChatCount = 0;
        const badge = $('chatBadge');
        if (badge) badge.classList.add('hidden');
        const input = $('chatInput');
        if (input) input.focus();
      }
    });

    on($('btnCloseChat'), 'click', () => {
      state.isChatOpen = false;
      const drawer = $('chatDrawer');
      if (drawer) drawer.classList.add('hidden');
    });

    on($('chatForm'), 'submit', sendChatMessage);

    // File Picker
    const picker = $('filePickerInput');
    on($('btnOpenFile'), 'click', () => {
      if (picker) picker.click();
    });

    on(picker, 'change', (e) => {
      if (e.target.files && e.target.files[0]) {
        sendFileToFriend(e.target.files[0]);
      }
    });

    on($('btnCloseFileBanner'), 'click', () => {
      const banner = $('fileBanner');
      if (banner) banner.classList.add('hidden');
    });

    // Fullscreen
    on($('btnFullscreen'), 'click', () => {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(() => {});
      } else {
        document.exitFullscreen().catch(() => {});
      }
    });

    // Disconnect
    on($('btnStopSession'), 'click', () => stopAllSessions('You ended the session.'));
  }

  // Start Application
  function init() {
    bindUI();
    initLaserCanvas();
    renderRecentChips();
    checkLocalInputServer();
    initPeer();
    console.log('[OmniCast Remote Desktop] Ready & Live.');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
