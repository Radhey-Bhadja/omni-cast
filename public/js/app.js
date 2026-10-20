/**
 * OmniCast — Production WebRTC Remote Desktop Client
 * Powered by PeerJS with Google STUN Servers (Direct P2P, Zero Serverless Dependency)
 */

(() => {
  'use strict';

  // =========================================================================
  // 1. WebRTC & PeerJS Configuration
  // =========================================================================
  const PEER_CONFIG = {
    config: {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' }
      ]
    },
    debug: 1
  };

  const CHUNK_SIZE = 64 * 1024; // 64KB for high-speed P2P file slices

  // =========================================================================
  // 2. Global State
  // =========================================================================
  const state = {
    peer: null,
    myCode: null,
    targetCode: null,
    role: null, // 'host' | 'viewer' | null
    isSessionActive: false,

    // Active Connections
    activeConn: null, // DataConnection
    activeCall: null, // MediaConnection
    localStream: null, // Host Screen MediaStream

    // Features
    pointerEnabled: true,
    chatUnreadCount: 0,
    isChatOpen: false,

    // File Receiving Buffer
    incomingFile: null,

    // Ping Timer
    pingInterval: null,
    toolbarIdleTimer: null
  };

  // =========================================================================
  // 3. Audio Chimes (Web Audio API)
  // =========================================================================
  const audio = {
    ctx: null,
    init() {
      if (!this.ctx) {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (AudioCtx) this.ctx = new AudioCtx();
      }
    },
    beep(freq, duration, type = 'sine') {
      try {
        this.init();
        if (!this.ctx) return;
        if (this.ctx.state === 'suspended') this.ctx.resume();
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(freq, this.ctx.currentTime);
        gain.gain.setValueAtTime(0.08, this.ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + duration);
        osc.connect(gain);
        gain.connect(this.ctx.destination);
        osc.start();
        osc.stop(this.ctx.currentTime + duration);
      } catch (e) {}
    },
    alert() {
      this.beep(880, 0.12, 'triangle');
      setTimeout(() => this.beep(880, 0.12, 'triangle'), 140);
    },
    connected() {
      this.beep(523.25, 0.15, 'sine');
      setTimeout(() => this.beep(659.25, 0.25, 'sine'), 120);
    },
    disconnected() {
      this.beep(440, 0.12, 'sine');
      setTimeout(() => this.beep(330, 0.2, 'sine'), 100);
    }
  };

  // =========================================================================
  // 4. DOM Elements
  // =========================================================================
  const el = {
    // Header & Status
    meshStatus: document.getElementById('meshStatus'),
    meshStatusText: document.getElementById('meshStatusText'),

    // Dashboard
    dashboardView: document.getElementById('dashboardView'),
    myDeskCode: document.getElementById('myDeskCode'),
    btnCopyCode: document.getElementById('btnCopyCode'),
    copyText: document.getElementById('copyText'),
    btnRegenCode: document.getElementById('btnRegenCode'),
    partnerCodeInput: document.getElementById('partnerCodeInput'),
    connectForm: document.getElementById('connectForm'),
    btnConnect: document.getElementById('btnConnect'),

    // Session View
    sessionView: document.getElementById('sessionView'),
    videoStage: document.getElementById('videoStage'),
    remoteVideo: document.getElementById('remoteVideo'),
    laserCanvas: document.getElementById('laserCanvas'),
    sessionLoader: document.getElementById('sessionLoader'),
    sessionLoaderMsg: document.getElementById('sessionLoaderMsg'),
    floatingToolbar: document.getElementById('floatingToolbar'),
    remoteSessionId: document.getElementById('remoteSessionId'),
    pingValue: document.getElementById('pingValue'),

    // Toolbar Buttons
    btnTogglePointer: document.getElementById('btnTogglePointer'),
    btnToggleChat: document.getElementById('btnToggleChat'),
    chatBadge: document.getElementById('chatBadge'),
    btnSendFile: document.getElementById('btnSendFile'),
    hiddenFileInput: document.getElementById('hiddenFileInput'),
    btnFullscreen: document.getElementById('btnFullscreen'),
    btnDisconnect: document.getElementById('btnDisconnect'),

    // Host Floating Bar
    hostFloatingBar: document.getElementById('hostFloatingBar'),
    hostPartnerId: document.getElementById('hostPartnerId'),
    btnHostStopShare: document.getElementById('btnHostStopShare'),

    // Incoming Request Modal
    modalIncoming: document.getElementById('modalIncoming'),
    incomingCallerId: document.getElementById('incomingCallerId'),
    btnAcceptIncoming: document.getElementById('btnAcceptIncoming'),
    btnDeclineIncoming: document.getElementById('btnDeclineIncoming'),

    // Chat Drawer
    chatDrawer: document.getElementById('chatDrawer'),
    btnCloseChat: document.getElementById('btnCloseChat'),
    chatMessages: document.getElementById('chatMessages'),
    chatForm: document.getElementById('chatForm'),
    chatInput: document.getElementById('chatInput'),

    // File Toast
    fileToast: document.getElementById('fileToast'),
    fileToastTitle: document.getElementById('fileToastTitle'),
    fileToastName: document.getElementById('fileToastName'),
    fileProgressBar: document.getElementById('fileProgressBar'),
    fileProgressPct: document.getElementById('fileProgressPct'),
    fileStatusText: document.getElementById('fileStatusText'),
    btnCloseFileToast: document.getElementById('btnCloseFileToast'),

    // Toasts
    toastContainer: document.getElementById('toastContainer')
  };

  // =========================================================================
  // 5. Code Formatting & Helpers
  // =========================================================================
  function generate6DigitCode() {
    return String(Math.floor(100000 + Math.random() * 900000));
  }

  function format6DigitCode(raw) {
    if (!raw) return '--- - ---';
    const clean = String(raw).replace(/\D/g, '').slice(0, 6);
    if (clean.length <= 3) return clean;
    return `${clean.slice(0, 3)}-${clean.slice(3)}`;
  }

  function clean6DigitCode(formatted) {
    if (!formatted) return '';
    return String(formatted).replace(/\D/g, '').slice(0, 6);
  }

  function showToast(title, type = 'info', duration = 3500) {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = title;
    el.toastContainer.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(30px)';
      setTimeout(() => toast.remove(), 250);
    }, duration);
  }

  function updateStatus(status, text) {
    el.meshStatus.className = `status-indicator status-${status}`;
    el.meshStatusText.textContent = text;
  }

  // =========================================================================
  // 6. PeerJS Network Initialization
  // =========================================================================
  function initPeerNetwork() {
    let saved = localStorage.getItem('omnicast_desk_id');
    if (!saved || saved.length !== 6) {
      saved = generate6DigitCode();
      localStorage.setItem('omnicast_desk_id', saved);
    }
    state.myCode = saved;
    el.myDeskCode.textContent = format6DigitCode(saved);

    updateStatus('connecting', 'Connecting to Network...');

    if (state.peer) {
      try { state.peer.destroy(); } catch (e) {}
    }

    try {
      state.peer = new Peer('omnicast-' + state.myCode, PEER_CONFIG);

      // Connected to PeerJS Cloud Broker
      state.peer.on('open', (id) => {
        console.log('[OmniCast Ready] Peer ID:', id);
        updateStatus('online', 'Ready (Online)');
      });

      // Handle Errors
      state.peer.on('error', (err) => {
        console.warn('[PeerJS]', err);
        if (err.type === 'unavailable-id') {
          // If ID collision, roll a fresh 6-digit code
          const fresh = generate6DigitCode();
          state.myCode = fresh;
          localStorage.setItem('omnicast_desk_id', fresh);
          el.myDeskCode.textContent = format6DigitCode(fresh);
          initPeerNetwork();
        } else if (err.type === 'peer-unavailable') {
          showToast('Desk ID not found or offline', 'error');
          resetConnectBtn();
        } else {
          updateStatus('error', 'Network Issue');
        }
      });

      // HOST: Listen for incoming DataConnection from a remote partner
      state.peer.on('connection', (conn) => {
        console.log('[PeerJS] Incoming connection from:', conn.peer);
        state.activeConn = conn;
        setupDataConnectionListeners(conn);
      });

      // VIEWER: Listen for incoming MediaStream Call from Host
      state.peer.on('call', (call) => {
        console.log('[PeerJS] Incoming video call from Host:', call.peer);
        state.activeCall = call;
        call.answer(); // Viewer answers (receive-only)

        call.on('stream', (remoteStream) => {
          console.log('[PeerJS] Stream received on Viewer!');
          el.remoteVideo.srcObject = remoteStream;
          showSessionView();
          startPingLoop();
        });

        call.on('close', () => {
          if (state.isSessionActive) {
            endSession('Remote host stopped sharing.');
          }
        });
      });

    } catch (e) {
      console.error('[PeerJS Exception]', e);
      updateStatus('error', 'Initialization Failed');
    }
  }

  // =========================================================================
  // 7. DataConnection Message Dispatcher
  // =========================================================================
  function setupDataConnectionListeners(conn) {
    conn.on('data', (data) => {
      if (!data) return;

      // 1. Connection Request (Host receives from Viewer)
      if (data.type === 'request-connect') {
        const callerCode = data.fromCode || conn.peer.replace('omnicast-', '');
        handleIncomingConnection(callerCode);
      }
      
      // 2. Connection Accepted (Viewer receives from Host)
      else if (data.type === 'accepted') {
        audio.connected();
        state.role = 'viewer';
        state.isSessionActive = true;
        el.sessionLoaderMsg.textContent = 'Connecting video stream...';
        showToast('Connection accepted by host', 'success');
      }

      // 3. Connection Rejected (Viewer receives)
      else if (data.type === 'rejected') {
        audio.disconnected();
        showToast(data.reason || 'Connection declined by remote partner', 'warning');
        resetConnectBtn();
      }

      // 4. Remote Pointer Movement & Clicks
      else if (data.type === 'pointer') {
        renderRemotePointer(data.x, data.y, data.click);
      }

      // 5. Live Chat Message
      else if (data.type === 'chat') {
        appendChatMessage(data.text, 'theirs', data.time);
        if (!state.isChatOpen) {
          state.chatUnreadCount++;
          el.chatBadge.textContent = state.chatUnreadCount;
          el.chatBadge.classList.remove('hidden');
          audio.beep(750, 0.08);
        }
      }

      // 6. File Transfer Metadata
      else if (data.type === 'file-start') {
        handleFileStart(data);
      }

      // 7. File Chunk Binary Data
      else if (data.type === 'file-chunk') {
        handleFileChunk(data.chunk);
      }

      // 8. File Transfer Complete
      else if (data.type === 'file-end') {
        handleFileEnd();
      }

      // 9. Latency Ping / Pong
      else if (data.type === 'ping') {
        conn.send({ type: 'pong', t: data.t });
      } else if (data.type === 'pong') {
        const rtt = Math.round(performance.now() - data.t);
        el.pingValue.textContent = `${rtt} ms`;
      }

      // 10. Explicit Session Termination
      else if (data.type === 'disconnect') {
        endSession(data.reason || 'Partner ended the session.');
      }
    });

    conn.on('close', () => {
      if (state.isSessionActive) {
        endSession('Partner closed the connection.');
      }
    });
  }

  // =========================================================================
  // 8. Connection Handshake Flow
  // =========================================================================

  // VIEWER: Clicks "Connect Now"
  function handleConnectSubmit() {
    const raw = el.partnerCodeInput.value;
    const targetCode = clean6DigitCode(raw);

    if (targetCode.length !== 6) {
      showToast('Please enter a valid 6-digit code', 'warning');
      el.partnerCodeInput.focus();
      return;
    }

    if (targetCode === state.myCode) {
      showToast('Cannot connect to your own Desk ID', 'warning');
      return;
    }

    // Set UI to loading state
    el.btnConnect.disabled = true;
    el.btnConnect.querySelector('.btn-text').textContent = 'Connecting...';
    el.btnConnect.querySelector('.spinner').classList.remove('hidden');

    state.targetCode = targetCode;
    console.log('[Connecting] Target:', 'omnicast-' + targetCode);

    try {
      const conn = state.peer.connect('omnicast-' + targetCode, { reliable: true });
      state.activeConn = conn;
      setupDataConnectionListeners(conn);

      // Timeout for offline detection
      const offlineTimer = setTimeout(() => {
        if (!state.isSessionActive) {
          showToast('Remote Desk is offline or code is invalid', 'error');
          resetConnectBtn();
        }
      }, 15000);

      conn.on('open', () => {
        clearTimeout(offlineTimer);
        console.log('[DataConnection Open] Sending request-connect...');
        conn.send({
          type: 'request-connect',
          fromCode: state.myCode
        });

        // Switch to session loading view
        el.dashboardView.classList.add('hidden');
        el.sessionView.classList.remove('hidden');
        el.sessionLoader.classList.remove('hidden');
        el.sessionLoaderMsg.textContent = `Connecting to Desk ${format6DigitCode(targetCode)}... Waiting for approval.`;
        el.remoteSessionId.textContent = `Desk ${format6DigitCode(targetCode)}`;
      });

    } catch (err) {
      showToast('Connection failed: ' + err.message, 'error');
      resetConnectBtn();
    }
  }

  function resetConnectBtn() {
    el.btnConnect.disabled = false;
    el.btnConnect.querySelector('.btn-text').textContent = 'Connect Now';
    el.btnConnect.querySelector('.spinner').classList.add('hidden');
    el.sessionView.classList.add('hidden');
    el.dashboardView.classList.remove('hidden');
  }

  // HOST: Incoming Request Modal
  function handleIncomingConnection(callerCode) {
    audio.alert();
    el.incomingCallerId.textContent = format6DigitCode(callerCode);
    el.modalIncoming.classList.remove('hidden');
  }

  // HOST: Accepts Request & Triggers Screen Share
  async function handleAcceptConnection() {
    el.modalIncoming.classList.add('hidden');

    try {
      // Capture live screen with audio
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 60, max: 60 } },
        audio: true
      });
      state.localStream = stream;
      state.role = 'host';
      state.isSessionActive = true;

      // Handle when host clicks "Stop sharing" on native browser bar
      stream.getVideoTracks()[0].onended = () => {
        endSession('You stopped sharing your screen.');
      };

      // Call Viewer with the video stream
      if (state.activeConn) {
        state.activeCall = state.peer.call(state.activeConn.peer, stream);
        state.activeConn.send({ type: 'accepted' });
      }

      // Show Host floating widget
      el.hostFloatingBar.classList.remove('hidden');
      el.hostPartnerId.textContent = `Connected with Desk ${el.incomingCallerId.textContent}`;

      audio.connected();
      showToast('Sharing screen with remote partner', 'success');

    } catch (err) {
      console.warn('[Screen Share Cancelled]', err);
      if (state.activeConn) {
        state.activeConn.send({ type: 'rejected', reason: 'Host cancelled screen selection.' });
      }
      showToast('Screen share cancelled', 'warning');
    }
  }

  // HOST: Declines Request
  function handleDeclineConnection() {
    el.modalIncoming.classList.add('hidden');
    if (state.activeConn) {
      state.activeConn.send({ type: 'rejected', reason: 'Host declined connection request.' });
      try { state.activeConn.close(); } catch (e) {}
    }
    showToast('Declined connection request', 'info');
  }

  // =========================================================================
  // 9. Session Display & Pointer Relay
  // =========================================================================
  function showSessionView() {
    el.sessionLoader.classList.add('hidden');
    audio.connected();
    setupCanvas();
  }

  function setupCanvas() {
    const canvas = el.laserCanvas;
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    window.addEventListener('resize', () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    });
  }

  // Normalized coordinate calculation (letterbox/pillarbox safe)
  function getNormalizedCoords(e) {
    const video = el.remoteVideo;
    const rect = video.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;

    const nativeW = video.videoWidth || 1920;
    const nativeH = video.videoHeight || 1080;
    const videoRatio = nativeW / nativeH;
    const elemRatio = rect.width / rect.height;

    let rw = rect.width;
    let rh = rect.height;
    let ox = 0;
    let oy = 0;

    if (elemRatio > videoRatio) {
      rw = rect.height * videoRatio;
      ox = (rect.width - rw) / 2;
    } else {
      rh = rect.width / videoRatio;
      oy = (rect.height - rh) / 2;
    }

    const relX = e.clientX - rect.left - ox;
    const relY = e.clientY - rect.top - oy;

    if (relX < 0 || relX > rw || relY < 0 || relY > rh) return null;

    return {
      x: +(relX / rw).toFixed(4),
      y: +(relY / rh).toFixed(4)
    };
  }

  // Laser Pointer Renderer
  let rippleRadius = 0;
  let ripplePos = null;

  function renderRemotePointer(normX, normY, isClick) {
    const canvas = el.laserCanvas;
    const ctx = canvas.getContext('2d');
    const x = normX * canvas.width;
    const y = normY * canvas.height;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Glowing Laser Dot
    ctx.beginPath();
    ctx.arc(x, y, 6, 0, Math.PI * 2);
    ctx.fillStyle = '#ef4444';
    ctx.shadowColor = '#ef4444';
    ctx.shadowBlur = 12;
    ctx.fill();
    ctx.shadowBlur = 0;

    if (isClick) {
      ripplePos = { x, y };
      rippleRadius = 8;
      animateRipple();
    }
  }

  function animateRipple() {
    if (!ripplePos) return;
    const canvas = el.laserCanvas;
    const ctx = canvas.getContext('2d');

    ctx.beginPath();
    ctx.arc(ripplePos.x, ripplePos.y, rippleRadius, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(239, 68, 68, ${Math.max(0, 1 - rippleRadius / 35)})`;
    ctx.lineWidth = 2;
    ctx.stroke();

    rippleRadius += 2.5;
    if (rippleRadius < 35) {
      requestAnimationFrame(animateRipple);
    } else {
      ripplePos = null;
    }
  }

  // =========================================================================
  // 10. Live Chat & File Transfer
  // =========================================================================
  function appendChatMessage(text, side, timeStr) {
    const bubble = document.createElement('div');
    bubble.className = `chat-bubble ${side}`;
    bubble.innerHTML = `
      <span>${escapeHtml(text)}</span>
      <span class="chat-time">${timeStr || 'now'}</span>
    `;
    el.chatMessages.appendChild(bubble);
    el.chatMessages.scrollTop = el.chatMessages.scrollHeight;
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (m) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[m]);
  }

  function handleSendChat(e) {
    e.preventDefault();
    const text = el.chatInput.value.trim();
    if (!text || !state.activeConn) return;

    const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    // Send to partner
    state.activeConn.send({
      type: 'chat',
      text,
      time: timeStr
    });

    appendChatMessage(text, 'mine', timeStr);
    el.chatInput.value = '';
  }

  // P2P File Transfer (64KB Chunks)
  function sendFile(file) {
    if (!state.activeConn) {
      showToast('No active connection to send file', 'error');
      return;
    }

    el.fileToast.classList.remove('hidden');
    el.fileToastTitle.textContent = 'Sending File...';
    el.fileToastName.textContent = `${file.name} (${(file.size / 1024).toFixed(1)} KB)`;
    el.fileProgressBar.style.width = '0%';
    el.fileProgressPct.textContent = '0%';

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
      el.fileProgressBar.style.width = `${pct}%`;
      el.fileProgressPct.textContent = `${pct}%`;

      if (chunkIndex < totalChunks) {
        setTimeout(readNext, 10);
      } else {
        state.activeConn.send({ type: 'file-end' });
        el.fileToastTitle.textContent = 'File Sent Successfully!';
        showToast(`Sent ${file.name}`, 'success');
        setTimeout(() => el.fileToast.classList.add('hidden'), 2500);
      }
    };

    readNext();
  }

  function handleFileStart(meta) {
    state.incomingFile = {
      name: meta.name,
      size: meta.size,
      mime: meta.mime,
      chunks: [],
      received: 0
    };

    el.fileToast.classList.remove('hidden');
    el.fileToastTitle.textContent = 'Receiving File...';
    el.fileToastName.textContent = meta.name;
    el.fileProgressBar.style.width = '0%';
    el.fileProgressPct.textContent = '0%';
    audio.beep(600, 0.1);
  }

  function handleFileChunk(chunk) {
    if (!state.incomingFile) return;
    state.incomingFile.chunks.push(chunk);
    state.incomingFile.received += chunk.byteLength;

    const pct = Math.min(100, Math.round((state.incomingFile.received / state.incomingFile.size) * 100));
    el.fileProgressBar.style.width = `${pct}%`;
    el.fileProgressPct.textContent = `${pct}%`;
  }

  function handleFileEnd() {
    if (!state.incomingFile) return;
    const blob = new Blob(state.incomingFile.chunks, { type: state.incomingFile.mime });
    const url = URL.createObjectURL(blob);

    el.fileToastTitle.textContent = 'File Download Ready!';
    el.fileStatusText.innerHTML = `<a href="${url}" download="${state.incomingFile.name}" style="color: #3b82f6; text-decoration: underline;">Click to Download</a>`;
    showToast(`Received ${state.incomingFile.name}`, 'success');
    audio.connected();

    // Auto-trigger download
    const a = document.createElement('a');
    a.href = url;
    a.download = state.incomingFile.name;
    document.body.appendChild(a);
    a.click();
    a.remove();

    state.incomingFile = null;
  }

  // =========================================================================
  // 11. Ping Latency Monitor & Session Cleanup
  // =========================================================================
  function startPingLoop() {
    if (state.pingInterval) clearInterval(state.pingInterval);
    state.pingInterval = setInterval(() => {
      if (state.activeConn && state.activeConn.open) {
        state.activeConn.send({ type: 'ping', t: performance.now() });
      }
    }, 1500);
  }

  function endSession(reason = 'Session closed.') {
    state.isSessionActive = false;

    if (state.pingInterval) {
      clearInterval(state.pingInterval);
      state.pingInterval = null;
    }

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
        state.activeConn.send({ type: 'disconnect', reason });
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
    el.hostFloatingBar.classList.add('hidden');
    el.modalIncoming.classList.add('hidden');
    el.chatDrawer.classList.add('hidden');
    el.fileToast.classList.add('hidden');
    el.dashboardView.classList.remove('hidden');
    resetConnectBtn();

    audio.disconnected();
    showToast(reason, 'info');
  }

  // =========================================================================
  // 12. UI Event Listeners
  // =========================================================================
  function bindEvents() {
    // Copy Code
    el.btnCopyCode.addEventListener('click', () => {
      navigator.clipboard.writeText(state.myCode).then(() => {
        el.btnCopyCode.classList.add('copied');
        el.copyText.textContent = 'Copied!';
        showToast('6-digit code copied to clipboard', 'success');
        setTimeout(() => {
          el.btnCopyCode.classList.remove('copied');
          el.copyText.textContent = 'Copy Code';
        }, 2000);
      });
    });

    // Regenerate Code
    el.btnRegenCode.addEventListener('click', () => {
      const fresh = generate6DigitCode();
      state.myCode = fresh;
      localStorage.setItem('omnicast_desk_id', fresh);
      el.myDeskCode.textContent = format6DigitCode(fresh);
      initPeerNetwork();
      showToast('Generated new Desk ID', 'info');
    });

    // Partner Code Input Auto-formatting (XXX-XXX)
    el.partnerCodeInput.addEventListener('input', (e) => {
      const clean = clean6DigitCode(e.target.value);
      e.target.value = format6DigitCode(clean);
    });

    // Connect Form
    el.connectForm.addEventListener('submit', handleConnectSubmit);

    // Host Incoming Modal Actions
    el.btnAcceptIncoming.addEventListener('click', handleAcceptConnection);
    el.btnDeclineIncoming.addEventListener('click', handleDeclineConnection);
    el.btnHostStopShare.addEventListener('click', () => endSession('You stopped sharing.'));

    // Viewer Laser Pointer Interactions
    el.remoteVideo.addEventListener('mousemove', (e) => {
      if (!state.pointerEnabled || !state.isSessionActive || !state.activeConn) return;
      const coords = getNormalizedCoords(e);
      if (!coords) return;

      state.activeConn.send({
        type: 'pointer',
        x: coords.x,
        y: coords.y,
        click: false
      });
    });

    el.remoteVideo.addEventListener('click', (e) => {
      if (!state.pointerEnabled || !state.isSessionActive || !state.activeConn) return;
      const coords = getNormalizedCoords(e);
      if (!coords) return;

      state.activeConn.send({
        type: 'pointer',
        x: coords.x,
        y: coords.y,
        click: true
      });
    });

    // Pointer Button Toggle
    el.btnTogglePointer.addEventListener('click', () => {
      state.pointerEnabled = !state.pointerEnabled;
      el.btnTogglePointer.classList.toggle('active', state.pointerEnabled);
      showToast(state.pointerEnabled ? 'Remote pointer enabled' : 'Remote pointer disabled', 'info');
    });

    // Chat Drawer Toggle
    el.btnToggleChat.addEventListener('click', () => {
      state.isChatOpen = !state.isChatOpen;
      el.chatDrawer.classList.toggle('hidden', !state.isChatOpen);
      if (state.isChatOpen) {
        state.chatUnreadCount = 0;
        el.chatBadge.classList.add('hidden');
        el.chatInput.focus();
      }
    });

    el.btnCloseChat.addEventListener('click', () => {
      state.isChatOpen = false;
      el.chatDrawer.classList.add('hidden');
    });

    el.chatForm.addEventListener('submit', handleSendChat);

    // File Transfer
    el.btnSendFile.addEventListener('click', () => el.hiddenFileInput.click());
    el.hiddenFileInput.addEventListener('change', (e) => {
      if (e.target.files && e.target.files[0]) {
        sendFile(e.target.files[0]);
      }
    });

    el.btnCloseFileToast.addEventListener('click', () => el.fileToast.classList.add('hidden'));

    // Fullscreen Toggle
    el.btnFullscreen.addEventListener('click', () => {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(() => {});
      } else {
        document.exitFullscreen().catch(() => {});
      }
    });

    // Disconnect Button
    el.btnDisconnect.addEventListener('click', () => endSession('You ended the session.'));

    // Toolbar Auto-Hide when idle
    document.addEventListener('mousemove', (e) => {
      if (!state.isSessionActive) return;

      el.floatingToolbar.classList.remove('idle');
      if (state.toolbarIdleTimer) clearTimeout(state.toolbarIdleTimer);

      state.toolbarIdleTimer = setTimeout(() => {
        if (state.isSessionActive && !state.isChatOpen) {
          el.floatingToolbar.classList.add('idle');
        }
      }, 3500);
    });
  }

  // =========================================================================
  // 13. Application Startup
  // =========================================================================
  function init() {
    bindEvents();
    initPeerNetwork();
    console.log('[OmniCast Client] Initialized.');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
