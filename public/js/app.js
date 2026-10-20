/**
 * OmniCast - Ultra-Low Latency WebRTC Remote Desktop Client
 * Universal Hybrid Architecture:
 *  - Mode 1: Local / Dedicated Node.js + Socket.io Server (with Windows Native Desktop OS Bridge)
 *  - Mode 2: Vercel Serverless / Cloud WebRTC Direct Mesh (Zero-server, instant global P2P)
 * Features:
 *  - Direct P2P Screen Capture (60 FPS, Low-Latency WebRTC)
 *  - Accurate Letterbox & Pillarbox Normalized Coordinates
 *  - Ultra-Low Latency Mouse & Keyboard Relay
 *  - Chunked P2P File Transfer with Real-Time Progress Bar
 *  - Live Ping/RTT (ms), FPS Counter, & Native Resolution Tracking
 */

(() => {
  'use strict';

  // =========================================================================
  // 1. WebRTC & Global Configuration
  // =========================================================================
  const RTC_CONFIG = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:stun3.l.google.com:19302' }
    ],
    iceCandidatePoolSize: 10
  };

  const CHUNK_SIZE = 64 * 1024; // 64KB per file chunk

  // =========================================================================
  // 2. Application State
  // =========================================================================
  const state = {
    // Signaling Mode: 'socketio' | 'peer' | 'detect'
    signalingMode: 'detect',
    socket: null,
    peer: null,
    activeConn: null, // PeerJS DataConnection (when in peer mode)
    activeCall: null, // PeerJS MediaConnection (when in peer mode)

    role: null, // 'host' | 'viewer' | null
    hostCode: null,
    targetCode: null,
    partnerSocketId: null,

    // WebRTC Direct Objects (Socket.io mode)
    peerConnection: null,
    localStream: null,
    inputChannel: null,   // Unordered, 0 retransmits for mouse
    controlChannel: null, // Reliable, ordered for clicks, keys, files, pings
    pendingCandidates: [],

    // Session Flags
    isSessionActive: false,
    inputControlEnabled: true,
    audioEnabled: true,
    isFullscreen: false,
    qualityMode: '60fps', // '60fps' | 'balanced' | 'sharp'

    // Metrics
    ping: 0,
    fps: 0,
    fpsFrameCount: 0,
    lastFpsTime: performance.now(),
    pingInterval: null,

    // File Transfers: transferId -> { name, size, type, receivedBytes, chunks, direction, progress }
    transfers: new Map(),

    // UI state
    topBarTimeout: null,
    isTopBarPinned: false
  };

  // =========================================================================
  // 3. Audio Chime Synthesizer (Zero-dependency Web Audio API)
  // =========================================================================
  const soundEffects = {
    ctx: null,
    init() {
      if (!this.ctx) {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (AudioCtx) this.ctx = new AudioCtx();
      }
    },
    playTone(freq, type, duration, gainVal = 0.1) {
      try {
        this.init();
        if (!this.ctx) return;
        if (this.ctx.state === 'suspended') this.ctx.resume();
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(freq, this.ctx.currentTime);
        gain.gain.setValueAtTime(gainVal, this.ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + duration);
        osc.connect(gain);
        gain.connect(this.ctx.destination);
        osc.start();
        osc.stop(this.ctx.currentTime + duration);
      } catch (e) {}
    },
    chimeConnect() {
      this.playTone(523.25, 'sine', 0.15, 0.1); // C5
      setTimeout(() => this.playTone(659.25, 'sine', 0.25, 0.1), 120); // E5
    },
    chimeAlert() {
      this.playTone(880, 'triangle', 0.12, 0.15); // A5
      setTimeout(() => this.playTone(880, 'triangle', 0.12, 0.15), 150);
    },
    chimeDisconnect() {
      this.playTone(440, 'sine', 0.15, 0.1);
      setTimeout(() => this.playTone(349.23, 'sine', 0.3, 0.1), 120);
    }
  };

  // =========================================================================
  // 4. DOM Elements
  // =========================================================================
  const el = {
    // Top Nav
    signalingStatus: document.getElementById('signalingStatus'),
    btnOpenHelp: document.getElementById('btnOpenHelp'),

    // Dashboard
    dashboardView: document.getElementById('dashboardView'),
    
    // Host Card
    myAccessCode: document.getElementById('myAccessCode'),
    btnCopyCode: document.getElementById('btnCopyCode'),
    btnRefreshCode: document.getElementById('btnRefreshCode'),
    btnShareLink: document.getElementById('btnShareLink'),
    toggleRequirePin: document.getElementById('toggleRequirePin'),
    pinInputWrapper: document.getElementById('pinInputWrapper'),
    hostPinInput: document.getElementById('hostPinInput'),
    togglePinVisibility: document.getElementById('togglePinVisibility'),
    permControl: document.getElementById('permControl'),
    permAudio: document.getElementById('permAudio'),
    permFileTransfer: document.getElementById('permFileTransfer'),
    permClipboard: document.getElementById('permClipboard'),
    permNativeOs: document.getElementById('permNativeOs'),
    hostStateBadge: document.getElementById('hostStateBadge'),
    hostScreenStatus: document.getElementById('hostScreenStatus'),
    btnPreselectScreen: document.getElementById('btnPreselectScreen'),

    // Client Card
    remoteCodeInput: document.getElementById('remoteCodeInput'),
    btnClearRemoteCode: document.getElementById('btnClearRemoteCode'),
    partnerPinInput: document.getElementById('partnerPinInput'),
    btnConnect: document.getElementById('btnConnect'),
    recentList: document.getElementById('recentList'),
    btnClearHistory: document.getElementById('btnClearHistory'),
    modeRadios: document.querySelectorAll('.mode-radio'),

    // Active Remote Session View
    remoteSessionView: document.getElementById('remoteSessionView'),
    videoContainer: document.getElementById('videoContainer'),
    remoteVideo: document.getElementById('remoteVideo'),
    pointerOverlay: document.getElementById('pointerOverlay'),
    sessionLoadingOverlay: document.getElementById('sessionLoadingOverlay'),
    sessionLoadingText: document.getElementById('sessionLoadingText'),
    mouseLockHint: document.getElementById('mouseLockHint'),
    
    // Floating Top Bar
    floatingTopBar: document.getElementById('floatingTopBar'),
    pingBadge: document.getElementById('pingBadge'),
    statPing: document.getElementById('statPing'),
    statFps: document.getElementById('statFps'),
    statResolution: document.getElementById('statResolution'),
    btnToggleInput: document.getElementById('btnToggleInput'),
    btnToggleFullscreen: document.getElementById('btnToggleFullscreen'),
    btnToggleAudio: document.getElementById('btnToggleAudio'),
    iconAudioOn: document.getElementById('iconAudioOn'),
    iconAudioOff: document.getElementById('iconAudioOff'),
    btnSpecialKeys: document.getElementById('btnSpecialKeys'),
    specialKeysMenu: document.getElementById('specialKeysMenu'),
    btnOpenFileTransfer: document.getElementById('btnOpenFileTransfer'),
    fileBadge: document.getElementById('fileBadge'),
    btnOpenClipboard: document.getElementById('btnOpenClipboard'),
    btnQuality: document.getElementById('btnQuality'),
    qualityText: document.getElementById('qualityText'),
    btnDisconnectSession: document.getElementById('btnDisconnectSession'),

    // Host Floating Active Widget
    hostFloatingWidget: document.getElementById('hostFloatingWidget'),
    hostViewerInfo: document.getElementById('hostViewerInfo'),
    btnHostPauseInput: document.getElementById('btnHostPauseInput'),
    hostInputLockText: document.getElementById('hostInputLockText'),
    btnHostEndStream: document.getElementById('btnHostEndStream'),

    // Modals
    modalIncomingRequest: document.getElementById('modalIncomingRequest'),
    incomingPartnerId: document.getElementById('incomingPartnerId'),
    incomingUserAgent: document.getElementById('incomingUserAgent'),
    incomingPermControl: document.getElementById('incomingPermControl'),
    incomingPermFiles: document.getElementById('incomingPermFiles'),
    countdownTimer: document.getElementById('countdownTimer'),
    countdownBar: document.getElementById('countdownBar'),
    btnRejectConnection: document.getElementById('btnRejectConnection'),
    btnAcceptConnection: document.getElementById('btnAcceptConnection'),

    // File Drawer
    drawerFileTransfer: document.getElementById('drawerFileTransfer'),
    btnCloseFiles: document.getElementById('btnCloseFiles'),
    fileDropZone: document.getElementById('fileDropZone'),
    fileInput: document.getElementById('fileInput'),
    btnBrowseFiles: document.getElementById('btnBrowseFiles'),
    fileTransferList: document.getElementById('fileTransferList'),
    transferCount: document.getElementById('transferCount'),

    // Clipboard Modal
    modalClipboard: document.getElementById('modalClipboard'),
    btnCloseClipboard: document.getElementById('btnCloseClipboard'),
    clipboardText: document.getElementById('clipboardText'),
    btnPasteFromLocal: document.getElementById('btnPasteFromLocal'),
    btnSendClipboardToRemote: document.getElementById('btnSendClipboardToRemote'),

    // Help Modal
    modalHelp: document.getElementById('modalHelp'),
    btnCloseHelp: document.getElementById('btnCloseHelp'),

    // Toasts
    toastContainer: document.getElementById('toastContainer')
  };

  // =========================================================================
  // 5. Utilities: Code Formatter, Toast Notifications & Storage
  // =========================================================================
  function generate9DigitCode() {
    return String(Math.floor(100000000 + Math.random() * 900000000));
  }

  function formatCode(raw) {
    if (!raw) return '--- --- ---';
    const clean = String(raw).replace(/\D/g, '').slice(0, 9);
    if (clean.length <= 3) return clean;
    if (clean.length <= 6) return `${clean.slice(0, 3)} ${clean.slice(3)}`;
    return `${clean.slice(0, 3)} ${clean.slice(3, 6)} ${clean.slice(6)}`;
  }

  function cleanCode(formatted) {
    if (!formatted) return '';
    return String(formatted).replace(/\D/g, '').slice(0, 9);
  }

  function showToast(title, message, type = 'info', duration = 4000) {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    
    let iconSvg = '';
    if (type === 'success') {
      iconSvg = '<svg class="w-5 h-5 text-emerald-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>';
    } else if (type === 'error') {
      iconSvg = '<svg class="w-5 h-5 text-red-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>';
    } else if (type === 'warning') {
      iconSvg = '<svg class="w-5 h-5 text-amber-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>';
    } else {
      iconSvg = '<svg class="w-5 h-5 text-cyan-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>';
    }

    toast.innerHTML = `
      <div>${iconSvg}</div>
      <div class="toast-content">
        <div class="toast-title">${title}</div>
        <div class="toast-msg">${message}</div>
      </div>
    `;

    el.toastContainer.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(50px)';
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }

  // Recent Sessions in LocalStorage
  function getRecentSessions() {
    try {
      const data = localStorage.getItem('omnicast_recents');
      return data ? JSON.parse(data) : [];
    } catch (e) {
      return [];
    }
  }

  function addRecentSession(code) {
    if (!code) return;
    const clean = cleanCode(code);
    if (clean.length !== 9) return;
    let recents = getRecentSessions().filter(r => r.code !== clean);
    recents.unshift({
      code: clean,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      date: new Date().toLocaleDateString()
    });
    recents = recents.slice(0, 5);
    try {
      localStorage.setItem('omnicast_recents', JSON.stringify(recents));
    } catch (e) {}
    renderRecentSessions();
  }

  function renderRecentSessions() {
    const recents = getRecentSessions();
    if (!recents.length) {
      el.recentList.innerHTML = '<div class="recent-empty">No recent connections</div>';
      return;
    }
    el.recentList.innerHTML = recents.map(r => `
      <div class="recent-item" data-code="${r.code}">
        <div class="flex items-center gap-2">
          <svg class="w-3.5 h-3.5 text-indigo-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="7" width="20" height="14" rx="2" ry="2"></rect><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"></path></svg>
          <span class="recent-code">${formatCode(r.code)}</span>
        </div>
        <span class="recent-meta">${r.time}</span>
      </div>
    `).join('');

    el.recentList.querySelectorAll('.recent-item').forEach(item => {
      item.addEventListener('click', () => {
        const code = item.getAttribute('data-code');
        el.remoteCodeInput.value = formatCode(code);
        el.btnClearRemoteCode.classList.remove('hidden');
        el.remoteCodeInput.focus();
      });
    });
  }

  // =========================================================================
  // 6. Accurate Normalized Coordinate Calculation (Letterbox-Aware)
  // =========================================================================
  function getNormalizedCoordinates(e, videoEl) {
    if (!videoEl || !videoEl.videoWidth || !videoEl.videoHeight) return null;
    const rect = videoEl.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;

    const nativeWidth = videoEl.videoWidth;
    const nativeHeight = videoEl.videoHeight;
    const videoRatio = nativeWidth / nativeHeight;
    const elementRatio = rect.width / rect.height;

    let renderedWidth = rect.width;
    let renderedHeight = rect.height;
    let offsetX = 0;
    let offsetY = 0;

    if (elementRatio > videoRatio) {
      // Pillarboxed
      renderedWidth = rect.height * videoRatio;
      offsetX = (rect.width - renderedWidth) / 2;
    } else {
      // Letterboxed
      renderedHeight = rect.width / videoRatio;
      offsetY = (rect.height - renderedHeight) / 2;
    }

    const relativeX = e.clientX - rect.left - offsetX;
    const relativeY = e.clientY - rect.top - offsetY;

    if (relativeX < 0 || relativeX > renderedWidth || relativeY < 0 || relativeY > renderedHeight) {
      return null;
    }

    return {
      xPercent: +(relativeX / renderedWidth).toFixed(5),
      yPercent: +(relativeY / renderedHeight).toFixed(5),
      x: Math.round((relativeX / renderedWidth) * nativeWidth),
      y: Math.round((relativeY / renderedHeight) * nativeHeight),
      nativeWidth,
      nativeHeight
    };
  }

  // =========================================================================
  // 7. Universal Signaling Engine (Hybrid Socket.io + PeerJS WebRTC Cloud)
  // =========================================================================
  function initSignaling() {
    let savedCode = localStorage.getItem('omnicast_host_code');
    if (!savedCode || savedCode.length !== 9) {
      savedCode = generate9DigitCode();
      localStorage.setItem('omnicast_host_code', savedCode);
    }
    state.hostCode = savedCode;
    el.myAccessCode.textContent = formatCode(savedCode);

    // If running on localhost or 127.0.0.1, try Socket.io first (for Windows OS native input bridge)
    const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

    if (isLocalhost && typeof io !== 'undefined') {
      trySocketIO();
    } else {
      // Running live on Vercel / Cloud: Activate PeerJS WebRTC Direct Cloud Mesh
      initPeerSignaling();
    }
  }

  function trySocketIO() {
    state.socket = io({
      transports: ['websocket', 'polling'],
      reconnectionAttempts: 2,
      timeout: 2500
    });

    let connected = false;

    state.socket.on('connect', () => {
      connected = true;
      state.signalingMode = 'socketio';
      console.log('[OmniCast] Connected via Local Socket.io server ID:', state.socket.id);
      el.signalingStatus.className = 'status-pill status-online';
      el.signalingStatus.innerHTML = '<span class="status-dot"></span><span>Node.js Online (Local)</span>';
      registerAsHost();
    });

    state.socket.on('connect_error', () => {
      if (!connected) {
        console.log('[OmniCast] Socket.io unavailable. Switching to WebRTC Cloud Mesh...');
        state.socket.disconnect();
        state.socket = null;
        initPeerSignaling();
      }
    });

    // Fallback timer if socket.io hangs
    setTimeout(() => {
      if (!connected && state.signalingMode === 'detect') {
        if (state.socket) {
          try { state.socket.disconnect(); } catch (e) {}
          state.socket = null;
        }
        initPeerSignaling();
      }
    }, 2500);

    // Socket.io handlers
    state.socket.on('incoming-connection-request', handleIncomingConnectionRequest);
    state.socket.on('connection-accepted', handleConnectionAcceptedSocket);
    state.socket.on('connection-rejected', handleConnectionRejected);
    state.socket.on('session-started', handleSessionStartedAsHostSocket);
    state.socket.on('webrtc-offer', handleWebRtcOffer);
    state.socket.on('webrtc-answer', handleWebRtcAnswer);
    state.socket.on('webrtc-ice-candidate', handleWebRtcIceCandidate);
    state.socket.on('session-terminated', handleSessionTerminated);
  }

  function initPeerSignaling() {
    state.signalingMode = 'peer';
    console.log('[OmniCast] Activating WebRTC Cloud Mesh Signaling for Code:', state.hostCode);
    
    el.signalingStatus.className = 'status-pill status-connecting';
    el.signalingStatus.innerHTML = '<span class="status-dot"></span><span>Connecting Cloud Mesh...</span>';

    if (state.peer) {
      try { state.peer.destroy(); } catch (e) {}
    }

    try {
      state.peer = new Peer('omnicast-' + state.hostCode, {
        config: RTC_CONFIG,
        debug: 1
      });

      state.peer.on('open', (id) => {
        console.log('[PeerJS Cloud Ready] Peer ID:', id);
        el.signalingStatus.className = 'status-pill status-online';
        el.signalingStatus.innerHTML = '<span class="status-dot"></span><span>WebRTC Cloud Online</span>';
        el.hostStateBadge.textContent = 'Ready';
        el.hostStateBadge.className = 'state-badge badge-ready';
      });

      state.peer.on('error', (err) => {
        console.warn('[PeerJS Error]', err);
        if (err.type === 'unavailable-id') {
          const newCode = generate9DigitCode();
          state.hostCode = newCode;
          localStorage.setItem('omnicast_host_code', newCode);
          el.myAccessCode.textContent = formatCode(newCode);
          initPeerSignaling();
        } else {
          el.signalingStatus.className = 'status-pill status-error';
          el.signalingStatus.innerHTML = '<span class="status-dot"></span><span>Mesh Error</span>';
        }
      });

      // Host receives incoming DataConnection from Viewer
      state.peer.on('connection', (conn) => {
        console.log('[PeerJS] Incoming connection from:', conn.peer);
        state.activeConn = conn;

        conn.on('data', (data) => {
          if (data && data.type === 'request-connection') {
            const requiredPin = el.toggleRequirePin.checked ? el.hostPinInput.value.trim() : null;
            if (requiredPin && requiredPin !== String(data.pin || '').trim()) {
              conn.send({ type: 'connection-rejected', reason: 'Invalid Security PIN.' });
              return;
            }

            handleIncomingConnectionRequest({
              viewerSocketId: conn.peer.replace('omnicast-', ''),
              clientInfo: data.clientInfo || { userAgent: 'Web Browser' }
            });
          } else if (data && data.type === 'ping') {
            conn.send({ type: 'pong', t: data.t });
          } else if (data && data.type === 'clipboard') {
            handleIncomingClipboard(data.text);
          } else if (data && data.type === 'file-meta') {
            handleIncomingFileMeta(data);
          } else if (data && data.type === 'file-end') {
            handleIncomingFileEnd(data);
          } else if (data && data.type === 'session-terminated') {
            handleSessionTerminated(data);
          } else {
            handleHostInputPayload(data);
          }
        });

        conn.on('close', () => {
          if (state.isSessionActive) {
            terminateSession('Remote partner disconnected.');
          }
        });
      });

      // Viewer receives Call from Host (MediaStream)
      state.peer.on('call', (call) => {
        console.log('[PeerJS] Receiving video stream call from Host:', call.peer);
        state.activeCall = call;
        call.answer();

        call.on('stream', (remoteStream) => {
          console.log('[PeerJS] Stream received on viewer!');
          el.remoteVideo.srcObject = remoteStream;
          el.sessionLoadingOverlay.classList.add('hidden');
          showToast('Connected', 'Live 60 FPS screen stream established!', 'success');
          startMetricsMonitoring();
        });

        call.on('close', () => {
          if (state.isSessionActive) {
            terminateSession('Host ended the remote session.');
          }
        });
      });
    } catch (err) {
      console.error('[PeerJS Init Error]', err);
    }
  }

  function registerAsHost() {
    if (state.signalingMode === 'socketio' && state.socket) {
      const pin = el.toggleRequirePin.checked ? el.hostPinInput.value.trim() : null;
      const permissions = {
        allowControl: el.permControl.checked,
        allowAudio: el.permAudio.checked,
        allowFileTransfer: el.permFileTransfer.checked,
        allowClipboard: el.permClipboard.checked,
        nativeOsControl: el.permNativeOs.checked
      };

      state.socket.emit('register-host', {
        code: state.hostCode,
        pin,
        permissions
      }, (res) => {
        if (res && res.success) {
          el.hostStateBadge.textContent = 'Ready';
          el.hostStateBadge.className = 'state-badge badge-ready';
        }
      });
    } else {
      el.hostStateBadge.textContent = 'Ready';
      el.hostStateBadge.className = 'state-badge badge-ready';
    }
  }

  // =========================================================================
  // 8. Host Connection Handling (Approval Modal & Screen Capture)
  // =========================================================================
  let incomingTimer = null;
  let incomingSecondsLeft = 30;

  function handleIncomingConnectionRequest({ viewerSocketId, clientInfo }) {
    soundEffects.chimeAlert();
    state.partnerSocketId = viewerSocketId;

    el.incomingPartnerId.textContent = viewerSocketId.slice(0, 8) + '...';
    el.incomingUserAgent.textContent = clientInfo.userAgent || 'Remote Web Client';

    el.modalIncomingRequest.classList.remove('hidden');

    incomingSecondsLeft = 30;
    el.countdownTimer.textContent = `${incomingSecondsLeft}s`;
    el.countdownBar.style.width = '100%';

    if (incomingTimer) clearInterval(incomingTimer);
    incomingTimer = setInterval(() => {
      incomingSecondsLeft--;
      el.countdownTimer.textContent = `${incomingSecondsLeft}s`;
      el.countdownBar.style.width = `${(incomingSecondsLeft / 30) * 100}%`;

      if (incomingSecondsLeft <= 0) {
        clearInterval(incomingTimer);
        rejectIncomingConnection('Request timed out (no response from host).');
      }
    }, 1000);
  }

  async function acceptIncomingConnection() {
    if (incomingTimer) clearInterval(incomingTimer);
    el.modalIncomingRequest.classList.add('hidden');

    const updatedPermissions = {
      allowControl: el.incomingPermControl.checked,
      allowFileTransfer: el.incomingPermFiles.checked,
      nativeOsControl: el.permNativeOs.checked
    };

    if (state.signalingMode === 'socketio' && state.socket) {
      state.socket.emit('respond-connection', {
        viewerSocketId: state.partnerSocketId,
        accepted: true,
        updatedPermissions
      });
    } else if (state.signalingMode === 'peer') {
      state.role = 'host';
      state.isSessionActive = true;

      el.hostStateBadge.textContent = 'In Session';
      el.hostStateBadge.className = 'state-badge badge-streaming';
      el.hostFloatingWidget.classList.remove('hidden');
      el.hostViewerInfo.textContent = `Partner: ${state.partnerSocketId.slice(0, 6)}`;

      showToast('Session Started', 'Capturing screen and broadcasting to partner...', 'info');

      try {
        if (!state.localStream) {
          state.localStream = await navigator.mediaDevices.getDisplayMedia({
            video: {
              cursor: 'always',
              frameRate: { ideal: 60, max: 60 }
            },
            audio: el.permAudio.checked ? {
              echoCancellation: false,
              noiseSuppression: false,
              autoGainControl: false
            } : false
          });

          state.localStream.getVideoTracks()[0].onended = () => {
            showToast('Sharing Ended', 'You stopped screen sharing.', 'warning');
            terminateSession('Host stopped screen sharing.');
          };
        }

        state.activeCall = state.peer.call('omnicast-' + state.partnerSocketId, state.localStream);

        if (state.activeConn) {
          state.activeConn.send({
            type: 'connection-accepted',
            permissions: updatedPermissions
          });
        }

        soundEffects.chimeConnect();
      } catch (err) {
        console.error('[Host Capture Error]', err);
        showToast('Capture Failed', err.message || 'Screen capture permission was denied.', 'error');
        terminateSession('Screen capture failed.');
      }
    }
  }

  function rejectIncomingConnection(reason = 'Host declined connection request.') {
    if (incomingTimer) clearInterval(incomingTimer);
    el.modalIncomingRequest.classList.add('hidden');

    if (state.signalingMode === 'socketio' && state.socket) {
      state.socket.emit('respond-connection', {
        viewerSocketId: state.partnerSocketId,
        accepted: false,
        reason
      });
    } else if (state.signalingMode === 'peer' && state.activeConn) {
      state.activeConn.send({
        type: 'connection-rejected',
        reason
      });
    }
    state.partnerSocketId = null;
  }

  async function handleSessionStartedAsHostSocket({ viewerSocketId, permissions }) {
    state.role = 'host';
    state.partnerSocketId = viewerSocketId;
    state.isSessionActive = true;

    el.hostStateBadge.textContent = 'In Session';
    el.hostStateBadge.className = 'state-badge badge-streaming';
    el.hostFloatingWidget.classList.remove('hidden');
    el.hostViewerInfo.textContent = `Partner: ${viewerSocketId.slice(0, 6)}`;

    showToast('Session Started', 'Capturing screen and broadcasting to partner...', 'info');

    try {
      if (!state.localStream) {
        state.localStream = await navigator.mediaDevices.getDisplayMedia({
          video: {
            cursor: 'always',
            frameRate: { ideal: 60, max: 60 }
          },
          audio: permissions.allowAudio ? {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false
          } : false
        });

        state.localStream.getVideoTracks()[0].onended = () => {
          showToast('Sharing Ended', 'You stopped screen sharing.', 'warning');
          terminateSession('Host stopped screen sharing.');
        };
      }

      initPeerConnection();

      state.localStream.getTracks().forEach(track => {
        state.peerConnection.addTrack(track, state.localStream);
      });

      state.peerConnection.ondatachannel = (event) => {
        const channel = event.channel;
        if (channel.label === 'input') {
          state.inputChannel = channel;
          setupInputChannelHost(channel);
        } else if (channel.label === 'control') {
          state.controlChannel = channel;
          setupControlChannelHost(channel);
        }
      };

      soundEffects.chimeConnect();
    } catch (err) {
      console.error('[Host Capture Error]', err);
      showToast('Capture Failed', err.message || 'Screen capture permission was denied.', 'error');
      terminateSession('Screen capture failed.');
    }
  }

  // =========================================================================
  // 9. Viewer Connection Flow
  // =========================================================================
  function connectToRemoteDesk() {
    const rawCode = el.remoteCodeInput.value;
    const targetCode = cleanCode(rawCode);

    if (targetCode.length !== 9) {
      showToast('Invalid Code', 'Please enter a valid 9-digit Access Code.', 'error');
      el.remoteCodeInput.focus();
      return;
    }

    if (targetCode === state.hostCode) {
      showToast('Invalid Target', 'Cannot connect to your own desk from the same browser.', 'warning');
      return;
    }

    el.btnConnect.disabled = true;
    el.btnConnect.querySelector('.btn-connect-text').textContent = 'Connecting to Remote Desk...';
    el.btnConnect.querySelector('.spinner').classList.remove('hidden');

    const pin = el.partnerPinInput.value.trim();
    state.targetCode = targetCode;

    if (state.signalingMode === 'socketio' && state.socket) {
      state.socket.emit('request-connection', {
        code: targetCode,
        pin,
        clientInfo: {
          userAgent: navigator.userAgent.includes('Chrome') ? 'Google Chrome' : 'Web Browser',
          screen: `${window.screen.width}x${window.screen.height}`
        }
      }, (res) => {
        if (!res.success) {
          showToast('Connection Failed', res.error, 'error');
          resetConnectButton();
        } else {
          showToast('Request Sent', 'Waiting for partner to accept your connection request...', 'info');
        }
      });
    } else {
      console.log('[PeerJS] Connecting to partner:', 'omnicast-' + targetCode);
      showToast('Connecting', 'Sending remote session request via WebRTC mesh...', 'info');

      try {
        const conn = state.peer.connect('omnicast-' + targetCode, { reliable: true });
        state.activeConn = conn;

        conn.on('open', () => {
          console.log('[PeerJS DataConnection Open] Sending request-connection...');
          conn.send({
            type: 'request-connection',
            pin,
            clientInfo: {
              userAgent: navigator.userAgent.includes('Chrome') ? 'Google Chrome' : 'Web Browser',
              screen: `${window.screen.width}x${window.screen.height}`
            }
          });
        });

        conn.on('data', (data) => {
          if (data && data.type === 'connection-accepted') {
            handleConnectionAcceptedPeer(data.permissions);
          } else if (data && data.type === 'connection-rejected') {
            handleConnectionRejected({ reason: data.reason });
          } else if (data && data.type === 'pong') {
            const rtt = Math.round(performance.now() - data.t);
            updatePingMetric(rtt);
          } else if (data && data.type === 'clipboard') {
            handleIncomingClipboard(data.text);
          } else if (data && data.type === 'file-meta') {
            handleIncomingFileMeta(data);
          } else if (data && data.type === 'file-end') {
            handleIncomingFileEnd(data);
          } else if (data && data.type === 'session-terminated') {
            handleSessionTerminated(data);
          }
        });

        conn.on('close', () => {
          if (state.isSessionActive) {
            terminateSession('Remote connection closed.');
          }
        });

        conn.on('error', (err) => {
          console.warn('[PeerJS Conn Error]', err);
          showToast('Connection Failed', 'Could not establish connection to remote desk.', 'error');
          resetConnectButton();
        });
      } catch (err) {
        showToast('Connection Error', err.message, 'error');
        resetConnectButton();
      }
    }
  }

  function handleConnectionRejected({ reason }) {
    resetConnectButton();
    soundEffects.chimeDisconnect();
    showToast('Request Declined', reason || 'The host declined your remote session request.', 'warning');
  }

  function handleConnectionAcceptedPeer(permissions) {
    soundEffects.chimeConnect();
    state.role = 'viewer';
    state.isSessionActive = true;

    addRecentSession(state.targetCode);

    el.dashboardView.classList.add('hidden');
    el.remoteSessionView.classList.remove('hidden');
    el.sessionLoadingOverlay.classList.remove('hidden');
    el.sessionLoadingText.textContent = 'Waiting for remote 60 FPS video stream...';

    state.controlChannel = state.activeConn;
  }

  async function handleConnectionAcceptedSocket({ hostSocketId, permissions }) {
    soundEffects.chimeConnect();
    state.role = 'viewer';
    state.partnerSocketId = hostSocketId;
    state.isSessionActive = true;

    addRecentSession(state.targetCode);

    el.dashboardView.classList.add('hidden');
    el.remoteSessionView.classList.remove('hidden');
    el.sessionLoadingOverlay.classList.remove('hidden');
    el.sessionLoadingText.textContent = 'Establishing ultra-low latency P2P WebRTC connection...';

    initPeerConnection();

    state.inputChannel = state.peerConnection.createDataChannel('input', {
      ordered: false,
      maxRetransmits: 0
    });

    state.controlChannel = state.peerConnection.createDataChannel('control', {
      ordered: true
    });

    setupControlChannelViewer(state.controlChannel);

    state.peerConnection.ontrack = (event) => {
      console.log('[Viewer] Remote media track received:', event.track.kind);
      if (event.streams && event.streams[0]) {
        el.remoteVideo.srcObject = event.streams[0];
        el.sessionLoadingOverlay.classList.add('hidden');
        showToast('Connected', 'Live 60 FPS screen stream established!', 'success');
        startMetricsMonitoring();
      }
    };

    try {
      const offer = await state.peerConnection.createOffer({
        offerToReceiveVideo: true,
        offerToReceiveAudio: true
      });
      await state.peerConnection.setLocalDescription(offer);

      state.socket.emit('webrtc-offer', {
        targetSocketId: state.partnerSocketId,
        offer: state.peerConnection.localDescription
      });
    } catch (err) {
      console.error('[WebRTC Offer Error]', err);
      showToast('Offer Failed', 'Failed to generate WebRTC handshake offer.', 'error');
      terminateSession('WebRTC handshake error.');
    }
  }

  function resetConnectButton() {
    el.btnConnect.disabled = false;
    el.btnConnect.querySelector('.btn-connect-text').textContent = 'Connect to Remote Desk';
    el.btnConnect.querySelector('.spinner').classList.add('hidden');
  }

  // =========================================================================
  // 10. WebRTC Handshake (Offer, Answer, ICE Candidates - Socket.io Mode)
  // =========================================================================
  function initPeerConnection() {
    if (state.peerConnection) {
      try { state.peerConnection.close(); } catch (e) {}
    }

    state.peerConnection = new RTCPeerConnection(RTC_CONFIG);
    state.pendingCandidates = [];

    state.peerConnection.onicecandidate = (event) => {
      if (event.candidate && state.partnerSocketId && state.socket) {
        state.socket.emit('webrtc-ice-candidate', {
          targetSocketId: state.partnerSocketId,
          candidate: event.candidate
        });
      }
    };

    state.peerConnection.onconnectionstatechange = () => {
      console.log('[WebRTC State]', state.peerConnection.connectionState);
      const s = state.peerConnection.connectionState;
      if (s === 'disconnected' || s === 'failed') {
        showToast('Connection Dropped', 'P2P WebRTC connection was lost.', 'warning');
        terminateSession('Connection lost.');
      }
    };
  }

  async function handleWebRtcOffer({ senderSocketId, offer }) {
    if (!state.peerConnection) initPeerConnection();

    try {
      await state.peerConnection.setRemoteDescription(new RTCSessionDescription(offer));

      while (state.pendingCandidates.length > 0) {
        const c = state.pendingCandidates.shift();
        await state.peerConnection.addIceCandidate(c);
      }

      const answer = await state.peerConnection.createAnswer();
      await state.peerConnection.setLocalDescription(answer);

      state.socket.emit('webrtc-answer', {
        targetSocketId: senderSocketId,
        answer: state.peerConnection.localDescription
      });
    } catch (err) {
      console.error('[Offer Handle Error]', err);
    }
  }

  async function handleWebRtcAnswer({ answer }) {
    if (!state.peerConnection) return;
    try {
      await state.peerConnection.setRemoteDescription(new RTCSessionDescription(answer));

      while (state.pendingCandidates.length > 0) {
        const c = state.pendingCandidates.shift();
        await state.peerConnection.addIceCandidate(c);
      }
    } catch (err) {
      console.error('[Answer Handle Error]', err);
    }
  }

  async function handleWebRtcIceCandidate({ candidate }) {
    if (!candidate) return;
    try {
      const iceCandidate = new RTCIceCandidate(candidate);
      if (state.peerConnection && state.peerConnection.remoteDescription) {
        await state.peerConnection.addIceCandidate(iceCandidate);
      } else {
        state.pendingCandidates.push(iceCandidate);
      }
    } catch (e) {
      console.warn('[ICE Candidate Error]', e);
    }
  }

  // =========================================================================
  // 11. Mouse & Keyboard Input Relay (Viewer -> Host)
  // =========================================================================
  let lastMoveRaf = null;

  function setupInputRelayViewer() {
    const video = el.remoteVideo;

    // Mouse Move
    video.addEventListener('mousemove', (e) => {
      if (!state.inputControlEnabled || !state.isSessionActive) return;
      if (lastMoveRaf) return;

      lastMoveRaf = requestAnimationFrame(() => {
        lastMoveRaf = null;
        const coords = getNormalizedCoordinates(e, video);
        if (!coords) return;

        sendInputData({
          type: 'mousemove',
          xPercent: coords.xPercent,
          yPercent: coords.yPercent,
          x: coords.x,
          y: coords.y
        }, true);
      });
    });

    // Mouse Down
    video.addEventListener('mousedown', (e) => {
      if (!state.inputControlEnabled || !state.isSessionActive) return;
      e.preventDefault();

      const coords = getNormalizedCoordinates(e, video);
      if (!coords) return;

      sendInputData({
        type: 'mousedown',
        button: e.button,
        xPercent: coords.xPercent,
        yPercent: coords.yPercent,
        x: coords.x,
        y: coords.y
      });
    });

    // Mouse Up
    video.addEventListener('mouseup', (e) => {
      if (!state.inputControlEnabled || !state.isSessionActive) return;
      e.preventDefault();

      const coords = getNormalizedCoordinates(e, video);
      if (!coords) return;

      sendInputData({
        type: 'mouseup',
        button: e.button,
        xPercent: coords.xPercent,
        yPercent: coords.yPercent,
        x: coords.x,
        y: coords.y
      });
    });

    // Context Menu Prevention
    video.addEventListener('contextmenu', (e) => {
      if (state.inputControlEnabled && state.isSessionActive) {
        e.preventDefault();
      }
    });

    // Mouse Wheel
    video.addEventListener('wheel', (e) => {
      if (!state.inputControlEnabled || !state.isSessionActive) return;
      e.preventDefault();

      sendInputData({
        type: 'wheel',
        deltaX: e.deltaX,
        deltaY: e.deltaY
      });
    }, { passive: false });

    // Keyboard Events
    window.addEventListener('keydown', (e) => {
      if (!state.isSessionActive || !state.inputControlEnabled) return;
      if (state.role !== 'viewer') return;

      const activeTag = document.activeElement ? document.activeElement.tagName : '';
      if (activeTag === 'INPUT' || activeTag === 'TEXTAREA') return;

      if (e.key === 'F11') return;

      e.preventDefault();
      sendInputData({
        type: 'keydown',
        key: e.key,
        code: e.code,
        keyCode: e.keyCode,
        ctrlKey: e.ctrlKey,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
        metaKey: e.metaKey
      });
    });

    window.addEventListener('keyup', (e) => {
      if (!state.isSessionActive || !state.inputControlEnabled) return;
      if (state.role !== 'viewer') return;

      const activeTag = document.activeElement ? document.activeElement.tagName : '';
      if (activeTag === 'INPUT' || activeTag === 'TEXTAREA') return;

      if (e.key === 'F11') return;

      e.preventDefault();
      sendInputData({
        type: 'keyup',
        key: e.key,
        code: e.code,
        keyCode: e.keyCode
      });
    });
  }

  function sendInputData(payload, useFastChannel = false) {
    if (state.signalingMode === 'peer' && state.activeConn) {
      try {
        state.activeConn.send(payload);
        return;
      } catch (e) {}
    }

    const channel = (useFastChannel && state.inputChannel && state.inputChannel.readyState === 'open')
      ? state.inputChannel
      : state.controlChannel;

    if (channel && channel.readyState === 'open') {
      try {
        channel.send(JSON.stringify(payload));
        return;
      } catch (e) {}
    }

    if (state.socket && state.socket.connected) {
      state.socket.emit('relay-input', payload);
    }
  }

  // =========================================================================
  // 12. Host DataChannel Dispatcher & Native OS Relay
  // =========================================================================
  function setupInputChannelHost(channel) {
    channel.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        handleHostInputPayload(payload);
      } catch (e) {}
    };
  }

  function setupControlChannelHost(channel) {
    channel.onmessage = (event) => {
      if (typeof event.data === 'string') {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'ping') {
            channel.send(JSON.stringify({ type: 'pong', t: msg.t }));
          } else if (msg.type === 'clipboard') {
            handleIncomingClipboard(msg.text);
          } else if (msg.type === 'file-meta') {
            handleIncomingFileMeta(msg);
          } else if (msg.type === 'file-end') {
            handleIncomingFileEnd(msg);
          } else {
            handleHostInputPayload(msg);
          }
        } catch (e) {}
      } else if (event.data instanceof ArrayBuffer) {
        handleIncomingFileChunk(event.data);
      }
    };
  }

  function handleHostInputPayload(payload) {
    if (!el.permControl.checked) return;

    if (el.permNativeOs.checked) {
      fetch('/api/host-input', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: payload })
      }).catch(() => {});
    }
  }

  // =========================================================================
  // 13. Viewer Control Channel Listener (Socket.io mode)
  // =========================================================================
  function setupControlChannelViewer(channel) {
    channel.onmessage = (event) => {
      if (typeof event.data === 'string') {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'pong') {
            const rtt = Math.round(performance.now() - msg.t);
            updatePingMetric(rtt);
          } else if (msg.type === 'clipboard') {
            handleIncomingClipboard(msg.text);
          } else if (msg.type === 'file-meta') {
            handleIncomingFileMeta(msg);
          } else if (msg.type === 'file-end') {
            handleIncomingFileEnd(msg);
          }
        } catch (e) {}
      } else if (event.data instanceof ArrayBuffer) {
        handleIncomingFileChunk(event.data);
      }
    };
  }

  // =========================================================================
  // 14. Performance & Metrics Monitoring (Ping, FPS, Native Resolution)
  // =========================================================================
  function startMetricsMonitoring() {
    if (state.pingInterval) clearInterval(state.pingInterval);
    state.pingInterval = setInterval(() => {
      if (state.signalingMode === 'peer' && state.activeConn) {
        state.activeConn.send({ type: 'ping', t: performance.now() });
      } else if (state.controlChannel && state.controlChannel.readyState === 'open') {
        state.controlChannel.send(JSON.stringify({
          type: 'ping',
          t: performance.now()
        }));
      }
    }, 1000);

    const video = el.remoteVideo;
    function checkFrame() {
      if (!state.isSessionActive) return;

      state.fpsFrameCount++;
      const now = performance.now();
      if (now - state.lastFpsTime >= 1000) {
        state.fps = Math.round((state.fpsFrameCount * 1000) / (now - state.lastFpsTime));
        el.statFps.textContent = state.fps;
        state.fpsFrameCount = 0;
        state.lastFpsTime = now;

        if (video.videoWidth && video.videoHeight) {
          el.statResolution.textContent = `${video.videoWidth}x${video.videoHeight}`;
        }
      }

      if ('requestVideoFrameCallback' in video) {
        video.requestVideoFrameCallback(checkFrame);
      } else {
        requestAnimationFrame(checkFrame);
      }
    }

    if ('requestVideoFrameCallback' in video) {
      video.requestVideoFrameCallback(checkFrame);
    } else {
      requestAnimationFrame(checkFrame);
    }
  }

  function updatePingMetric(rtt) {
    state.ping = rtt;
    el.statPing.textContent = `${rtt} ms`;

    el.pingBadge.classList.remove('latency-low', 'latency-med', 'latency-high');
    if (rtt < 45) {
      el.pingBadge.classList.add('latency-low');
    } else if (rtt < 100) {
      el.pingBadge.classList.add('latency-med');
    } else {
      el.pingBadge.classList.add('latency-high');
    }
  }

  // =========================================================================
  // 15. P2P File Transfer (Chunked RTCDataChannel Streaming)
  // =========================================================================
  let currentIncomingFile = null;

  function sendFile(file) {
    const isPeer = (state.signalingMode === 'peer' && state.activeConn);
    const isSocket = (state.controlChannel && state.controlChannel.readyState === 'open');

    if (!isPeer && !isSocket) {
      showToast('File Transfer Error', 'P2P DataChannel is not active in this session.', 'error');
      return;
    }

    const transferId = 'file_' + Date.now();
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    let chunkIndex = 0;

    const meta = {
      type: 'file-meta',
      id: transferId,
      name: file.name,
      size: file.size,
      mimeType: file.type || 'application/octet-stream'
    };

    if (isPeer) {
      state.activeConn.send(meta);
    } else {
      state.controlChannel.send(JSON.stringify(meta));
    }

    addTransferCard(transferId, file.name, file.size, 'sending');

    const reader = new FileReader();

    function readNextChunk() {
      const start = chunkIndex * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, file.size);
      const slice = file.slice(start, end);
      reader.readAsArrayBuffer(slice);
    }

    reader.onload = (e) => {
      const chunk = e.target.result;
      
      const bufferFull = isSocket 
        ? (state.controlChannel.bufferedAmount > 256 * 1024)
        : (state.activeConn.dataChannel && state.activeConn.dataChannel.bufferedAmount > 256 * 1024);

      if (bufferFull) {
        setTimeout(() => sendChunk(chunk), 50);
      } else {
        sendChunk(chunk);
      }
    };

    function sendChunk(chunk) {
      if (isPeer) {
        state.activeConn.send(chunk);
      } else {
        state.controlChannel.send(chunk);
      }
      chunkIndex++;

      const progress = Math.round((chunkIndex / totalChunks) * 100);
      updateTransferProgress(transferId, progress);

      if (chunkIndex < totalChunks) {
        readNextChunk();
      } else {
        const endMsg = { type: 'file-end', id: transferId };
        if (isPeer) {
          state.activeConn.send(endMsg);
        } else {
          state.controlChannel.send(JSON.stringify(endMsg));
        }
        updateTransferStatus(transferId, 'Sent Successfully', true);
        showToast('File Sent', `${file.name} sent successfully!`, 'success');
      }
    }

    readNextChunk();
  }

  function handleIncomingFileMeta(meta) {
    currentIncomingFile = {
      id: meta.id,
      name: meta.name,
      size: meta.size,
      mimeType: meta.mimeType,
      receivedBytes: 0,
      chunks: []
    };
    addTransferCard(meta.id, meta.name, meta.size, 'receiving');
    el.drawerFileTransfer.classList.remove('hidden');
    el.fileBadge.classList.remove('hidden');
    soundEffects.chimeAlert();
    showToast('Incoming File', `Receiving ${meta.name}...`, 'info');
  }

  function handleIncomingFileChunk(chunk) {
    if (!currentIncomingFile) return;
    currentIncomingFile.chunks.push(chunk);
    currentIncomingFile.receivedBytes += chunk.byteLength;

    const progress = Math.min(100, Math.round((currentIncomingFile.receivedBytes / currentIncomingFile.size) * 100));
    updateTransferProgress(currentIncomingFile.id, progress);
  }

  function handleIncomingFileEnd(msg) {
    if (!currentIncomingFile || currentIncomingFile.id !== msg.id) return;

    const blob = new Blob(currentIncomingFile.chunks, { type: currentIncomingFile.mimeType });
    const downloadUrl = URL.createObjectURL(blob);

    updateTransferStatus(currentIncomingFile.id, 'Received', true, downloadUrl, currentIncomingFile.name);
    soundEffects.chimeConnect();
    showToast('File Received', `${currentIncomingFile.name} ready for download!`, 'success');

    const a = document.createElement('a');
    a.href = downloadUrl;
    a.download = currentIncomingFile.name;
    document.body.appendChild(a);
    a.click();
    a.remove();

    currentIncomingFile = null;
  }

  function addTransferCard(id, name, size, type) {
    const list = el.fileTransferList;
    const emptyMsg = list.querySelector('.text-center');
    if (emptyMsg) emptyMsg.remove();

    const formattedSize = size > 1048576 
      ? `${(size / 1048576).toFixed(1)} MB` 
      : `${Math.round(size / 1024)} KB`;

    const card = document.createElement('div');
    card.id = `card_${id}`;
    card.className = 'file-transfer-card';
    card.innerHTML = `
      <div class="flex items-center justify-between text-xs">
        <span class="font-medium text-slate-200 truncate max-w-[200px]" title="${name}">${name}</span>
        <span class="text-slate-400 font-mono">${formattedSize}</span>
      </div>
      <div class="file-progress-bar">
        <div id="prog_${id}" class="file-progress-fill" style="width: 0%;"></div>
      </div>
      <div class="flex items-center justify-between text-[11px] text-slate-400 mt-1.5">
        <span id="status_${id}">${type === 'sending' ? 'Uploading...' : 'Downloading...'}</span>
        <span id="pct_${id}" class="font-mono text-cyan-400">0%</span>
      </div>
    `;

    list.prepend(card);
    const count = list.querySelectorAll('.file-transfer-card').length;
    el.transferCount.textContent = `${count} item${count > 1 ? 's' : ''}`;
  }

  function updateTransferProgress(id, pct) {
    const bar = document.getElementById(`prog_${id}`);
    const label = document.getElementById(`pct_${id}`);
    if (bar) bar.style.width = `${pct}%`;
    if (label) label.textContent = `${pct}%`;
  }

  function updateTransferStatus(id, text, isDone, downloadUrl = null, fileName = null) {
    const status = document.getElementById(`status_${id}`);
    if (status) {
      if (downloadUrl) {
        status.innerHTML = `<a href="${downloadUrl}" download="${fileName}" class="text-cyan-400 underline font-medium">Download File</a>`;
      } else {
        status.textContent = text;
        status.className = isDone ? 'text-emerald-400 font-semibold' : 'text-slate-400';
      }
    }
  }

  // =========================================================================
  // 16. Clipboard Synchronization
  // =========================================================================
  function handleIncomingClipboard(text) {
    el.clipboardText.value = text;
    showToast('Clipboard Synced', 'Received new clipboard text from remote desk.', 'info');
    soundEffects.chimeAlert();
    try {
      navigator.clipboard.writeText(text);
    } catch (e) {}
  }

  function sendClipboardText(text) {
    if (!text) return;
    const payload = { type: 'clipboard', text };

    if (state.signalingMode === 'peer' && state.activeConn) {
      state.activeConn.send(payload);
      showToast('Clipboard Sent', 'Copied text sent to remote computer.', 'success');
      el.modalClipboard.classList.add('hidden');
    } else if (state.controlChannel && state.controlChannel.readyState === 'open') {
      state.controlChannel.send(JSON.stringify(payload));
      showToast('Clipboard Sent', 'Copied text sent to remote computer.', 'success');
      el.modalClipboard.classList.add('hidden');
    } else {
      showToast('Error', 'Cannot send clipboard: session not connected.', 'error');
    }
  }

  // =========================================================================
  // 17. Session Termination & Cleanup
  // =========================================================================
  function terminateSession(reason = 'Session closed.') {
    state.isSessionActive = false;

    if (state.pingInterval) {
      clearInterval(state.pingInterval);
      state.pingInterval = null;
    }

    if (state.localStream) {
      state.localStream.getTracks().forEach(track => track.stop());
      state.localStream = null;
    }

    if (state.peerConnection) {
      try { state.peerConnection.close(); } catch (e) {}
      state.peerConnection = null;
    }

    if (state.activeCall) {
      try { state.activeCall.close(); } catch (e) {}
      state.activeCall = null;
    }

    state.inputChannel = null;
    state.controlChannel = null;

    if (el.remoteVideo.srcObject) {
      el.remoteVideo.srcObject = null;
    }

    if (document.fullscreenElement) {
      try { document.exitFullscreen(); } catch (e) {}
    }

    el.remoteSessionView.classList.add('hidden');
    el.hostFloatingWidget.classList.add('hidden');
    el.dashboardView.classList.remove('hidden');
    el.hostStateBadge.textContent = 'Ready';
    el.hostStateBadge.className = 'state-badge badge-ready';
    resetConnectButton();

    soundEffects.chimeDisconnect();
    showToast('Disconnected', reason, 'warning');
  }

  function handleSessionTerminated({ by, reason }) {
    terminateSession(reason || `${by === 'host' ? 'Host' : 'Viewer'} ended the session.`);
  }

  // =========================================================================
  // 18. UI Events & Controls Binding
  // =========================================================================
  function bindUIEvents() {
    // 1. Copy Access Code
    el.btnCopyCode.addEventListener('click', () => {
      const code = cleanCode(el.myAccessCode.textContent);
      navigator.clipboard.writeText(code).then(() => {
        showToast('Copied!', `Access Code ${formatCode(code)} copied to clipboard.`, 'success');
        el.btnCopyCode.classList.add('text-cyan-400');
        setTimeout(() => el.btnCopyCode.classList.remove('text-cyan-400'), 1500);
      });
    });

    // 2. Refresh Access Code
    el.btnRefreshCode.addEventListener('click', () => {
      const newCode = generate9DigitCode();
      localStorage.setItem('omnicast_host_code', newCode);
      state.hostCode = newCode;
      el.myAccessCode.textContent = formatCode(newCode);

      if (state.signalingMode === 'peer') {
        initPeerSignaling();
      } else {
        registerAsHost();
      }
      showToast('Code Regenerated', `New Access Code: ${formatCode(newCode)}`, 'info');
    });

    // 3. Share One-Click Link
    el.btnShareLink.addEventListener('click', () => {
      const clean = cleanCode(el.myAccessCode.textContent);
      const url = `${window.location.origin}${window.location.pathname}?connect=${clean}`;
      navigator.clipboard.writeText(url).then(() => {
        showToast('Link Copied', 'Direct connection URL copied to clipboard!', 'success');
      });
    });

    // 4. PIN Toggle
    el.toggleRequirePin.addEventListener('change', () => {
      if (el.toggleRequirePin.checked) {
        el.pinInputWrapper.classList.remove('hidden');
        el.hostPinInput.focus();
      } else {
        el.pinInputWrapper.classList.add('hidden');
        el.hostPinInput.value = '';
      }
      registerAsHost();
    });

    el.hostPinInput.addEventListener('input', () => {
      registerAsHost();
    });

    el.togglePinVisibility.addEventListener('click', () => {
      el.hostPinInput.type = el.hostPinInput.type === 'password' ? 'text' : 'password';
    });

    // 5. Test Screen Capture button
    el.btnPreselectScreen.addEventListener('click', async () => {
      try {
        const stream = await navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: 60 }
        });
        showToast('Capture Ready', 'Display capture verified successfully!', 'success');
        stream.getTracks().forEach(t => t.stop());
      } catch (err) {
        showToast('Capture Canceled', err.message, 'warning');
      }
    });

    // 6. Remote Code Input Auto-formatting
    el.remoteCodeInput.addEventListener('input', (e) => {
      const clean = cleanCode(e.target.value);
      e.target.value = formatCode(clean);
      if (clean.length > 0) {
        el.btnClearRemoteCode.classList.remove('hidden');
      } else {
        el.btnClearRemoteCode.classList.add('hidden');
      }
    });

    el.btnClearRemoteCode.addEventListener('click', () => {
      el.remoteCodeInput.value = '';
      el.btnClearRemoteCode.classList.add('hidden');
      el.remoteCodeInput.focus();
    });

    // 7. Mode Radios
    el.modeRadios.forEach(radio => {
      radio.addEventListener('click', () => {
        el.modeRadios.forEach(r => r.classList.remove('active'));
        radio.classList.add('active');
        state.inputControlEnabled = (radio.getAttribute('data-mode') === 'full');
      });
    });

    // 8. Connect Button
    el.btnConnect.addEventListener('click', connectToRemoteDesk);
    el.remoteCodeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') connectToRemoteDesk();
    });

    // 9. Clear History
    el.btnClearHistory.addEventListener('click', () => {
      localStorage.removeItem('omnicast_recents');
      renderRecentSessions();
      showToast('History Cleared', 'Recent sessions history emptied.', 'info');
    });

    // 10. Incoming Connection Modal Buttons
    el.btnAcceptConnection.addEventListener('click', acceptIncomingConnection);
    el.btnRejectConnection.addEventListener('click', () => rejectIncomingConnection('Host declined request.'));

    // 11. Host Active Floating Widget Buttons
    el.btnHostPauseInput.addEventListener('click', () => {
      el.permControl.checked = !el.permControl.checked;
      el.hostInputLockText.textContent = el.permControl.checked ? 'Lock Input' : 'Unlock Input';
      showToast('Host Input', el.permControl.checked ? 'Remote input enabled' : 'Remote input locked', 'info');
    });

    el.btnHostEndStream.addEventListener('click', () => {
      terminateSession('Host ended the remote session.');
      if (state.socket) {
        state.socket.emit('end-session', { reason: 'Host ended session.' });
      } else if (state.activeConn) {
        state.activeConn.send({ type: 'session-terminated', by: 'host', reason: 'Host ended session.' });
      }
    });

    // 12. Floating Top Bar Controls
    el.btnToggleInput.addEventListener('click', () => {
      state.inputControlEnabled = !state.inputControlEnabled;
      el.btnToggleInput.classList.toggle('active', state.inputControlEnabled);
      el.btnToggleInput.querySelector('span').textContent = state.inputControlEnabled ? 'Control On' : 'Control Off';
      showToast('Input Relay', state.inputControlEnabled ? 'Remote input enabled' : 'Remote input paused', 'info');
    });

    el.btnToggleFullscreen.addEventListener('click', () => {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(() => {});
      } else {
        document.exitFullscreen().catch(() => {});
      }
    });

    el.btnToggleAudio.addEventListener('click', () => {
      state.audioEnabled = !state.audioEnabled;
      el.remoteVideo.muted = !state.audioEnabled;
      el.iconAudioOn.classList.toggle('hidden', !state.audioEnabled);
      el.iconAudioOff.classList.toggle('hidden', state.audioEnabled);
    });

    // Special Keys Dropdown
    el.btnSpecialKeys.addEventListener('click', (e) => {
      e.stopPropagation();
      el.specialKeysMenu.classList.toggle('hidden');
    });

    document.addEventListener('click', () => {
      el.specialKeysMenu.classList.add('hidden');
    });

    el.specialKeysMenu.querySelectorAll('.dropdown-item').forEach(btn => {
      btn.addEventListener('click', () => {
        const key = btn.getAttribute('data-key');
        sendInputData({ type: 'special', key });
        showToast('Key Sent', `Sent ${key} to remote desk.`, 'info');
      });
    });

    // Quality Switcher
    el.btnQuality.addEventListener('click', () => {
      if (state.qualityMode === '60fps') {
        state.qualityMode = 'balanced';
        el.qualityText.textContent = 'Balanced';
      } else if (state.qualityMode === 'balanced') {
        state.qualityMode = 'sharp';
        el.qualityText.textContent = 'Sharp';
      } else {
        state.qualityMode = '60fps';
        el.qualityText.textContent = '60 FPS';
      }
      showToast('Stream Profile', `Preset changed to ${el.qualityText.textContent}`, 'info');
    });

    // File Drawer Trigger
    el.btnOpenFileTransfer.addEventListener('click', () => {
      el.drawerFileTransfer.classList.remove('hidden');
      el.fileBadge.classList.add('hidden');
    });
    el.btnCloseFiles.addEventListener('click', () => el.drawerFileTransfer.classList.add('hidden'));

    // Drag and Drop Files
    const dropZone = el.fileDropZone;
    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.classList.add('dragover');
    });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('dragover');
      if (e.dataTransfer.files.length) {
        Array.from(e.dataTransfer.files).forEach(f => sendFile(f));
      }
    });

    el.btnBrowseFiles.addEventListener('click', () => el.fileInput.click());
    el.fileInput.addEventListener('change', (e) => {
      if (e.target.files.length) {
        Array.from(e.target.files).forEach(f => sendFile(f));
      }
    });

    // Clipboard Modal
    el.btnOpenClipboard.addEventListener('click', () => el.modalClipboard.classList.remove('hidden'));
    el.btnCloseClipboard.addEventListener('click', () => el.modalClipboard.classList.add('hidden'));
    el.btnPasteFromLocal.addEventListener('click', async () => {
      try {
        const text = await navigator.clipboard.readText();
        el.clipboardText.value = text;
      } catch (e) {
        showToast('Clipboard Access', 'Browser clipboard permission required.', 'warning');
      }
    });
    el.btnSendClipboardToRemote.addEventListener('click', () => {
      sendClipboardText(el.clipboardText.value);
    });

    // Help Modal
    el.btnOpenHelp.addEventListener('click', () => el.modalHelp.classList.remove('hidden'));
    el.btnCloseHelp.addEventListener('click', () => el.modalHelp.classList.add('hidden'));

    // Viewer Disconnect Button
    el.btnDisconnectSession.addEventListener('click', () => {
      terminateSession('You disconnected from the remote desk.');
      if (state.socket) {
        state.socket.emit('end-session', { reason: 'Viewer disconnected.' });
      } else if (state.activeConn) {
        state.activeConn.send({ type: 'session-terminated', by: 'viewer', reason: 'Viewer disconnected.' });
      }
    });

    // Auto-hiding Floating Top Bar
    document.addEventListener('mousemove', (e) => {
      if (!state.isSessionActive || state.role !== 'viewer') return;

      if (e.clientY < 70) {
        el.floatingTopBar.classList.remove('collapsed');
        if (state.topBarTimeout) clearTimeout(state.topBarTimeout);
      } else {
        if (!state.topBarTimeout && !state.isTopBarPinned) {
          state.topBarTimeout = setTimeout(() => {
            el.floatingTopBar.classList.add('collapsed');
            state.topBarTimeout = null;
          }, 3500);
        }
      }
    });

    // Check URL parameters for direct one-click connect: ?connect=482910384
    const urlParams = new URLSearchParams(window.location.search);
    const connectParam = urlParams.get('connect');
    if (connectParam) {
      el.remoteCodeInput.value = formatCode(connectParam);
      el.btnClearRemoteCode.classList.remove('hidden');
      setTimeout(() => {
        showToast('OmniCast Link', `Loaded access code ${formatCode(connectParam)} from URL`, 'info');
      }, 500);
    }
  }

  // =========================================================================
  // 19. Application Initialization
  // =========================================================================
  function init() {
    renderRecentSessions();
    bindUIEvents();
    setupInputRelayViewer();
    initSignaling();
    console.log('[OmniCast Engine] Initialized successfully.');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
