/**
 * OmniCast — Ultra-Low Latency WebRTC Remote Desktop (AnyDesk Grade)
 * Full Mouse, Keyboard, Laser, Live WebRTC Stats, Shared Clipboard,
 * MediaRecorder Screen Recording, and Native Host OS Input Bridge.
 */

(() => {
  'use strict';

  // Global Public Google STUN servers + Metered TURN relays for symmetric NAT traversal
  const PEER_CONFIG = {
    config: {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:stun4.l.google.com:19302' },
        { urls: 'stun:global.stun.twilio.com:3478' },
        {
          urls: 'turn:openrelay.metered.ca:80',
          username: 'openrelayproject',
          credential: 'openrelayproject'
        },
        {
          urls: 'turn:openrelay.metered.ca:443',
          username: 'openrelayproject',
          credential: 'openrelayproject'
        },
        {
          urls: 'turn:openrelay.metered.ca:443?transport=tcp',
          username: 'openrelayproject',
          credential: 'openrelayproject'
        }
      ],
      iceCandidatePoolSize: 4
    },
    debug: 0
  };

  // DOM Helpers
  const $ = (id) => document.getElementById(id);
  const on = (el, evt, fn, opts) => {
    if (el) el.addEventListener(evt, fn, opts);
  };

  // =========================================================================
  // 9-Digit Session ID Generation & Formatting (e.g. 482 910 334)
  // =========================================================================
  function getOrGenerateCode() {
    let saved = '';
    try {
      saved = sessionStorage.getItem('omnicast_my_code');
    } catch (e) {}
    if (!saved || saved.length !== 9 || !/^\d{9}$/.test(saved)) {
      saved = String(Math.floor(100000000 + Math.random() * 900000000));
    }
    try {
      sessionStorage.setItem('omnicast_my_code', saved);
    } catch (e) {}
    return saved;
  }

  function formatDisplay(raw) {
    if (!raw) return '--- --- ---';
    const digits = String(raw).replace(/\D/g, '').slice(0, 9);
    if (digits.length <= 3) return digits;
    if (digits.length <= 6) return `${digits.slice(0, 3)} ${digits.slice(3)}`;
    return `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}`;
  }

  function cleanDigits(str) {
    return String(str || '').replace(/\D/g, '').slice(0, 9);
  }

  // =========================================================================
  // Application State
  // =========================================================================
  const state = {
    peer: null,
    myCode: getOrGenerateCode(),
    targetCode: null,
    isHost: false,
    activeConn: null,       // RTCDataConnection
    activeCall: null,       // MediaConnection
    localStream: null,      // Host Screen MediaStream
    remoteStream: null,     // Viewer Remote MediaStream
    mode: 'control',        // 'control' | 'laser'
    isMuted: true,
    isFitContain: true,
    hasServerApi: false,
    unreadMessages: 0,
    isDrawerOpen: false,
    isKeysPopoverOpen: false,
    
    // Authorization Modal Countdown
    authCountdownTimer: null,
    authSecondsRemaining: 30,
    pendingCallerCode: null,
    pendingClientInfo: null,
    pendingPermissions: null,

    // Permissions (File section removed per user specification)
    permissions: {
      allowAudio: true,
      allowPointer: true,
      allowClipboard: true,
      nativeOsControl: true
    },

    // WebRTC Stats Polling
    statsInterval: null,
    prevBytesReceived: 0,
    prevTimestamp: 0,

    // Screen Recording
    mediaRecorder: null,
    recordedChunks: [],
    isRecording: false,
    recordingTimer: null,
    recordingSeconds: 0,

    // Shared Clipboard
    sharedClipboardText: '',

    // Laser position
    laserX: -1,
    laserY: -1
  };

  // =========================================================================
  // Web Audio Sound Engine
  // =========================================================================
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

  // Toast Notification System
  function showToast(message, type = 'info') {
    const container = $('toastContainer');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(12px)';
      setTimeout(() => toast.remove(), 250);
    }, 3500);
  }

  // =========================================================================
  // Laser Pointer Engine
  // =========================================================================
  let laserCtx = null;
  let ripples = [];

  function initLaserCanvas() {
    const canvas = $('laserCanvas');
    if (!canvas) return;
    laserCtx = canvas.getContext('2d');
    resizeLaserCanvas();
    window.addEventListener('resize', resizeLaserCanvas);
    requestAnimationFrame(renderLaserLoop);
  }

  function resizeLaserCanvas() {
    const canvas = $('laserCanvas');
    const container = $('videoContainer');
    if (!canvas || !container) return;
    canvas.width = container.clientWidth;
    canvas.height = container.clientHeight;
  }

  function addClickRipple(x, y, color = '#ef4444') {
    ripples.push({ x, y, radius: 4, alpha: 0.9, color });
  }

  function renderLaserLoop() {
    if (laserCtx) {
      laserCtx.clearRect(0, 0, laserCtx.canvas.width, laserCtx.canvas.height);

      // Render expanding click ripples
      for (let i = ripples.length - 1; i >= 0; i--) {
        const r = ripples[i];
        laserCtx.beginPath();
        laserCtx.arc(r.x, r.y, r.radius, 0, Math.PI * 2);
        laserCtx.strokeStyle = r.color;
        laserCtx.lineWidth = 2.5;
        laserCtx.globalAlpha = r.alpha;
        laserCtx.stroke();
        laserCtx.globalAlpha = 1.0;

        r.radius += 2.2;
        r.alpha -= 0.04;
        if (r.alpha <= 0) ripples.splice(i, 1);
      }

      // Render laser dot when active in laser mode
      if (state.mode === 'laser' && state.laserX >= 0 && state.laserY >= 0) {
        const rad = 7;
        const grad = laserCtx.createRadialGradient(state.laserX, state.laserY, 1, state.laserX, state.laserY, rad * 2.5);
        grad.addColorStop(0, 'rgba(255, 255, 255, 1)');
        grad.addColorStop(0.3, 'rgba(239, 68, 68, 0.9)');
        grad.addColorStop(1, 'rgba(239, 68, 68, 0)');

        laserCtx.beginPath();
        laserCtx.arc(state.laserX, state.laserY, rad * 2.5, 0, Math.PI * 2);
        laserCtx.fillStyle = grad;
        laserCtx.fill();

        laserCtx.beginPath();
        laserCtx.arc(state.laserX, state.laserY, rad, 0, Math.PI * 2);
        laserCtx.fillStyle = '#ef4444';
        laserCtx.fill();
      }
    }
    requestAnimationFrame(renderLaserLoop);
  }

  // =========================================================================
  // Background Audio & Render KeepAlive (Prevents Tab Freezing on Host)
  // =========================================================================
  let backgroundAudioKeepAlive = null;
  function startBackgroundAudioKeepAlive() {
    try {
      if (backgroundAudioKeepAlive) return;
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.value = 0.0001; // Inaudible keepalive tone
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      backgroundAudioKeepAlive = { ctx, osc };
    } catch (e) {}
  }

  function stopBackgroundAudioKeepAlive() {
    try {
      if (backgroundAudioKeepAlive) {
        backgroundAudioKeepAlive.osc.stop();
        backgroundAudioKeepAlive.ctx.close();
        backgroundAudioKeepAlive = null;
      }
    } catch (e) {}
  }

  // =========================================================================
  // Recent Sessions Manager (localStorage)
  // =========================================================================
  function getRecentSessions() {
    try {
      const data = localStorage.getItem('omnicast_recent_sessions');
      return data ? JSON.parse(data) : [];
    } catch (e) {
      return [];
    }
  }

  function saveRecentSession(code) {
    if (!code) return;
    const clean = cleanDigits(code);
    if (clean.length !== 9) return;
    try {
      let recents = getRecentSessions().filter(item => item.id !== clean);
      recents.unshift({ id: clean, timestamp: Date.now() });
      if (recents.length > 8) recents = recents.slice(0, 8);
      localStorage.setItem('omnicast_recent_sessions', JSON.stringify(recents));
      renderRecentSessions();
    } catch (e) {}
  }

  function renderRecentSessions() {
    const listEl = $('recentSessionsList');
    if (!listEl) return;
    const recents = getRecentSessions();
    if (recents.length === 0) {
      listEl.innerHTML = `<div class="recent-empty">No recent connections yet. Past sessions will appear here for fast reconnect.</div>`;
      return;
    }

    listEl.innerHTML = recents.map(item => {
      const timeStr = getTimeAgo(item.timestamp);
      const formatted = formatDisplay(item.id);
      return `
        <div class="recent-card">
          <div class="recent-card-info">
            <div class="recent-icon-wrap">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line></svg>
            </div>
            <div>
              <div class="recent-id">${formatted}</div>
              <div class="recent-time">${timeStr}</div>
            </div>
          </div>
          <button class="btn-quick-connect" data-code="${item.id}" type="button">Connect</button>
        </div>
      `;
    }).join('');

    listEl.querySelectorAll('.btn-quick-connect').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const code = e.currentTarget.getAttribute('data-code');
        const input = $('targetCodeInput');
        if (input) {
          input.value = formatDisplay(code);
          const form = $('connectForm');
          if (form) form.dispatchEvent(new Event('submit', { cancelable: true }));
        }
      });
    });
  }

  function getTimeAgo(ts) {
    const diff = Math.floor((Date.now() - ts) / 1000);
    if (diff < 60) return 'Just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  }

  // =========================================================================
  // Bulletproof Remote Video Attachment & Autoplay Unlock
  // =========================================================================
  function attachRemoteStream(stream) {
    if (!stream) {
      console.warn('[OmniCast] attachRemoteStream received falsy stream');
      return;
    }

    console.log('[OmniCast] Attaching Remote Stream:', stream.id, 'Tracks:', stream.getTracks().map(t => `${t.kind}:${t.enabled}`).join(', '));
    state.remoteStream = stream;

    const video = $('remoteVideo');
    if (!video) return;

    if (video.srcObject !== stream) {
      video.srcObject = stream;
    }

    video.defaultMuted = true;
    video.muted = true; // Crucial for instant browser autoplay compliance
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.setAttribute('autoplay', '');

    const forcePlayVideo = () => {
      if (!video.srcObject) return;
      const playPromise = video.play();
      if (playPromise !== undefined) {
        playPromise.then(() => {
          console.log('[OmniCast Video Play Success] Resolution:', video.videoWidth, 'x', video.videoHeight);
          hideConnectingLoader();
          if (video.videoWidth > 0 && video.videoHeight > 0) {
            updateResolutionStat(video.videoWidth, video.videoHeight);
          }
        }).catch(err => {
          console.warn('[OmniCast Autoplay paused, waiting for gesture]', err.message);
          const unlock = () => {
            video.play().then(() => hideConnectingLoader()).catch(() => {});
            window.removeEventListener('click', unlock);
            window.removeEventListener('keydown', unlock);
            window.removeEventListener('touchstart', unlock);
          };
          window.addEventListener('click', unlock);
          window.addEventListener('keydown', unlock);
          window.addEventListener('touchstart', unlock);
        });
      }
    };

    video.onloadedmetadata = () => {
      console.log('[Video LoadedMetadata]', video.videoWidth, 'x', video.videoHeight);
      forcePlayVideo();
    };

    video.oncanplay = () => {
      forcePlayVideo();
    };

    stream.getVideoTracks().forEach(track => {
      track.enabled = true;
      track.onunmute = () => {
        console.log('[Remote Video Track Unmuted]');
        forcePlayVideo();
      };
      track.onmute = () => {
        console.warn('[Remote Video Track Muted]');
      };
    });

    stream.onaddtrack = (e) => {
      console.log('[Stream onaddtrack]', e.track.kind);
      if (e.track.kind === 'video') {
        e.track.enabled = true;
        e.track.onunmute = () => forcePlayVideo();
      }
      if (video.srcObject !== stream) video.srcObject = stream;
      forcePlayVideo();
    };

    // Immediate playback kick-off
    forcePlayVideo();

    hideConnectingLoader();
    sound.success();
    showToast('Connected! Live screen active.', 'success');
    startStatsPolling();
    if (state.targetCode) saveRecentSession(state.targetCode);
  }

  // =========================================================================
  // PeerJS WebRTC Initialization
  // =========================================================================
  function initPeer() {
    if (typeof Peer === 'undefined') {
      setTimeout(initPeer, 200);
      return;
    }

    try {
      if (state.peer) {
        try { state.peer.destroy(); } catch (e) {}
      }

      state.peer = new Peer('omni-' + state.myCode, PEER_CONFIG);

      state.peer.on('open', (id) => {
        console.log('[OmniCast Peer Open] ID:', id);
        updateStatusBadge('Network Ready', 'ready');
      });

      state.peer.on('error', (err) => {
        console.warn('[OmniCast Peer Error]', err.type, err.message);
        if (err.type === 'unavailable-id') {
          state.myCode = String(Math.floor(100000000 + Math.random() * 900000000));
          sessionStorage.setItem('omnicast_my_code', state.myCode);
          updateCodeDisplay();
          setTimeout(initPeer, 300);
        } else if (err.type === 'peer-unavailable') {
          hideConnectingLoader();
          showToast('Remote desk is offline or invalid ID.', 'error');
        } else {
          showToast(`Connection alert: ${err.type || 'network issue'}`, 'error');
        }
      });

      // INCOMING DATA CONNECTION (Host receives viewer request)
      state.peer.on('connection', (conn) => {
        console.log('[OmniCast Incoming DataConnection]', conn.peer);
        state.activeConn = conn;
        listenToDataChannel(conn);
      });

      // INCOMING MEDIA CALL (Viewer receives host screen stream)
      state.peer.on('call', (call) => {
        console.log('[OmniCast Incoming MediaCall from Host]', call.peer);
        state.activeCall = call;

        // 1. Answer immediately
        call.answer();

        // 2. Attach listener to stream event
        call.on('stream', (stream) => {
          console.log('[MediaConnection stream event received]', stream);
          attachRemoteStream(stream);
        });

        // 3. If stream is already populated on call object
        if (call.remoteStream) {
          attachRemoteStream(call.remoteStream);
        }

        // 4. Hook into underlying RTCPeerConnection ontrack event directly
        const hookPCTracks = () => {
          if (call.peerConnection && !call.peerConnection._tracksHooked) {
            call.peerConnection._tracksHooked = true;
            call.peerConnection.addEventListener('track', (event) => {
              console.log('[Direct RTCPeerConnection track event]', event.track.kind);
              const s = (event.streams && event.streams[0]) ? event.streams[0] : new MediaStream([event.track]);
              attachRemoteStream(s);
            });
          }
        };
        hookPCTracks();
        setTimeout(hookPCTracks, 50);
        setTimeout(hookPCTracks, 200);

        call.on('close', () => {
          stopAllSessions('Partner closed remote desktop.');
        });

        call.on('error', (err) => {
          console.error('[Call Error]', err);
          stopAllSessions('Stream connection error: ' + (err.message || err));
        });
      });

    } catch (e) {
      console.error('[PeerJS Init Error]', e);
    }
  }

  // =========================================================================
  // Data Channel Protocol Multiplexer
  // =========================================================================
  function listenToDataChannel(conn) {
    conn.on('open', () => {
      console.log('[OmniCast DataConnection Open]');
    });

    conn.on('data', (data) => {
      if (!data) return;

      // 1. Viewer requests permission to connect (Host receives this)
      if (data.type === 'ask-permission') {
        const callerCode = data.fromCode || conn.peer.replace('omni-', '');
        state.targetCode = callerCode;
        state.pendingCallerCode = callerCode;
        state.pendingClientInfo = data.clientInfo || { browser: 'WebRTC Browser', os: 'Desktop' };
        state.pendingPermissions = data.permissions || {};
        
        sound.ring();
        showIncomingAuthModal(callerCode, state.pendingClientInfo);
      }

      // 2. Host accepted connection request
      else if (data.type === 'accepted') {
        console.log('[OmniCast Request Accepted by Host]');
        if (data.permissions) {
          state.permissions = { ...state.permissions, ...data.permissions };
        }
        showToast('Host approved! Establishing live screen stream...', 'success');
      }

      // 3. Host declined connection request
      else if (data.type === 'permission-denied') {
        hideConnectingLoader();
        stopAllSessions(data.reason || 'Host declined the connection request.');
      }

      // 4. Remote Control: Mouse Move
      else if (data.type === 'mouse-move') {
        renderHostMirroredCursor(data.x, data.y);
        relayInputToHostBridge(data);
      }

      // 5. Remote Control: Mouse Down
      else if (data.type === 'mouse-down') {
        addClickRipple(data.x * window.innerWidth, data.y * window.innerHeight);
        relayInputToHostBridge(data);
      }

      // 6. Remote Control: Mouse Up / Click
      else if (data.type === 'mouse-up' || data.type === 'mouse-click') {
        relayInputToHostBridge(data);
      }

      // 7. Remote Control: Mouse Wheel
      else if (data.type === 'mouse-wheel') {
        relayInputToHostBridge(data);
      }

      // 8. Remote Control: Keyboard Key Down / Up
      else if (data.type === 'key-down') {
        showHostKeyHUD(data.key);
        relayInputToHostBridge(data);
      } else if (data.type === 'key-up') {
        relayInputToHostBridge(data);
      }

      // 9. Remote Control: Laser Pointer
      else if (data.type === 'laser') {
        renderHostMirroredCursor(data.x, data.y, true);
        addClickRipple(data.x * window.innerWidth, data.y * window.innerHeight, '#ef4444');
        relayInputToHostBridge(data);
      }

      // 10. Special Keys (Ctrl+Alt+Del, Windows Key, etc.)
      else if (data.type === 'special-key') {
        showHostKeyHUD(`Special: ${data.key}`);
        relayInputToHostBridge(data);
      }

      // 11. Text Input Snippet
      else if (data.type === 'text-input') {
        const scratchpad = $('hostScratchpadInput');
        if (scratchpad) {
          scratchpad.value += (scratchpad.value ? '\n' : '') + data.text;
          const pad = $('hostTestPad');
          if (pad) pad.classList.remove('hidden');
        }
        showToast(`Remote Text: "${data.text.slice(0, 30)}"`, 'info');
        relayInputToHostBridge(data);
      }

      // 12. Live Chat Message
      else if (data.type === 'chat') {
        appendChatMessage('Partner', data.text, data.timestamp || Date.now(), 'msg-peer');
        if (!state.isDrawerOpen) {
          state.unreadMessages++;
          updateDrawerBadge();
          sound.play(600, 0.1);
        }
      }

      // 13. Shared Clipboard Sync
      else if (data.type === 'clipboard-push') {
        handleClipboardPush(data.text);
      } else if (data.type === 'clipboard-pull-req') {
        handleClipboardPullRequest();
      } else if (data.type === 'clipboard-pull-resp') {
        handleClipboardPullResponse(data.text);
      }

      // 14. Session Disconnect Notice
      else if (data.type === 'session-end') {
        stopAllSessions(data.reason || 'Partner ended the session.');
      }
    });

    conn.on('close', () => {
      stopAllSessions('Data channel disconnected.');
    });

    conn.on('error', (err) => {
      console.warn('[DataConnection Error]', err);
    });
  }

  // =========================================================================
  // 30-Second Incoming Connection Authorization Modal
  // =========================================================================
  function showIncomingAuthModal(callerCode, clientInfo) {
    const modal = $('modalIncoming');
    if (!modal) return;

    $('incomingFriendCode').textContent = formatDisplay(callerCode);
    $('incomingClientInfo').textContent = clientInfo.browser || 'WebRTC Remote Desktop';

    modal.classList.remove('hidden');

    state.authSecondsRemaining = 30;
    updateAuthCountdownUI();

    if (state.authCountdownTimer) clearInterval(state.authCountdownTimer);
    state.authCountdownTimer = setInterval(() => {
      state.authSecondsRemaining--;
      updateAuthCountdownUI();

      if (state.authSecondsRemaining <= 0) {
        clearInterval(state.authCountdownTimer);
        state.authCountdownTimer = null;
        rejectIncomingConnection('Authorization timed out (30s)');
      }
    }, 1000);
  }

  function updateAuthCountdownUI() {
    const timerText = $('countdownTimerText');
    const barFill = $('countdownBarFill');
    if (timerText) timerText.textContent = `${state.authSecondsRemaining}s`;
    if (barFill) {
      const pct = (state.authSecondsRemaining / 30) * 100;
      barFill.style.width = `${pct}%`;
    }
  }

  function hideIncomingAuthModal() {
    if (state.authCountdownTimer) {
      clearInterval(state.authCountdownTimer);
      state.authCountdownTimer = null;
    }
    const modal = $('modalIncoming');
    if (modal) modal.classList.add('hidden');
  }

  function acceptIncomingConnection() {
    hideIncomingAuthModal();
    startHostScreenShare(state.pendingCallerCode);
  }

  function rejectIncomingConnection(reason = 'Host declined connection') {
    hideIncomingAuthModal();
    if (state.activeConn) {
      state.activeConn.send({ type: 'permission-denied', reason });
    }
    showToast('Declined incoming connection request.', 'info');
  }

  // =========================================================================
  // Host Screen Sharing Flow (getDisplayMedia)
  // =========================================================================
  async function startHostScreenShare(callerCode) {
    try {
      showToast('Select screen or window to share with partner...', 'info');

      // Standard screen capture options (prioritize monitor displaySurface)
      let stream;
      try {
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: {
            cursor: 'always',
            displaySurface: 'monitor',
            frameRate: { ideal: 60, max: 60 }
          },
          audio: state.permissions.allowAudio,
          selfBrowserSurface: 'exclude',
          surfaceSwitching: 'include'
        });
      } catch (e1) {
        if (e1.name === 'NotAllowedError' || e1.name === 'AbortError') {
          if (state.activeConn) {
            state.activeConn.send({ type: 'permission-denied', reason: 'Host cancelled screen selection.' });
          }
          return;
        }
        // Fallback without displaySurface or audio constraints
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: { cursor: 'always', frameRate: { ideal: 60, max: 60 } },
          audio: false
        });
      }

      state.localStream = stream;
      state.isHost = true;

      // Keep Host background tab active so Chrome doesn't throttle WebRTC encoder
      startBackgroundAudioKeepAlive();

      const vTrack = stream.getVideoTracks()[0];
      if (vTrack) {
        if ('contentHint' in vTrack) vTrack.contentHint = 'motion';
        vTrack.onended = () => {
          stopAllSessions('You stopped sharing your screen.');
        };
      }

      // Call Viewer with local screen stream
      if (state.activeConn) {
        state.activeCall = state.peer.call(state.activeConn.peer, stream);
        if (state.activeCall) {
          state.activeCall.on('error', (err) => {
            console.warn('[Host Call Error]', err);
          });
        }
        state.activeConn.send({
          type: 'accepted',
          permissions: state.permissions
        });
      }

      // Show Host Notice Floating Bar
      const notice = $('hostNotice');
      if (notice) notice.classList.remove('hidden');
      $('hostNoticeSub').textContent = `Partner: ${formatDisplay(callerCode)}`;

      sound.success();
      showToast('Screen sharing started! Partner can now view and control.', 'success');

    } catch (err) {
      console.error('[Screen Share Error]', err);
      if (state.activeConn) {
        state.activeConn.send({ type: 'permission-denied', reason: 'Screen share failed: ' + err.message });
      }
      showToast('Failed to start screen share: ' + err.message, 'error');
    }
  }

  // =========================================================================
  // Viewer Request Connection Flow
  // =========================================================================
  function requestConnectionToRemote(rawTargetCode) {
    const clean = cleanDigits(rawTargetCode);
    if (!clean || clean.length !== 9) {
      showToast('Please enter a valid 9-digit address (e.g. 482 910 334)', 'error');
      return;
    }

    if (clean === state.myCode) {
      showToast('Cannot connect to your own desk from the same browser tab.', 'error');
      return;
    }

    state.targetCode = clean;
    state.isHost = false;

    showConnectingLoader();

    try {
      const conn = state.peer.connect('omni-' + clean, {
        reliable: true,
        serialization: 'json'
      });

      state.activeConn = conn;

      conn.on('open', () => {
        console.log('[Viewer Connected to Host DataChannel]');
        conn.send({
          type: 'ask-permission',
          fromCode: state.myCode,
          clientInfo: {
            browser: navigator.userAgent.includes('Chrome') ? 'Google Chrome' : navigator.userAgent.includes('Firefox') ? 'Mozilla Firefox' : 'Web Browser',
            platform: navigator.platform || 'Desktop'
          },
          permissions: state.permissions
        });
      });

      listenToDataChannel(conn);

    } catch (e) {
      hideConnectingLoader();
      showToast('Connection failed to start: ' + e.message, 'error');
    }
  }

  function showConnectingLoader() {
    const sessionView = $('sessionView');
    const mainView = $('mainView');
    const loader = $('loaderOverlay');

    if (sessionView) sessionView.classList.remove('hidden');
    if (mainView) mainView.classList.add('hidden');
    if (loader) loader.classList.remove('hidden');

    $('loaderTitle').textContent = 'Connecting to partner...';
    $('loaderSubtitle').textContent = 'Waiting for remote host approval and WebRTC media handshake (30s)';
  }

  function hideConnectingLoader() {
    const loader = $('loaderOverlay');
    if (loader) loader.classList.add('hidden');
  }

  // =========================================================================
  // Teardown & Stop All Sessions
  // =========================================================================
  function stopAllSessions(reason) {
    stopStatsPolling();
    stopRecording();
    stopBackgroundAudioKeepAlive();

    if (state.activeConn) {
      try {
        state.activeConn.send({ type: 'session-end', reason: reason || 'Session disconnected' });
      } catch (e) {}
      try { state.activeConn.close(); } catch (e) {}
      state.activeConn = null;
    }

    if (state.activeCall) {
      try { state.activeCall.close(); } catch (e) {}
      state.activeCall = null;
    }

    if (state.localStream) {
      state.localStream.getTracks().forEach(t => t.stop());
      state.localStream = null;
    }

    if (state.remoteStream) {
      state.remoteStream.getTracks().forEach(t => t.stop());
      state.remoteStream = null;
    }

    const video = $('remoteVideo');
    if (video) video.srcObject = null;

    const sessionView = $('sessionView');
    const mainView = $('mainView');
    const hostNotice = $('hostNotice');

    if (sessionView) sessionView.classList.add('hidden');
    if (mainView) mainView.classList.remove('hidden');
    if (hostNotice) hostNotice.classList.add('hidden');

    const cursor = $('hostRemoteCursor');
    if (cursor) cursor.classList.add('hidden');

    state.isHost = false;
    sound.end();

    if (reason) showToast(reason, 'info');
  }

  // =========================================================================
  // WebRTC Stats Poller (RTT, FPS, Bitrate, Resolution)
  // =========================================================================
  function startStatsPolling() {
    stopStatsPolling();
    state.prevBytesReceived = 0;
    state.prevTimestamp = performance.now();

    state.statsInterval = setInterval(async () => {
      if (!state.activeCall || !state.activeCall.peerConnection) return;
      const pc = state.activeCall.peerConnection;

      try {
        const stats = await pc.getStats();
        let rtt = null;
        let fps = null;
        let bitrate = null;
        let resWidth = null;
        let resHeight = null;

        stats.forEach(report => {
          if (report.type === 'candidate-pair' && report.state === 'succeeded') {
            if (report.currentRoundTripTime !== undefined) {
              rtt = Math.round(report.currentRoundTripTime * 1000);
            }
          }
          if (report.type === 'inbound-rtp' && report.kind === 'video') {
            if (report.framesPerSecond !== undefined) {
              fps = Math.round(report.framesPerSecond);
            }
            if (report.frameWidth && report.frameHeight) {
              resWidth = report.frameWidth;
              resHeight = report.frameHeight;
            }
            if (report.bytesReceived !== undefined) {
              const now = performance.now();
              const dt = (now - state.prevTimestamp) / 1000;
              if (dt > 0.5 && state.prevBytesReceived > 0) {
                const bps = ((report.bytesReceived - state.prevBytesReceived) * 8) / dt;
                if (bps > 1000000) {
                  bitrate = (bps / 1000000).toFixed(1) + ' Mbps';
                } else {
                  bitrate = Math.round(bps / 1000) + ' kbps';
                }
              }
              state.prevBytesReceived = report.bytesReceived;
              state.prevTimestamp = now;
            }
          }
        });

        if (rtt !== null && $('statRtt')) $('statRtt').textContent = rtt;
        if (fps !== null && $('statFps')) $('statFps').textContent = fps;
        if (bitrate !== null && $('statBitrate')) $('statBitrate').textContent = bitrate;
        if (resWidth && resHeight) updateResolutionStat(resWidth, resHeight);

      } catch (e) {
        console.warn('[Stats Polling Error]', e);
      }
    }, 1000);
  }

  function stopStatsPolling() {
    if (state.statsInterval) {
      clearInterval(state.statsInterval);
      state.statsInterval = null;
    }
  }

  function updateResolutionStat(w, h) {
    const resEl = $('statRes');
    if (!resEl) return;
    if (h >= 1080) resEl.textContent = '1080p';
    else if (h >= 720) resEl.textContent = '720p';
    else if (h >= 480) resEl.textContent = '480p';
    else resEl.textContent = `${w}x${h}`;
  }

  // =========================================================================
  // Local Screen Recorder (MediaRecorder -> .webm)
  // =========================================================================
  function toggleScreenRecording() {
    if (state.isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  }

  function startRecording() {
    if (!state.remoteStream) {
      showToast('No active remote video stream to record.', 'error');
      return;
    }

    try {
      state.recordedChunks = [];
      const options = { mimeType: 'video/webm;codecs=vp9,opus' };
      if (!MediaRecorder.isTypeSupported(options.mimeType)) {
        options.mimeType = 'video/webm;codecs=vp8,opus';
        if (!MediaRecorder.isTypeSupported(options.mimeType)) {
          options.mimeType = 'video/webm';
        }
      }

      state.mediaRecorder = new MediaRecorder(state.remoteStream, options);

      state.mediaRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          state.recordedChunks.push(event.data);
        }
      };

      state.mediaRecorder.onstop = () => {
        const blob = new Blob(state.recordedChunks, { type: 'video/webm' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = url;
        a.download = `OmniCast-Recording-${new Date().toISOString().replace(/[:.]/g, '-')}.webm`;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        }, 100);

        sound.success();
        showToast('Screen recording saved & downloaded as .webm!', 'success');
      };

      state.mediaRecorder.start(1000);
      state.isRecording = true;
      state.recordingSeconds = 0;

      const btn = $('btnRecordScreen');
      const label = $('recordBtnLabel');
      if (btn) btn.classList.add('recording');
      if (label) label.textContent = 'REC 00:00';

      state.recordingTimer = setInterval(() => {
        state.recordingSeconds++;
        const mins = String(Math.floor(state.recordingSeconds / 60)).padStart(2, '0');
        const secs = String(state.recordingSeconds % 60).padStart(2, '0');
        if (label) label.textContent = `REC ${mins}:${secs}`;
      }, 1000);

      showToast('Recording started. Click again to stop and download.', 'info');

    } catch (e) {
      console.error('[MediaRecorder Error]', e);
      showToast('Recording failed: ' + e.message, 'error');
    }
  }

  function stopRecording() {
    if (!state.isRecording) return;
    if (state.recordingTimer) {
      clearInterval(state.recordingTimer);
      state.recordingTimer = null;
    }
    state.isRecording = false;

    const btn = $('btnRecordScreen');
    const label = $('recordBtnLabel');
    if (btn) btn.classList.remove('recording');
    if (label) label.textContent = 'Record';

    if (state.mediaRecorder && state.mediaRecorder.state !== 'inactive') {
      state.mediaRecorder.stop();
    }
  }

  // =========================================================================
  // Shared Clipboard Synchronization
  // =========================================================================
  function handleClipboardPush(text) {
    state.sharedClipboardText = text;
    const area = $('sharedClipboardText');
    if (area) area.value = text;

    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text);
      }
    } catch (e) {}

    showToast('Remote clipboard pushed to your clipboard!', 'info');
  }

  function handleClipboardPullRequest() {
    const area = $('sharedClipboardText');
    const text = area ? area.value : state.sharedClipboardText;
    if (state.activeConn) {
      state.activeConn.send({ type: 'clipboard-pull-resp', text });
    }
  }

  function handleClipboardPullResponse(text) {
    state.sharedClipboardText = text;
    const area = $('sharedClipboardText');
    if (area) area.value = text;

    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text);
      }
    } catch (e) {}

    showToast('Remote clipboard pulled successfully!', 'success');
  }

  // =========================================================================
  // Live Chat Messaging
  // =========================================================================
  function sendChatMessage(text) {
    if (!text || !text.trim() || !state.activeConn) return;
    const cleanText = text.trim();
    const timestamp = Date.now();

    appendChatMessage('You', cleanText, timestamp, 'msg-self');

    state.activeConn.send({
      type: 'chat',
      text: cleanText,
      timestamp
    });
  }

  function appendChatMessage(sender, text, timestamp, className) {
    const wrap = $('chatMessages');
    if (!wrap) return;

    const timeStr = new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const div = document.createElement('div');
    div.className = `chat-msg ${className}`;
    div.innerHTML = `
      <div class="chat-meta">
        <span>${sender}</span>
        <span>•</span>
        <span>${timeStr}</span>
      </div>
      <div class="chat-bubble">${escapeHtml(text)}</div>
    `;
    wrap.appendChild(div);
    wrap.scrollTop = wrap.scrollHeight;
  }

  function escapeHtml(str) {
    return str.replace(/[&<>'"]/g, tag => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    }[tag] || tag));
  }

  function updateDrawerBadge() {
    const badge = $('drawerBadge');
    if (!badge) return;
    if (state.unreadMessages > 0) {
      badge.textContent = state.unreadMessages;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }

  // =========================================================================
  // Remote Control Handlers (Viewer to Host)
  // =========================================================================
  function bindViewerInputEvents() {
    const container = $('videoContainer');
    const video = $('remoteVideo');
    if (!container || !video) return;

    function getRelativeCoordinates(e) {
      const rect = video.getBoundingClientRect();
      const clientX = e.clientX;
      const clientY = e.clientY;
      const x = Math.max(0, Math.min(rect.width, clientX - rect.left));
      const y = Math.max(0, Math.min(rect.height, clientY - rect.top));
      return {
        pctX: +(x / rect.width).toFixed(4),
        pctY: +(y / rect.height).toFixed(4),
        rawX: clientX - rect.left,
        rawY: clientY - rect.top
      };
    }

    let lastMoveTime = 0;
    container.addEventListener('mousemove', (e) => {
      const coords = getRelativeCoordinates(e);

      if (state.mode === 'laser') {
        state.laserX = e.clientX;
        state.laserY = e.clientY;
      } else {
        state.laserX = -1;
        state.laserY = -1;
      }

      if (!state.activeConn) return;
      const now = performance.now();
      if (now - lastMoveTime < 16) return;
      lastMoveTime = now;

      if (state.mode === 'laser') {
        state.activeConn.send({
          type: 'laser',
          x: coords.pctX,
          y: coords.pctY
        });
      } else {
        state.activeConn.send({
          type: 'mouse-move',
          x: coords.pctX,
          y: coords.pctY
        });
      }
    });

    container.addEventListener('mousedown', (e) => {
      // Ensure video is playing on gesture
      if (video && video.paused) {
        video.play().catch(() => {});
      }

      if (!state.activeConn) return;
      const coords = getRelativeCoordinates(e);
      addClickRipple(e.clientX, e.clientY, state.mode === 'laser' ? '#ef4444' : '#38bdf8');

      state.activeConn.send({
        type: 'mouse-down',
        button: e.button,
        x: coords.pctX,
        y: coords.pctY
      });
    });

    container.addEventListener('mouseup', (e) => {
      if (!state.activeConn) return;
      const coords = getRelativeCoordinates(e);
      state.activeConn.send({
        type: 'mouse-up',
        button: e.button,
        x: coords.pctX,
        y: coords.pctY
      });
    });

    container.addEventListener('wheel', (e) => {
      if (!state.activeConn) return;
      e.preventDefault();
      const coords = getRelativeCoordinates(e);
      state.activeConn.send({
        type: 'mouse-wheel',
        deltaX: e.deltaX,
        deltaY: e.deltaY,
        x: coords.pctX,
        y: coords.pctY
      });
    }, { passive: false });

    // Keyboard events
    window.addEventListener('keydown', (e) => {
      if (state.isDrawerOpen || document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') return;
      if (!state.activeConn) return;
      if (e.key === 'F11') return;

      state.activeConn.send({
        type: 'key-down',
        key: e.key,
        code: e.code,
        ctrlKey: e.ctrlKey,
        altKey: e.altKey,
        shiftKey: e.shiftKey,
        metaKey: e.metaKey
      });
    });

    window.addEventListener('keyup', (e) => {
      if (state.isDrawerOpen || document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') return;
      if (!state.activeConn) return;

      state.activeConn.send({
        type: 'key-up',
        key: e.key,
        code: e.code,
        ctrlKey: e.ctrlKey,
        altKey: e.altKey,
        shiftKey: e.shiftKey,
        metaKey: e.metaKey
      });
    });
  }

  // =========================================================================
  // Host Screen Overlay & Mirrored Cursor
  // =========================================================================
  function renderHostMirroredCursor(pctX, pctY, isLaser = false) {
    const cursor = $('hostRemoteCursor');
    if (!cursor) return;
    cursor.classList.remove('hidden');

    const screenX = pctX * window.innerWidth;
    const screenY = pctY * window.innerHeight;

    cursor.style.transform = `translate(${screenX}px, ${screenY}px)`;
    const icon = cursor.querySelector('svg');
    if (icon) {
      icon.setAttribute('fill', isLaser ? '#ef4444' : '#38bdf8');
    }
  }

  let hudTimer = null;
  function showHostKeyHUD(keyText) {
    const hud = $('hostKeyHUD');
    const hudText = $('hostKeyHUDText');
    if (!hud || !hudText) return;
    hudText.textContent = `⌨️ ${keyText}`;
    hud.classList.remove('hidden');
    if (hudTimer) clearTimeout(hudTimer);
    hudTimer = setTimeout(() => hud.classList.add('hidden'), 2000);
  }

  function relayInputToHostBridge(eventData) {
    if (!state.hasServerApi) return;
    try {
      fetch('/api/host-input', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: eventData })
      }).catch(() => {});
    } catch (e) {}
  }

  // =========================================================================
  // Server Status & OS Controller Detection
  // =========================================================================
  async function checkServerStatus() {
    try {
      const res = await fetch('/api/status');
      if (res.ok) {
        const data = await res.json();
        state.hasServerApi = true;
        const osBadge = $('osBridgeBadge');
        const osDot = $('osBridgeDot');
        const osText = $('osBridgeText');
        const desc = $('nativeStatusDesc');

        if (data.osControlAvailable) {
          if (osBadge) osBadge.classList.remove('hidden');
          if (osDot) osDot.className = 'w-2 h-2 rounded-full bg-emerald-500';
          if (osText) osText.textContent = `Windows OS Bridge Active (${data.screenMetrics ? `${data.screenMetrics.width}x${data.screenMetrics.height}` : 'DPI Ready'})`;
          if (desc) desc.textContent = 'Local Windows Input Bridge Active';
        } else {
          if (osBadge) osBadge.classList.remove('hidden');
          if (osDot) osDot.className = 'w-2 h-2 rounded-full bg-amber-500';
          if (osText) osText.textContent = 'WebRTC Simulated Control';
          if (desc) desc.textContent = 'Browser Sandbox Simulation';
        }
      }
    } catch (e) {
      state.hasServerApi = false;
      const desc = $('nativeStatusDesc');
      if (desc) desc.textContent = 'Browser Sandbox Simulation';
    }
  }

  // =========================================================================
  // UI Bindings & Initialization
  // =========================================================================
  function updateCodeDisplay() {
    const displayEl = $('myCodeDisplay');
    if (displayEl) displayEl.textContent = formatDisplay(state.myCode);
  }

  function updateStatusBadge(text, type = 'ready') {
    const badgeText = $('headerStatusText');
    if (badgeText) badgeText.textContent = text;
  }

  function setupAutoHidingToolbar() {
    const toolbar = $('sessionToolbar');
    const trigger = $('toolbarTriggerZone');
    if (!toolbar) return;

    let hideTimer = null;

    function showToolbar() {
      toolbar.classList.remove('toolbar-hidden');
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        if (!state.isKeysPopoverOpen) {
          toolbar.classList.add('toolbar-hidden');
        }
      }, 3000);
    }

    window.addEventListener('mousemove', (e) => {
      if (e.clientY < 75) {
        showToolbar();
      }
    });

    if (trigger) {
      trigger.addEventListener('mouseenter', showToolbar);
    }
    toolbar.addEventListener('mouseenter', () => {
      if (hideTimer) clearTimeout(hideTimer);
    });
    toolbar.addEventListener('mouseleave', () => {
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        if (!state.isKeysPopoverOpen) {
          toolbar.classList.add('toolbar-hidden');
        }
      }, 2000);
    });
  }

  function initUI() {
    updateCodeDisplay();
    renderRecentSessions();
    initLaserCanvas();
    bindViewerInputEvents();
    setupAutoHidingToolbar();
    checkServerStatus();

    // 1. Copy Address button
    on($('btnCopyCode'), 'click', () => {
      const code = state.myCode;
      navigator.clipboard.writeText(formatDisplay(code)).then(() => {
        const text = $('copyBtnText');
        if (text) text.textContent = 'Copied!';
        showToast('9-Digit address copied to clipboard!', 'success');
        setTimeout(() => { if (text) text.textContent = 'Copy'; }, 2000);
      });
    });

    // 2. Refresh Code button
    on($('btnNewCode'), 'click', () => {
      state.myCode = String(Math.floor(100000000 + Math.random() * 900000000));
      sessionStorage.setItem('omnicast_my_code', state.myCode);
      updateCodeDisplay();
      initPeer();
      showToast('New 9-digit address generated.', 'info');
    });

    // 3. Remote Desk Input: auto-format 9 digits with spaces
    const targetInput = $('targetCodeInput');
    if (targetInput) {
      targetInput.addEventListener('input', (e) => {
        const clean = cleanDigits(e.target.value);
        e.target.value = formatDisplay(clean);
      });
    }

    // 4. Connect Form submission
    on($('connectForm'), 'submit', (e) => {
      e.preventDefault();
      const input = $('targetCodeInput');
      if (input) {
        requestConnectionToRemote(input.value);
      }
    });

    // 5. Cancel Connection button
    on($('btnCancelConnect'), 'click', () => {
      stopAllSessions('Connection cancelled.');
    });

    // 6. Incoming Authorization Modal buttons
    on($('btnAccept'), 'click', acceptIncomingConnection);
    on($('btnDecline'), 'click', () => rejectIncomingConnection('Host declined connection.'));

    // 7. Stop Session buttons (Disconnect)
    on($('btnStopSession'), 'click', () => stopAllSessions('Disconnected from remote desk.'));
    on($('btnHostStop'), 'click', () => stopAllSessions('Screen sharing stopped by host.'));

    // 8. Special Keys Popover
    on($('btnSpecialKeys'), 'click', (e) => {
      e.stopPropagation();
      const popover = $('keysDropdown');
      if (!popover) return;
      state.isKeysPopoverOpen = !state.isKeysPopoverOpen;
      popover.classList.toggle('hidden', !state.isKeysPopoverOpen);
    });

    window.addEventListener('click', (e) => {
      const popover = $('keysDropdown');
      const btn = $('btnSpecialKeys');
      if (popover && !popover.contains(e.target) && btn && !btn.contains(e.target)) {
        popover.classList.add('hidden');
        state.isKeysPopoverOpen = false;
      }
    });

    on($('btnKeyCAD'), 'click', () => {
      if (state.activeConn) state.activeConn.send({ type: 'special-key', key: 'CAD' });
      showToast('Sent Ctrl+Alt+Del', 'info');
    });
    on($('btnKeyWin'), 'click', () => {
      if (state.activeConn) state.activeConn.send({ type: 'special-key', key: 'WIN' });
      showToast('Sent Windows Key', 'info');
    });
    on($('btnKeyAltTab'), 'click', () => {
      if (state.activeConn) state.activeConn.send({ type: 'special-key', key: 'ALTTAB' });
      showToast('Sent Alt+Tab', 'info');
    });
    on($('btnKeyEsc'), 'click', () => {
      if (state.activeConn) state.activeConn.send({ type: 'special-key', key: 'ESC' });
      showToast('Sent Escape', 'info');
    });

    on($('btnSendTextToRemote'), 'click', () => {
      const input = $('textSenderInput');
      if (input && input.value && state.activeConn) {
        state.activeConn.send({ type: 'text-input', text: input.value });
        showToast('Text sent to remote computer!', 'success');
        input.value = '';
      }
    });

    // 9. Control / Laser mode toggle
    on($('btnToggleControl'), 'click', () => {
      state.mode = 'control';
      $('btnToggleControl').classList.add('active');
      $('btnTogglePointer').classList.remove('active');
      const video = $('remoteVideo');
      if (video) {
        video.classList.add('control-active');
        video.classList.remove('laser-active');
      }
      showToast('Control mode: direct mouse & keyboard', 'info');
    });

    on($('btnTogglePointer'), 'click', () => {
      state.mode = 'laser';
      $('btnTogglePointer').classList.add('active');
      $('btnToggleControl').classList.remove('active');
      const video = $('remoteVideo');
      if (video) {
        video.classList.add('laser-active');
        video.classList.remove('control-active');
      }
      showToast('Laser pointer mode active', 'info');
    });

    // 10. Aspect Ratio / Fit Toggle
    on($('btnToggleFit'), 'click', () => {
      state.isFitContain = !state.isFitContain;
      const video = $('remoteVideo');
      const label = $('fitLabel');
      if (video) video.classList.toggle('fit-original', !state.isFitContain);
      if (label) label.textContent = state.isFitContain ? 'Fit' : '1:1';
      showToast(state.isFitContain ? 'Fit to Screen' : 'Original 1:1 Scale', 'info');
    });

    // 11. Fullscreen Toggle
    on($('btnFullscreen'), 'click', () => {
      const elem = $('sessionView');
      if (!document.fullscreenElement) {
        elem.requestFullscreen().catch(() => {});
      } else {
        document.exitFullscreen().catch(() => {});
      }
    });

    // 12. Audio Mute/Unmute
    on($('btnToggleAudio'), 'click', () => {
      const video = $('remoteVideo');
      if (!video) return;
      state.isMuted = !state.isMuted;
      video.muted = state.isMuted;
      const label = $('audioLabel');
      if (label) label.textContent = state.isMuted ? 'Muted' : 'Audio On';
      showToast(state.isMuted ? 'Audio Muted' : 'Audio Unmuted', 'info');
    });

    // 13. Screen Recording
    on($('btnRecordScreen'), 'click', toggleScreenRecording);

    // 14. Side Drawer Toggle
    on($('btnToggleDrawer'), 'click', () => {
      const drawer = $('sideDrawer');
      if (!drawer) return;
      state.isDrawerOpen = !state.isDrawerOpen;
      drawer.classList.toggle('drawer-closed', !state.isDrawerOpen);
      if (state.isDrawerOpen) {
        state.unreadMessages = 0;
        updateDrawerBadge();
      }
    });
    on($('btnCloseDrawer'), 'click', () => {
      const drawer = $('sideDrawer');
      if (drawer) drawer.classList.add('drawer-closed');
      state.isDrawerOpen = false;
    });

    // 15. Drawer Tabs Switcher (Chat & Clipboard)
    const tabs = [
      { btn: 'tabBtnChat', pane: 'tabPaneChat' },
      { btn: 'tabBtnClipboard', pane: 'tabPaneClipboard' }
    ];
    tabs.forEach(tab => {
      on($(tab.btn), 'click', () => {
        tabs.forEach(t => {
          const b = $(t.btn);
          const p = $(t.pane);
          if (b) b.classList.toggle('active', t.btn === tab.btn);
          if (p) p.classList.toggle('hidden', t.pane !== tab.pane);
        });
      });
    });

    // 16. Chat Form Submit
    on($('chatForm'), 'submit', (e) => {
      e.preventDefault();
      const input = $('chatInput');
      if (input && input.value) {
        sendChatMessage(input.value);
        input.value = '';
      }
    });

    // 17. Shared Clipboard Push & Pull
    on($('btnClipboardPush'), 'click', () => {
      const area = $('sharedClipboardText');
      if (area && state.activeConn) {
        state.activeConn.send({ type: 'clipboard-push', text: area.value });
        showToast('Clipboard text pushed to partner!', 'success');
      }
    });

    on($('btnClipboardPull'), 'click', () => {
      if (state.activeConn) {
        state.activeConn.send({ type: 'clipboard-pull-req' });
        showToast('Requesting partner clipboard...', 'info');
      }
    });

    // 18. Clear Recent Sessions
    on($('btnClearRecent'), 'click', () => {
      localStorage.removeItem('omnicast_recent_sessions');
      renderRecentSessions();
      showToast('Recent sessions cleared.', 'info');
    });

    // 19. Quality Selector
    on($('selectQuality'), 'change', (e) => {
      const quality = e.target.value;
      showToast(`Stream quality set to: ${quality.toUpperCase()}`, 'info');
      if (state.activeCall && state.activeCall.peerConnection) {
        try {
          const senders = state.activeCall.peerConnection.getSenders();
          senders.forEach(sender => {
            if (sender.track && sender.track.kind === 'video') {
              const params = sender.getParameters();
              if (params && params.encodings && params.encodings[0]) {
                if (quality === '1080p') {
                  params.encodings[0].maxBitrate = 4000000;
                  params.encodings[0].scaleResolutionDownBy = 1.0;
                } else if (quality === '720p') {
                  params.encodings[0].maxBitrate = 1800000;
                  params.encodings[0].scaleResolutionDownBy = 1.5;
                } else if (quality === '480p') {
                  params.encodings[0].maxBitrate = 600000;
                  params.encodings[0].scaleResolutionDownBy = 2.0;
                } else {
                  delete params.encodings[0].maxBitrate;
                  params.encodings[0].scaleResolutionDownBy = 1.0;
                }
                sender.setParameters(params).catch(() => {});
              }
            }
          });
        } catch (err) {}
      }
    });

    // 20. Dismiss File Scheme Banner
    on($('btnDismissScheme'), 'click', () => {
      const b = $('fileSchemeBanner');
      if (b) b.classList.add('hidden');
    });
    if (window.location.protocol === 'file:') {
      const b = $('fileSchemeBanner');
      if (b) b.classList.remove('hidden');
    }
  }

  // Start peer and bind UI
  window.addEventListener('DOMContentLoaded', () => {
    initPeer();
    initUI();
    if (window.lucide && window.lucide.createIcons) {
      window.lucide.createIcons();
    }
  });

})();
