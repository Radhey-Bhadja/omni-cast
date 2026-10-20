/**
 * OmniCast — 100% Functional WebRTC Remote Desktop (AnyDesk Grade)
 * Full Mouse, Keyboard, Wheel, Special Keys & Native Host OS Bridge.
 */

if (window.__OMNICAST_INITIALIZED__) {
  console.warn('[OmniCast] Already initialized.');
} else {
  window.__OMNICAST_INITIALIZED__ = true;

  (() => {
    'use strict';

    // Public Google & OpenRelay STUN servers for cross-network WebRTC
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
      hasServerApi: false
    };

    // Simple Audio Chimes (Zero dependencies)
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
      fileSchemeBanner: document.getElementById('fileSchemeBanner'),
      btnDismissScheme: document.getElementById('btnDismissScheme'),
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
      recentContainer: document.getElementById('recentContainer'),
      recentChips: document.getElementById('recentChips'),
      
      // Active Session
      sessionView: document.getElementById('sessionView'),
      videoContainer: document.getElementById('videoContainer'),
      remoteVideo: document.getElementById('remoteVideo'),
      laserCanvas: document.getElementById('laserCanvas'),
      loaderOverlay: document.getElementById('loaderOverlay'),
      loaderTitle: document.getElementById('loaderTitle'),
      loaderSubtitle: document.getElementById('loaderSubtitle'),
      btnCancelConnect: document.getElementById('btnCancelConnect'),
      sessionPartnerName: document.getElementById('sessionPartnerName'),
      sessionPing: document.getElementById('sessionPing'),
      
      // Control & Laser Modes
      btnToggleControl: document.getElementById('btnToggleControl'),
      btnTogglePointer: document.getElementById('btnTogglePointer'),

      // Special Keys
      btnSpecialKeys: document.getElementById('btnSpecialKeys'),
      keysDropdown: document.getElementById('keysDropdown'),
      btnKeyCAD: document.getElementById('btnKeyCAD'),
      btnKeyWin: document.getElementById('btnKeyWin'),
      btnKeyAltTab: document.getElementById('btnKeyAltTab'),
      textSenderInput: document.getElementById('textSenderInput'),
      btnSendTextToRemote: document.getElementById('btnSendTextToRemote'),

      // Chat & File
      btnOpenChat: document.getElementById('btnOpenChat'),
      chatBadge: document.getElementById('chatBadge'),
      btnOpenFile: document.getElementById('btnOpenFile'),
      filePickerInput: document.getElementById('filePickerInput'),
      btnFullscreen: document.getElementById('btnFullscreen'),
      btnStopSession: document.getElementById('btnStopSession'),

      // Host Screen Overlays
      hostNotice: document.getElementById('hostNotice'),
      hostNoticeSub: document.getElementById('hostNoticeSub'),
      btnHostStop: document.getElementById('btnHostStop'),
      hostRemoteCursor: document.getElementById('hostRemoteCursor'),
      remoteCursorTag: document.getElementById('remoteCursorTag'),
      hostKeyHUD: document.getElementById('hostKeyHUD'),
      hostKeyHUDText: document.getElementById('hostKeyHUDText'),

      // Incoming Modal
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

      toastContainer: document.getElementById('toastContainer')
    };

    // Laser Canvas Setup
    let laserCtx = null;
    let ripples = [];
    let laserPoint = null;
    let animFrameId = null;

    function initLaserCanvas() {
      if (!el.laserCanvas) return;
      laserCtx = el.laserCanvas.getContext('2d');
      resizeLaserCanvas();
      window.addEventListener('resize', resizeLaserCanvas);
      startLaserLoop();
    }

    function resizeLaserCanvas() {
      if (!el.laserCanvas) return;
      el.laserCanvas.width = window.innerWidth;
      el.laserCanvas.height = window.innerHeight;
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
      if (!laserCtx || !el.laserCanvas) return;
      laserCtx.clearRect(0, 0, el.laserCanvas.width, el.laserCanvas.height);

      // Render Laser Point
      if (laserPoint && (Date.now() - laserPoint.time < 1200)) {
        const x = laserPoint.x * el.laserCanvas.width;
        const y = laserPoint.y * el.laserCanvas.height;

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

      // Render Ripples
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
        const x = r.x * el.laserCanvas.width;
        const y = r.y * el.laserCanvas.height;

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

    // Check Local Node Input Server Availability
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

    // Dispatch Remote Event to Native Windows OS via server.js
    function relayToNativeHost(event) {
      if (!state.isHost) return;
      fetch('/api/host-input', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event })
      }).catch(() => {});
    }

    // Recent Connections Management
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
      localStorage.setItem('omnicast_recents', JSON.stringify(recents));
      renderRecentChips();
    }

    function renderRecentChips() {
      if (!el.recentChips || !el.recentContainer) return;
      const recents = getRecentConnections();
      el.recentChips.innerHTML = '';
      if (recents.length === 0) {
        el.recentContainer.classList.add('hidden');
        return;
      }
      el.recentContainer.classList.remove('hidden');
      recents.forEach(code => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'recent-chip';
        chip.textContent = formatDisplay(code);
        chip.title = `Connect to ${formatDisplay(code)}`;
        chip.addEventListener('click', () => {
          el.targetCodeInput.value = formatDisplay(code);
          startConnect();
        });
        el.recentChips.appendChild(chip);
      });
    }

    // Ping / Latency Monitor
    function startPingHeartbeat() {
      stopPingHeartbeat();
      state.pingInterval = setInterval(() => {
        if (state.activeConn && state.activeConn.open) {
          state.activeConn.send({ type: 'ping', t: Date.now() });
        }
      }, 2500);
    }

    function stopPingHeartbeat() {
      if (state.pingInterval) {
        clearInterval(state.pingInterval);
        state.pingInterval = null;
      }
      if (el.sessionPing) el.sessionPing.textContent = '-- ms';
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

        // Connected to PeerJS Broker
        state.peer.on('open', (id) => {
          console.log('[OmniCast Peer Open]', id);
          el.statusLabel.textContent = 'Ready';
          el.connectionStatus.className = 'status-badge status-online';
        });

        // Error Handling
        state.peer.on('error', (err) => {
          console.warn('[PeerJS]', err.type, err.message);
          if (err.type === 'unavailable-id') {
            const fresh = getRandom6Digits();
            state.myCode = fresh;
            localStorage.setItem('omnicast_my_code', fresh);
            el.myCodeDisplay.textContent = formatDisplay(fresh);
            initPeer();
          } else if (err.type === 'peer-unavailable') {
            showToast('That code is offline. Check with your partner!', 'error');
            resetConnectButton();
          }
        });

        // HOST: Listen for incoming connection from partner
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
            el.remoteVideo.play().catch(e => console.log('Autoplay hint:', e));
            el.loaderOverlay.classList.add('hidden');
            el.videoContainer.focus();
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
    // Data Channel Messaging (Chat, File, Input Relay, Ping, Laser)
    // =========================================================================
    let hudTimer = null;
    function showHostKeyHUD(text) {
      if (!el.hostKeyHUD) return;
      el.hostKeyHUDText.textContent = text;
      el.hostKeyHUD.classList.remove('hidden');
      if (hudTimer) clearTimeout(hudTimer);
      hudTimer = setTimeout(() => {
        el.hostKeyHUD.classList.add('hidden');
      }, 1400);
    }

    function listenToDataChannel(conn) {
      conn.on('data', (data) => {
        if (!data) return;

        // 1. Partner asks permission (Host receives this)
        if (data.type === 'ask-permission') {
          const callerCode = data.fromCode || conn.peer.replace('omni-', '');
          state.targetCode = callerCode;
          sound.ring();
          el.incomingFriendCode.textContent = formatDisplay(callerCode);
          el.modalIncoming.classList.remove('hidden');
        }

        // 2. Partner accepted! (Viewer receives this)
        else if (data.type === 'accepted') {
          el.loaderTitle.textContent = 'Starting video stream...';
          el.loaderSubtitle.textContent = 'Getting 60 FPS live picture & input channel';
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
          if (el.sessionPing) {
            el.sessionPing.textContent = `${rtt} ms`;
            el.sessionPing.style.color = rtt < 80 ? '#34d399' : (rtt < 160 ? '#fbbf24' : '#f87171');
          }
        }

        // 6. Laser Pointer Event (Viewer -> Host)
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

          // Relay to Native Windows OS Controller if local server is running
          relayToNativeHost(ev);

          // Update Visual Cursor Overlay on Host Screen
          if (ev.type === 'mousemove') {
            if (el.hostRemoteCursor) {
              el.hostRemoteCursor.classList.remove('hidden');
              const screenX = ev.xPercent * window.innerWidth;
              const screenY = ev.yPercent * window.innerHeight;
              el.hostRemoteCursor.style.left = `${screenX}px`;
              el.hostRemoteCursor.style.top = `${screenY}px`;
            }
          } else if (ev.type === 'mousedown') {
            const btnName = ev.button === 2 ? 'Right Click' : (ev.button === 1 ? 'Middle Click' : 'Left Click');
            showHostKeyHUD(`🖱️ Remote: ${btnName}`);
            sound.play(600, 0.05);
          } else if (ev.type === 'keydown') {
            const keyLabel = ev.key.length === 1 ? `"${ev.key}"` : `[${ev.key}]`;
            showHostKeyHUD(`⌨️ Remote Typed: ${keyLabel}`);
            sound.play(540, 0.04);
          }
        }

        // 8. Special Key Commands (CAD, WIN, ALTTAB)
        else if (data.type === 'special-key') {
          relayToNativeHost({ type: 'special', action: data.action });
          showHostKeyHUD(`⚡ Remote Special: [${data.action}]`);
          sound.play(700, 0.08);
        }

        // 9. Custom String Typing (Viewer -> Host)
        else if (data.type === 'type-string') {
          showHostKeyHUD(`⌨️ Remote Typed: "${data.text}"`);
          if (data.text) {
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
            el.chatBadge.textContent = state.unreadChatCount;
            el.chatBadge.classList.remove('hidden');
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

      el.btnConnect.disabled = true;
      el.connectBtnText.textContent = 'Connecting...';
      el.connectSpinner.classList.remove('hidden');

      try {
        const conn = state.peer.connect('omni-' + clean, { reliable: true });
        state.activeConn = conn;
        listenToDataChannel(conn);

        state.connectTimeoutTimer = setTimeout(() => {
          if (!el.sessionView.classList.contains('hidden') && el.loaderOverlay.classList.contains('hidden') === false) {
            showToast('Could not connect: Your partner might be offline.', 'error');
            resetConnectButton();
          }
        }, 18000);

        conn.on('open', () => {
          console.log('[Connected to Partner DataChannel] Asking permission...');
          conn.send({
            type: 'ask-permission',
            fromCode: state.myCode
          });

          el.mainView.classList.add('hidden');
          el.sessionView.classList.remove('hidden');
          el.loaderOverlay.classList.remove('hidden');
          el.loaderTitle.textContent = `Asking partner (${formatDisplay(clean)})...`;
          el.loaderSubtitle.textContent = 'Waiting for them to click "Allow" on their screen';
          el.sessionPartnerName.textContent = `Remote Screen (${formatDisplay(clean)})`;
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
        const stream = await navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: { ideal: 60, max: 60 } },
          audio: true
        });
        state.localStream = stream;
        state.isHost = true;

        stream.getVideoTracks()[0].onended = () => {
          stopAllSessions('You stopped sharing your screen.');
        };

        if (state.activeConn) {
          state.activeCall = state.peer.call(state.activeConn.peer, stream);
          state.activeConn.send({ type: 'accepted' });
        }

        el.hostNotice.classList.remove('hidden');
        el.hostNoticeSub.textContent = `Partner controlling: ${el.incomingFriendCode.textContent}`;

        sound.success();
        showToast('Screen sharing & remote control is LIVE!', 'success');
        startPingHeartbeat();
        if (state.targetCode) saveRecentConnection(state.targetCode);

      } catch (err) {
        console.warn('[Screen Share Cancelled / Not Allowed]', err);
        if (state.activeConn) {
          state.activeConn.send({ type: 'cancelled' });
        }
        if (window.location.protocol === 'file:') {
          showToast('Browsers block screen sharing on file://. Double-click start.bat!', 'error');
        } else {
          showToast('Screen share permission cancelled', 'info');
        }
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
    // Real-Time Mouse & Keyboard Input Transmission (Viewer -> Host)
    // =========================================================================
    function getNormalizedCoords(e) {
      const rect = el.remoteVideo.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      const xPercent = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const yPercent = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
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
      const bubble = document.createElement('div');
      bubble.className = `msg-bubble ${side}`;
      bubble.textContent = text;
      el.chatMessages.appendChild(bubble);
      el.chatMessages.scrollTop = el.chatMessages.scrollHeight;
    }

    function sendChatMessage(e) {
      if (e) e.preventDefault();
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

      if (el.remoteVideo.srcObject) {
        el.remoteVideo.srcObject = null;
      }

      if (document.fullscreenElement) {
        try { document.exitFullscreen(); } catch (e) {}
      }

      if (el.hostRemoteCursor) el.hostRemoteCursor.classList.add('hidden');
      if (el.hostKeyHUD) el.hostKeyHUD.classList.add('hidden');

      el.sessionView.classList.add('hidden');
      el.hostNotice.classList.add('hidden');
      el.modalIncoming.classList.add('hidden');
      el.chatDrawer.classList.add('hidden');
      el.fileBanner.classList.add('hidden');
      el.keysDropdown.classList.add('hidden');
      el.mainView.classList.remove('hidden');
      resetConnectButton();

      sound.end();
      showToast(reason, 'info');
    }

    // =========================================================================
    // UI Event Bindings
    // =========================================================================
    function bindUI() {
      // file:// Scheme Check & Dismissal
      if (window.location.protocol === 'file:') {
        if (el.fileSchemeBanner) el.fileSchemeBanner.classList.remove('hidden');
      }
      if (el.btnDismissScheme) {
        el.btnDismissScheme.addEventListener('click', () => el.fileSchemeBanner.classList.add('hidden'));
      }

      // Copy Code Button
      el.btnCopyCode.addEventListener('click', () => {
        navigator.clipboard.writeText(state.myCode).then(() => {
          el.btnCopyCode.classList.add('copied');
          el.copyBtnText.textContent = 'Copied!';
          showToast('Code copied! Send it to your partner.', 'success');
          setTimeout(() => {
            el.btnCopyCode.classList.remove('copied');
            el.copyBtnText.textContent = 'Copy Code';
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

      // Mode Switch: Control vs Laser
      el.btnToggleControl.addEventListener('click', () => {
        state.mode = 'control';
        el.btnToggleControl.classList.add('active');
        el.btnTogglePointer.classList.remove('active');
        el.remoteVideo.classList.add('control-active');
        showToast('🎮 Remote Control Mode: Live Mouse & Keyboard ON', 'info');
      });

      el.btnTogglePointer.addEventListener('click', () => {
        state.mode = 'laser';
        el.btnTogglePointer.classList.add('active');
        el.btnToggleControl.classList.remove('active');
        el.remoteVideo.classList.remove('control-active');
        showToast('🔴 Laser Highlight Mode: Presentation Pointer ON', 'info');
      });

      // Special Keys Dropdown Toggle
      el.btnSpecialKeys.addEventListener('click', (e) => {
        e.stopPropagation();
        state.isKeysOpen = !state.isKeysOpen;
        el.keysDropdown.classList.toggle('hidden', !state.isKeysOpen);
      });
      document.addEventListener('click', (e) => {
        if (!el.keysDropdown.contains(e.target) && e.target !== el.btnSpecialKeys) {
          state.isKeysOpen = false;
          el.keysDropdown.classList.add('hidden');
        }
      });

      // Special Key Action Buttons
      function sendSpecialAction(action) {
        if (!state.activeConn || !state.activeConn.open) {
          showToast('No active session connected!', 'warning');
          return;
        }
        state.activeConn.send({ type: 'special-key', action });
        showToast(`Sent [${action}] to remote partner!`, 'success');
        state.isKeysOpen = false;
        el.keysDropdown.classList.add('hidden');
      }

      el.btnKeyCAD.addEventListener('click', () => sendSpecialAction('CAD'));
      el.btnKeyWin.addEventListener('click', () => sendSpecialAction('WIN'));
      el.btnKeyAltTab.addEventListener('click', () => sendSpecialAction('ALTTAB'));

      // Send Custom Text to Remote
      function sendCustomText() {
        const text = el.textSenderInput.value;
        if (!text) return;
        if (!state.activeConn || !state.activeConn.open) {
          showToast('No active session connected!', 'warning');
          return;
        }
        state.activeConn.send({ type: 'type-string', text });
        showToast(`Typed "${text}" on remote partner's screen!`, 'success');
        el.textSenderInput.value = '';
        state.isKeysOpen = false;
        el.keysDropdown.classList.add('hidden');
      }
      el.btnSendTextToRemote.addEventListener('click', sendCustomText);
      el.textSenderInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') sendCustomText();
      });

      // =======================================================================
      // Remote Video Canvas Event Listeners (Mouse & Keyboard Relay)
      // =======================================================================
      el.remoteVideo.addEventListener('mousemove', (e) => {
        const coords = getNormalizedCoords(e);
        if (!coords) return;

        if (state.mode === 'laser') {
          // Send laser highlight
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
          // Throttle control movement to 60fps (16ms)
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

      el.remoteVideo.addEventListener('mousedown', (e) => {
        el.videoContainer.focus();
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

      el.remoteVideo.addEventListener('mouseup', (e) => {
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

      // Prevent Context Menu on Right Click (Relay real right click instead)
      el.remoteVideo.addEventListener('contextmenu', (e) => {
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

      // Wheel Scroll Relay
      el.remoteVideo.addEventListener('wheel', (e) => {
        if (state.mode !== 'control') return;
        e.preventDefault();
        sendRemoteInput({
          type: 'wheel',
          deltaY: e.deltaY
        });
      }, { passive: false });

      // Keyboard Capture on Session View Container
      window.addEventListener('keydown', (e) => {
        if (el.sessionView.classList.contains('hidden') || state.mode !== 'control') return;
        // If user is currently typing in chat input or text sender, don't trap
        if (document.activeElement === el.chatInput || document.activeElement === el.textSenderInput) return;

        // Prevent common browser navigation keys from leaving session
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
        if (el.sessionView.classList.contains('hidden') || state.mode !== 'control') return;
        if (document.activeElement === el.chatInput || document.activeElement === el.textSenderInput) return;

        sendRemoteInput({
          type: 'keyup',
          key: e.key,
          keyCode: e.keyCode || e.which
        });
      });

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
      el.btnStopSession.addEventListener('click', () => stopAllSessions('You ended the session.'));
    }

    // Start Application
    function init() {
      bindUI();
      initLaserCanvas();
      renderRecentChips();
      checkLocalInputServer();
      initPeer();
      console.log('[OmniCast Remote Desktop] Ready.');
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }

  })();
}
