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
    scalingMode: 'fit',     // 'fit' | 'stretch' | 'original'
    hasServerApi: false,
    unreadMessages: 0,
    isDrawerOpen: false,
    isKeysPopoverOpen: false,
    activeDrawerTab: 'chat',

    // Authorization Modal Countdown
    authCountdownTimer: null,
    authSecondsRemaining: 30,
    pendingCallerCode: null,
    pendingClientInfo: null,
    pendingPermissions: null,

    // Unattended Access PIN Setup
    unattendedEnabled: false,
    unattendedPin: sessionStorage.getItem('omnicast_unattended_pin') || '',

    // Permissions
    permissions: {
      allowAudio: true,
      allowPointer: true,
      allowClipboard: true,
      allowFileTransfer: true,
      nativeOsControl: true
    },

    // Candidate Queue & Reconnection
    pendingIceCandidates: [],
    iceRestartAttempts: 0,

    // P2P File Transfer Engine
    incomingFiles: {},
    activeFileTransfer: null,

    // WebRTC Stats Polling & Adaptive Quality
    statsInterval: null,
    prevBytesReceived: 0,
    prevPacketsLost: 0,
    prevPacketsReceived: 0,
    prevTimestamp: 0,
    consecutivePoorNetworkCount: 0,

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
    window.addEventListener('orientationchange', resizeLaserCanvas);
    requestAnimationFrame(renderLaserLoop);
  }

  function resizeLaserCanvas() {
    const canvas = $('laserCanvas');
    const container = $('videoContainer');
    if (!canvas) return;
    const w = (container && container.clientWidth > 0) ? container.clientWidth : window.innerWidth;
    const h = (container && container.clientHeight > 0) ? container.clientHeight : window.innerHeight;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  }

  function addClickRipple(x, y, color = '#ef4444') {
    ripples.push({ x, y, radius: 4, alpha: 0.9, color });
  }

  function renderLaserLoop() {
    if (laserCtx) {
      const canvas = laserCtx.canvas;
      const targetW = window.innerWidth;
      const targetH = window.innerHeight;
      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW;
        canvas.height = targetH;
      }

      laserCtx.clearRect(0, 0, canvas.width, canvas.height);

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

      // Render laser dot when active in laser mode across every pixel of screen
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
      if (ctx.state === 'suspended') {
        ctx.resume().catch(() => {});
      }
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.value = 0.0001; // Inaudible keepalive tone
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      backgroundAudioKeepAlive = { ctx, osc };

      // Keep screen and tab alive with Screen WakeLock if available
      if ('wakeLock' in navigator && navigator.wakeLock.request) {
        navigator.wakeLock.request('screen').then(lock => {
          if (backgroundAudioKeepAlive) backgroundAudioKeepAlive.wakeLock = lock;
        }).catch(() => {});
      }
    } catch (e) {}
  }

  function stopBackgroundAudioKeepAlive() {
    try {
      if (backgroundAudioKeepAlive) {
        if (backgroundAudioKeepAlive.osc) {
          try { backgroundAudioKeepAlive.osc.stop(); } catch (e) {}
        }
        if (backgroundAudioKeepAlive.ctx) {
          try { backgroundAudioKeepAlive.ctx.close(); } catch (e) {}
        }
        if (backgroundAudioKeepAlive.wakeLock) {
          try { backgroundAudioKeepAlive.wakeLock.release(); } catch (e) {}
        }
        backgroundAudioKeepAlive = null;
      }
    } catch (e) {}
  }

  // =========================================================================
  // Bulletproof Remote Video Attachment & Autoplay Unlock
  // =========================================================================
  function attachRemoteStream(stream) {
    if (!stream) {
      console.warn('[OmniCast] attachRemoteStream received falsy stream');
      return;
    }

    console.log('[OmniCast] Attaching Remote Stream:', stream.id, 'Tracks:', stream.getTracks().map(t => `${t.kind}:${t.enabled}:${t.readyState}`).join(', '));
    state.remoteStream = stream;

    const video = $('remoteVideo');
    if (!video) return;

    // Check if stream is missing video track, try to recover from peer receivers
    if (stream.getVideoTracks().length === 0 && state.activeCall && state.activeCall.peerConnection) {
      try {
        const receivers = state.activeCall.peerConnection.getReceivers();
        const vRec = receivers.find(r => r.track && r.track.kind === 'video' && r.track.readyState !== 'ended');
        if (vRec && vRec.track) {
          vRec.track.enabled = true;
          stream.addTrack(vRec.track);
          console.log('[OmniCast Recovered Video Track from Receivers]', vRec.track.id);
        }
      } catch (e) {}
    }

    // Force video element to bind stream cleanly
    if (video.srcObject !== stream || video.videoWidth === 0) {
      try { video.srcObject = null; } catch (e) {}
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
          resizeLaserCanvas();
          if (video.videoWidth > 0 && video.videoHeight > 0) {
            updateResolutionStat(video.videoWidth, video.videoHeight);
          }
        }).catch(err => {
          console.warn('[OmniCast Autoplay paused, waiting for gesture]', err.message);
          const unlock = () => {
            video.play().then(() => {
              hideConnectingLoader();
              resizeLaserCanvas();
            }).catch(() => {});
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
      resizeLaserCanvas();
      forcePlayVideo();
    };

    video.oncanplay = () => {
      forcePlayVideo();
    };

    video.onplaying = () => {
      hideConnectingLoader();
      resizeLaserCanvas();
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        updateResolutionStat(video.videoWidth, video.videoHeight);
      }
    };

    video.onresize = () => {
      resizeLaserCanvas();
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        updateResolutionStat(video.videoWidth, video.videoHeight);
      }
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
      try { video.srcObject = null; } catch (err) {}
      video.srcObject = stream;
      forcePlayVideo();
    };

    // Immediate playback kick-off
    forcePlayVideo();

    // Active Watchdog: verify stream frame rendering within 1.5s
    if (state.streamWatchdog) clearTimeout(state.streamWatchdog);
    state.streamWatchdog = setTimeout(() => {
      if (video && (video.videoWidth === 0 || video.paused)) {
        console.warn('[OmniCast Watchdog] Re-checking receiver tracks...');
        if (state.activeCall && state.activeCall.peerConnection) {
          try {
            const receivers = state.activeCall.peerConnection.getReceivers();
            const vTrack = receivers.find(r => r.track && r.track.kind === 'video' && r.track.readyState !== 'ended');
            if (vTrack && vTrack.track) {
              vTrack.track.enabled = true;
              const freshStream = new MediaStream([vTrack.track]);
              const aTrack = receivers.find(r => r.track && r.track.kind === 'audio' && r.track.readyState !== 'ended');
              if (aTrack && aTrack.track) freshStream.addTrack(aTrack.track);
              video.srcObject = null;
              video.srcObject = freshStream;
              video.play().catch(() => {});
            }
          } catch (e) {}
        }
      }
    }, 1500);

    hideConnectingLoader();
    sound.success();
    showToast('Connected! Live screen active.', 'success');
    startStatsPolling();
  }

  // Dynamic STUN/TURN Discovery
  async function fetchTurnCredentials() {
    try {
      const res = await fetch('/api/turn-credentials');
      if (res.ok) {
        const data = await res.json();
        if (data && data.iceServers && Array.isArray(data.iceServers)) {
          console.log('[OmniCast] Loaded dynamic STUN/TURN relays from server:', data.iceServers.length, 'servers');
          PEER_CONFIG.config.iceServers = data.iceServers;
        }
      }
    } catch (e) {}
  }

  // Safe ICE Candidate Queue Flush
  async function flushIceCandidateQueue(pc) {
    if (!pc || !pc.remoteDescription || !pc.remoteDescription.type) return;
    while (state.pendingIceCandidates.length > 0) {
      const cand = state.pendingIceCandidates.shift();
      try {
        await pc.addIceCandidate(new RTCIceCandidate(cand));
      } catch (err) {
        console.warn('[Flush Candidate Catch]', err);
      }
    }
  }

  // =========================================================================
  // PeerJS WebRTC Initialization
  // =========================================================================
  async function initPeer() {
    if (typeof Peer === 'undefined') {
      setTimeout(initPeer, 200);
      return;
    }

    await fetchTurnCredentials();

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

        // 4. Hook into underlying RTCPeerConnection and receiver tracks directly
        const checkReceivers = () => {
          if (!call.peerConnection || !call.peerConnection.getReceivers) return;
          try {
            const receivers = call.peerConnection.getReceivers();
            const vReceiver = receivers.find(r => r.track && r.track.kind === 'video' && r.track.readyState !== 'ended');
            if (vReceiver && vReceiver.track) {
              vReceiver.track.enabled = true;
              if (state.remoteStream) {
                if (!state.remoteStream.getVideoTracks().some(t => t.id === vReceiver.track.id)) {
                  console.log('[OmniCast Adding Video Track to Existing Stream]', vReceiver.track.id);
                  state.remoteStream.addTrack(vReceiver.track);
                  const v = $('remoteVideo');
                  if (v) {
                    if (v.srcObject !== state.remoteStream) v.srcObject = state.remoteStream;
                    v.play().catch(() => {});
                  }
                }
              } else {
                console.log('[OmniCast Creating New Stream from Receiver Track]', vReceiver.track.id);
                const newStream = new MediaStream([vReceiver.track]);
                const aReceiver = receivers.find(r => r.track && r.track.kind === 'audio' && r.track.readyState !== 'ended');
                if (aReceiver && aReceiver.track) newStream.addTrack(aReceiver.track);
                attachRemoteStream(newStream);
              }
            }
          } catch (e) {}
        };

        const hookPCTracks = () => {
          const pc = call.peerConnection;
          if (pc && !pc._tracksHooked) {
            pc._tracksHooked = true;

            // Hook setRemoteDescription to flush candidate queue automatically
            const originalSetRemote = pc.setRemoteDescription.bind(pc);
            pc.setRemoteDescription = async (...args) => {
              const res = await originalSetRemote(...args);
              flushIceCandidateQueue(pc);
              return res;
            };

            pc.ontrack = (event) => {
              console.log('[Direct RTCPeerConnection ontrack]', event.track.kind);
              event.track.enabled = true;
              const s = (event.streams && event.streams[0]) ? event.streams[0] : new MediaStream([event.track]);
              attachRemoteStream(s);
            };

            pc.addEventListener('track', (event) => {
              console.log('[Direct RTCPeerConnection track event]', event.track.kind);
              event.track.enabled = true;
              const s = (event.streams && event.streams[0]) ? event.streams[0] : new MediaStream([event.track]);
              attachRemoteStream(s);
            });

            pc.addEventListener('connectionstatechange', () => {
              console.log('[RTCPeerConnection state]', pc.connectionState);
              if (pc.connectionState === 'connected') {
                checkReceivers();
              }
            });

            // ICE Restart & Reconnection Watcher
            pc.addEventListener('iceconnectionstatechange', async () => {
              console.log('[RTCPeerConnection ICE State]', pc.iceConnectionState);
              if (pc.iceConnectionState === 'failed') {
                console.warn('[ICE State Failed] Attempting session recovery via ICE restart...');
                showToast('Network blip detected. Reconnecting (ICE Restart)...', 'info');
                try {
                  if (state.isHost) {
                    const offer = await pc.createOffer({ iceRestart: true });
                    await pc.setLocalDescription(offer);
                  } else if (state.activeConn) {
                    state.activeConn.send({ type: 'request-ice-restart' });
                  }
                } catch (e) {}
              }
            });
          }
          checkReceivers();
        };

        hookPCTracks();
        setTimeout(hookPCTracks, 50);
        setTimeout(hookPCTracks, 200);
        setTimeout(hookPCTracks, 600);
        setTimeout(hookPCTracks, 1200);

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
        
        // Unattended Access Auto-Authorization Check
        const savedPin = state.unattendedPin;
        const incomingPin = data.pin ? String(data.pin).trim() : '';
        if (state.unattendedEnabled && savedPin && savedPin === incomingPin) {
          console.log('[OmniCast] Unattended Access PIN Matched! Auto-authorizing connection.');
          showToast('Unattended connection authorized by PIN.', 'info');
          acceptIncomingConnection();
          return;
        }

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

      // 6. Remote Control: Mouse Up / Click / Double Click
      else if (data.type === 'mouse-up' || data.type === 'mouse-click' || data.type === 'double-click') {
        if (data.type === 'double-click') {
          addClickRipple(data.x * window.innerWidth, data.y * window.innerHeight, '#38bdf8');
          setTimeout(() => addClickRipple(data.x * window.innerWidth, data.y * window.innerHeight, '#38bdf8'), 120);
        }
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

      // 14. P2P Binary File Transfer
      else if (data.type === 'file-meta') {
        handleIncomingFileMeta(data);
      } else if (data.type === 'file-chunk') {
        handleIncomingFileChunk(data);
      } else if (data.type === 'file-complete') {
        handleIncomingFileComplete(data);
      } else if (data.type === 'file-cancel') {
        handleIncomingFileCancel(data);
      }

      // 15. Remote ICE Restart Request
      else if (data.type === 'request-ice-restart') {
        handleRemoteIceRestartRequest();
      }

      // 16. Session Disconnect Notice
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

    const permsEl = $('incomingPerms');
    if (permsEl) {
      const perms = [];
      if (state.permissions.allowPointer) perms.push('Mouse/Keyboard');
      if (state.permissions.allowAudio) perms.push('Audio');
      if (state.permissions.allowClipboard) perms.push('Clipboard');
      if (state.permissions.allowFileTransfer) perms.push('File Transfer');
      permsEl.textContent = perms.join(', ') || 'View Only';
    }

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

      // Standard screen capture options
      let stream;
      try {
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: {
            cursor: 'always',
            frameRate: { ideal: 60, max: 60 }
          },
          audio: state.permissions.allowAudio,
          selfBrowserSurface: 'include',
          surfaceSwitching: 'include'
        });
      } catch (e1) {
        if (e1.name === 'NotAllowedError' || e1.name === 'AbortError') {
          if (state.activeConn) {
            state.activeConn.send({ type: 'permission-denied', reason: 'Host cancelled screen selection.' });
          }
          return;
        }
        // Fallback with minimal video constraints
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: false
        });
      }

      if (!stream || stream.getVideoTracks().length === 0) {
        showToast('No video track available from screen capture.', 'error');
        if (state.activeConn) {
          state.activeConn.send({ type: 'permission-denied', reason: 'Failed to capture host video track.' });
        }
        return;
      }

      state.localStream = stream;
      state.isHost = true;

      // Keep Host background tab active so Chrome doesn't throttle WebRTC encoder
      startBackgroundAudioKeepAlive();

      const vTrack = stream.getVideoTracks()[0];
      if (vTrack) {
        vTrack.enabled = true;
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

    if (!state.peer || !state.peer.open) {
      showToast('Connecting to network broker... Retrying in 1s', 'info');
      initPeer();
      setTimeout(() => {
        if (state.peer && state.peer.open) {
          requestConnectionToRemote(rawTargetCode);
        } else {
          showToast('Network broker still connecting. Please click Connect again.', 'info');
        }
      }, 1000);
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
        const pinInput = $('targetPinInput');
        const pin = pinInput ? pinInput.value.trim() : '';

        conn.send({
          type: 'ask-permission',
          fromCode: state.myCode,
          pin: pin,
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

    const toolbar = $('sessionToolbar');
    if (toolbar) {
      toolbar.style.left = '';
      toolbar.style.top = '';
      toolbar.style.transform = '';
      toolbar.classList.remove('toolbar-minimized', 'is-dragging');
    }

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
    state.prevPacketsLost = 0;
    state.prevPacketsReceived = 0;
    state.prevTimestamp = performance.now();
    state.consecutivePoorNetworkCount = 0;

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
        let jitter = null;
        let packetLossPct = null;

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
            if (report.jitter !== undefined) {
              jitter = Math.round(report.jitter * 1000);
            }
            if (report.frameWidth && report.frameHeight) {
              resWidth = report.frameWidth;
              resHeight = report.frameHeight;
            }
            // Packet loss monitoring
            if (report.packetsLost !== undefined && report.packetsReceived !== undefined) {
              const lostDiff = Math.max(0, report.packetsLost - state.prevPacketsLost);
              const recvDiff = Math.max(0, report.packetsReceived - state.prevPacketsReceived);
              const totalPackets = lostDiff + recvDiff;
              if (totalPackets > 10) {
                packetLossPct = Math.min(100, Math.round((lostDiff / totalPackets) * 100));
                if (packetLossPct > 5) {
                  state.consecutivePoorNetworkCount++;
                  if (state.consecutivePoorNetworkCount >= 3) {
                    triggerAdaptiveQualityDowngrade();
                    state.consecutivePoorNetworkCount = 0;
                  }
                } else {
                  state.consecutivePoorNetworkCount = 0;
                }
              }
              state.prevPacketsLost = report.packetsLost;
              state.prevPacketsReceived = report.packetsReceived;
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
  // P2P Chunked Binary File Transfer Engine (Backpressure Flow Control)
  // =========================================================================
  const CHUNK_SIZE = 16384; // 16 KB chunk size for WebRTC DataChannel
  const BUFFER_HIGH_THRESHOLD = 262144; // 256 KB pause
  const BUFFER_LOW_THRESHOLD = 65536;   // 64 KB resume

  function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return (bytes / Math.pow(k, i)).toFixed(1) + ' ' + sizes[i];
  }

  function showFileProgress(name, totalBytes, action) {
    const box = $('fileProgressBox');
    if (!box) return;
    box.classList.remove('hidden');
    const elName = $('transferFileName');
    const elPct = $('transferPercent');
    const elFill = $('fileProgressBarFill');
    const elBytes = $('transferBytes');
    const elStatus = $('transferStatusText');
    if (elName) elName.textContent = name;
    if (elPct) elPct.textContent = '0%';
    if (elFill) elFill.style.width = '0%';
    if (elBytes) elBytes.textContent = `0 B / ${formatBytes(totalBytes)}`;
    if (elStatus) elStatus.textContent = `${action}...`;
  }

  function updateFileProgress(transferredBytes, totalBytes, statusText) {
    const pct = totalBytes > 0 ? Math.min(100, Math.round((transferredBytes / totalBytes) * 100)) : 0;
    const elPct = $('transferPercent');
    const elFill = $('fileProgressBarFill');
    const elBytes = $('transferBytes');
    const elStatus = $('transferStatusText');
    if (elPct) elPct.textContent = `${pct}%`;
    if (elFill) elFill.style.width = `${pct}%`;
    if (elBytes) elBytes.textContent = `${formatBytes(transferredBytes)} / ${formatBytes(totalBytes)}`;
    if (elStatus && statusText) elStatus.textContent = statusText;
  }

  function hideFileProgress() {
    const box = $('fileProgressBox');
    if (box) box.classList.add('hidden');
  }

  function addFileToHistory(name, size, type, downloadUrl = null) {
    const list = $('transfersList');
    const empty = $('transfersEmptyText');
    if (empty) empty.classList.add('hidden');
    if (!list) return;

    const item = document.createElement('div');
    item.className = 'transfer-history-item';
    const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const isSent = type === 'Sent';

    item.innerHTML = `
      <div class="transfer-item-left">
        <div class="transfer-icon ${isSent ? 'icon-sent' : 'icon-recv'}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            ${isSent 
              ? '<line x1="12" y1="19" x2="12" y2="5"></line><polyline points="5 12 12 5 19 12"></polyline>' 
              : '<line x1="12" y1="5" x2="12" y2="19"></line><polyline points="19 12 12 19 5 12"></polyline>'}
          </svg>
        </div>
        <div>
          <div class="transfer-item-name" title="${escapeHtml(name)}">${escapeHtml(name)}</div>
          <div class="transfer-item-meta">${formatBytes(size)} • ${timeStr} • ${type}</div>
        </div>
      </div>
      ${downloadUrl ? `<a href="${downloadUrl}" download="${escapeHtml(name)}" class="btn-download-item" title="Save file to disk">Save</a>` : ''}
    `;
    list.prepend(item);
  }

  async function sendFileOverDataChannel(file) {
    if (!state.activeConn || !state.activeConn.open) {
      showToast('No active connection. Cannot send file.', 'error');
      return;
    }
    if (!state.permissions.allowFileTransfer) {
      showToast('File transfer is disabled in session permissions.', 'warning');
      return;
    }
    if (!file) return;

    const fileId = 'file_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

    showFileProgress(file.name, file.size, 'Sending file');
    showToast(`Sending ${file.name} (${formatBytes(file.size)})...`, 'info');

    // 1. Notify partner of incoming file metadata
    state.activeConn.send({
      type: 'file-meta',
      fileId,
      name: file.name,
      size: file.size,
      mime: file.type || 'application/octet-stream',
      totalChunks
    });

    // 2. Stream chunks with backpressure flow control
    let offset = 0;
    let chunkIndex = 0;
    const rawDc = state.activeConn.dataChannel;

    state.activeFileTransfer = { fileId, cancelled: false };

    try {
      while (offset < file.size) {
        if (state.activeFileTransfer && state.activeFileTransfer.cancelled) {
          state.activeConn.send({ type: 'file-cancel', fileId });
          hideFileProgress();
          showToast('File transfer cancelled.', 'info');
          return;
        }

        // Backpressure flow control check on native RTCDataChannel
        if (rawDc && rawDc.bufferedAmount > BUFFER_HIGH_THRESHOLD) {
          await new Promise((resolve) => {
            const onLow = () => {
              rawDc.removeEventListener('bufferedamountlow', onLow);
              resolve();
            };
            try {
              rawDc.bufferedAmountLowThreshold = BUFFER_LOW_THRESHOLD;
              rawDc.addEventListener('bufferedamountlow', onLow);
            } catch (e) {
              setTimeout(resolve, 50);
              return;
            }
            setTimeout(resolve, 600); // Safety timeout
          });
        }

        const slice = file.slice(offset, offset + CHUNK_SIZE);
        const buffer = await slice.arrayBuffer();

        // Convert chunk to base64 string
        let binary = '';
        const bytes = new Uint8Array(buffer);
        const len = bytes.byteLength;
        for (let i = 0; i < len; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        const b64 = window.btoa(binary);

        state.activeConn.send({
          type: 'file-chunk',
          fileId,
          chunkIndex,
          data: b64
        });

        offset += slice.size;
        chunkIndex++;
        updateFileProgress(offset, file.size, 'Sending chunks...');

        if (chunkIndex % 8 === 0) {
          await new Promise(r => setTimeout(r, 0));
        }
      }

      // 3. Send complete
      state.activeConn.send({
        type: 'file-complete',
        fileId
      });

      hideFileProgress();
      addFileToHistory(file.name, file.size, 'Sent');
      sound.success();
      showToast(`File "${file.name}" sent successfully!`, 'success');

    } catch (err) {
      console.error('[Send File Error]', err);
      hideFileProgress();
      showToast('File transfer failed: ' + (err.message || err), 'error');
    } finally {
      state.activeFileTransfer = null;
    }
  }

  function handleIncomingFileMeta(data) {
    if (!state.permissions.allowFileTransfer) {
      showToast('Incoming file rejected: File transfer disabled in permissions.', 'warning');
      return;
    }

    state.incomingFiles[data.fileId] = {
      name: data.name,
      size: data.size,
      mime: data.mime || 'application/octet-stream',
      totalChunks: data.totalChunks,
      receivedChunks: 0,
      chunks: new Array(data.totalChunks),
      receivedBytes: 0
    };

    showFileProgress(data.name, data.size, 'Receiving file');
    showToast(`Incoming file: ${data.name} (${formatBytes(data.size)})`, 'info');
  }

  function handleIncomingFileChunk(data) {
    const file = state.incomingFiles[data.fileId];
    if (!file) return;

    try {
      const binary = window.atob(data.data);
      const len = binary.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      file.chunks[data.chunkIndex] = bytes;
      file.receivedChunks++;
      file.receivedBytes += len;

      updateFileProgress(file.receivedBytes, file.size, 'Receiving chunks...');
    } catch (e) {
      console.warn('[Chunk decode error]', e);
    }
  }

  function handleIncomingFileComplete(data) {
    const file = state.incomingFiles[data.fileId];
    if (!file) return;

    try {
      const blob = new Blob(file.chunks, { type: file.mime });
      const downloadUrl = URL.createObjectURL(blob);

      // Auto-trigger browser download
      const a = document.createElement('a');
      a.href = downloadUrl;
      a.download = file.name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);

      hideFileProgress();
      addFileToHistory(file.name, file.size, 'Received', downloadUrl);
      sound.success();
      showToast(`Received and downloaded: ${file.name}`, 'success');

    } catch (e) {
      console.error('[File Complete Assembly Error]', e);
      showToast('Failed to reconstruct file: ' + e.message, 'error');
    } finally {
      delete state.incomingFiles[data.fileId];
    }
  }

  function handleIncomingFileCancel(data) {
    if (state.incomingFiles[data.fileId]) {
      delete state.incomingFiles[data.fileId];
    }
    hideFileProgress();
    showToast('File transfer was cancelled by partner.', 'info');
  }

  async function handleRemoteIceRestartRequest() {
    if (!state.isHost) return;
    const pc = state.activeCall && state.activeCall.peerConnection;
    if (!pc) return;
    try {
      console.log('[OmniCast] Partner requested ICE restart. Re-negotiating...');
      showToast('Re-negotiating connection (ICE Restart)...', 'info');
      const offer = await pc.createOffer({ iceRestart: true });
      await pc.setLocalDescription(offer);
    } catch (e) {
      console.warn('[ICE Restart Error]', e);
    }
  }

  function triggerAdaptiveQualityDowngrade() {
    const sel = $('selectQuality');
    if (!sel) return;
    const current = sel.value;
    let next = current;
    if (current === 'auto' || current === '1080p') next = '720p';
    else if (current === '720p') next = '480p';

    if (next !== current) {
      sel.value = next;
      sel.dispatchEvent(new Event('change'));
      showToast(`Network congestion detected. Scaled down to ${next.toUpperCase()}`, 'warning');
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
      const clientX = (e.touches && e.touches[0]) ? e.touches[0].clientX :
                      (e.changedTouches && e.changedTouches[0]) ? e.changedTouches[0].clientX : e.clientX;
      const clientY = (e.touches && e.touches[0]) ? e.touches[0].clientY :
                      (e.changedTouches && e.changedTouches[0]) ? e.changedTouches[0].clientY : e.clientY;

      const rect = video.getBoundingClientRect();
      const vWidth = video.videoWidth || rect.width;
      const vHeight = video.videoHeight || rect.height;

      let renderWidth = rect.width;
      let renderHeight = rect.height;
      let offsetX = 0;
      let offsetY = 0;

      if (state.scalingMode === 'fit' && vWidth > 0 && vHeight > 0 && rect.width > 0 && rect.height > 0) {
        const videoRatio = vWidth / vHeight;
        const elemRatio = rect.width / rect.height;

        if (elemRatio > videoRatio) {
          // Viewport is wider than stream -> pillarboxed (black letterbox bars on left & right)
          renderHeight = rect.height;
          renderWidth = rect.height * videoRatio;
          offsetX = (rect.width - renderWidth) / 2;
          offsetY = 0;
        } else {
          // Viewport is taller than stream -> letterboxed (black letterbox bars on top & bottom)
          renderWidth = rect.width;
          renderHeight = rect.width / videoRatio;
          offsetX = 0;
          offsetY = (rect.height - renderHeight) / 2;
        }
      } else if (state.scalingMode === 'original' && vWidth > 0 && vHeight > 0) {
        renderWidth = vWidth;
        renderHeight = vHeight;
        offsetX = Math.max(0, (rect.width - renderWidth) / 2);
        offsetY = Math.max(0, (rect.height - renderHeight) / 2);
      } else {
        // 'stretch': fills entire rect
        renderWidth = rect.width;
        renderHeight = rect.height;
        offsetX = 0;
        offsetY = 0;
      }

      const relX = clientX - (rect.left + offsetX);
      const relY = clientY - (rect.top + offsetY);

      const clampedX = Math.max(0, Math.min(renderWidth, relX));
      const clampedY = Math.max(0, Math.min(renderHeight, relY));

      const pctX = renderWidth > 0 ? clampedX / renderWidth : 0;
      const pctY = renderHeight > 0 ? clampedY / renderHeight : 0;

      return {
        pctX: Math.max(0, Math.min(1, +pctX.toFixed(5))),
        pctY: Math.max(0, Math.min(1, +pctY.toFixed(5))),
        clientX,
        clientY
      };
    }

    // Prevent context menu on remote canvas so right clicks pass cleanly
    container.addEventListener('contextmenu', (e) => {
      e.preventDefault();
    });

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

    container.addEventListener('dblclick', (e) => {
      if (!state.activeConn) return;
      const coords = getRelativeCoordinates(e);
      state.activeConn.send({
        type: 'double-click',
        button: e.button,
        x: coords.pctX,
        y: coords.pctY
      });
    });

    // Touch support for Mobile / Tablet touch interaction
    container.addEventListener('touchstart', (e) => {
      if (video && video.paused) {
        video.play().catch(() => {});
      }
      if (!state.activeConn) return;
      const coords = getRelativeCoordinates(e);

      if (state.mode === 'laser') {
        state.laserX = coords.clientX;
        state.laserY = coords.clientY;
      }
      addClickRipple(coords.clientX, coords.clientY, state.mode === 'laser' ? '#ef4444' : '#38bdf8');

      state.activeConn.send({
        type: state.mode === 'laser' ? 'laser' : 'mouse-down',
        button: 0,
        x: coords.pctX,
        y: coords.pctY
      });
    }, { passive: true });

    container.addEventListener('touchmove', (e) => {
      if (!state.activeConn) return;
      const coords = getRelativeCoordinates(e);

      if (state.mode === 'laser') {
        state.laserX = coords.clientX;
        state.laserY = coords.clientY;
      }

      const now = performance.now();
      if (now - lastMoveTime < 16) return;
      lastMoveTime = now;

      state.activeConn.send({
        type: state.mode === 'laser' ? 'laser' : 'mouse-move',
        x: coords.pctX,
        y: coords.pctY
      });
    }, { passive: true });

    container.addEventListener('touchend', (e) => {
      if (state.mode === 'laser') {
        state.laserX = -1;
        state.laserY = -1;
      }
      if (!state.activeConn) return;
      const coords = getRelativeCoordinates(e);
      state.activeConn.send({
        type: 'mouse-up',
        button: 0,
        x: coords.pctX,
        y: coords.pctY
      });
    }, { passive: true });

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

    // Keyboard events with browser shortcut protection
    window.addEventListener('keydown', (e) => {
      if (state.isDrawerOpen || document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') return;
      if (!state.activeConn) return;
      if (e.key === 'F11') return;

      const isCtrlOrMeta = e.ctrlKey || e.metaKey;
      if (
        e.key === 'Tab' || 
        e.key === 'Backspace' || 
        (isCtrlOrMeta && ['s', 'w', 'o', 'p', 'f', 't', 'n', 'r'].includes(e.key.toLowerCase())) ||
        e.key === 'F5'
      ) {
        e.preventDefault();
      }

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
    cursor.classList.toggle('cursor-laser-mode', isLaser);

    const tag = $('remoteCursorTag');
    if (tag) {
      tag.textContent = isLaser ? '🔴 Laser' : 'Remote Partner';
      tag.style.background = isLaser ? '#ef4444' : '#2563eb';
    }
    const icon = cursor.querySelector('svg');
    if (icon) {
      icon.setAttribute('fill', isLaser ? '#ef4444' : '#2563eb');
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

  let isBridgeRelayInFlight = false;
  let pendingBridgeMoveEvent = null;

  async function relayInputToHostBridge(eventData) {
    if (!state.hasServerApi) return;

    // Coalesce high-frequency mouse movements to prevent HTTP socket congestion
    if (eventData.type === 'mouse-move' || eventData.type === 'laser') {
      if (isBridgeRelayInFlight) {
        pendingBridgeMoveEvent = eventData;
        return;
      }
      isBridgeRelayInFlight = true;
    }

    try {
      await fetch('/api/host-input', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: eventData })
      });
    } catch (e) {
    } finally {
      if (eventData.type === 'mouse-move' || eventData.type === 'laser') {
        isBridgeRelayInFlight = false;
        if (pendingBridgeMoveEvent) {
          const next = pendingBridgeMoveEvent;
          pendingBridgeMoveEvent = null;
          relayInputToHostBridge(next);
        }
      }
    }
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

  function setupFloatingToolbar() {
    const toolbar = $('sessionToolbar');
    const dragHandle = $('toolbarDragHandle');
    const btnMinimize = $('btnMinimizeToolbar');
    if (!toolbar) return;

    let isDragging = false;
    let startX = 0;
    let startY = 0;
    let initialLeft = 0;
    let initialTop = 0;
    let hasCustomPosition = false;

    // Minimize / Expand Floating Bar Toggle
    if (btnMinimize) {
      on(btnMinimize, 'click', (e) => {
        e.stopPropagation();
        const isMin = toolbar.classList.toggle('toolbar-minimized');
        btnMinimize.innerHTML = isMin 
          ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>'
          : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="5" y1="12" x2="19" y2="12"></line></svg>';
        btnMinimize.title = isMin ? 'Expand Toolbar' : 'Minimize Toolbar';
      });
    }

    function onDragStart(e) {
      const target = e.target;
      // Allow normal click interaction on interactive elements
      if (
        !dragHandle.contains(target) && (
          target.tagName === 'BUTTON' || 
          target.tagName === 'SELECT' || 
          target.tagName === 'INPUT' || 
          target.closest('button') || 
          target.closest('select') || 
          target.closest('input') ||
          target.closest('#keysDropdown')
        )
      ) {
        return;
      }

      const clientX = (e.touches && e.touches[0]) ? e.touches[0].clientX : e.clientX;
      const clientY = (e.touches && e.touches[0]) ? e.touches[0].clientY : e.clientY;

      isDragging = true;
      startX = clientX;
      startY = clientY;

      const rect = toolbar.getBoundingClientRect();
      initialLeft = rect.left;
      initialTop = rect.top;

      if (!hasCustomPosition) {
        toolbar.style.transform = 'none';
        toolbar.style.left = `${initialLeft}px`;
        toolbar.style.top = `${initialTop}px`;
        hasCustomPosition = true;
      }

      toolbar.classList.add('is-dragging');
      document.body.style.userSelect = 'none';
    }

    function onDragMove(e) {
      if (!isDragging) return;
      if (e.cancelable) e.preventDefault();

      const clientX = (e.touches && e.touches[0]) ? e.touches[0].clientX : e.clientX;
      const clientY = (e.touches && e.touches[0]) ? e.touches[0].clientY : e.clientY;

      const deltaX = clientX - startX;
      const deltaY = clientY - startY;

      let newLeft = initialLeft + deltaX;
      let newTop = initialTop + deltaY;

      // Viewport boundary clamping with 12px margin
      const tbWidth = toolbar.offsetWidth;
      const tbHeight = toolbar.offsetHeight;
      const maxLeft = window.innerWidth - tbWidth - 12;
      const maxTop = window.innerHeight - tbHeight - 12;

      newLeft = Math.max(12, Math.min(maxLeft, newLeft));
      newTop = Math.max(12, Math.min(maxTop, newTop));

      toolbar.style.left = `${newLeft}px`;
      toolbar.style.top = `${newTop}px`;
    }

    function onDragEnd() {
      if (!isDragging) return;
      isDragging = false;
      toolbar.classList.remove('is-dragging');
      document.body.style.userSelect = '';

      const rect = toolbar.getBoundingClientRect();
      initialLeft = rect.left;
      initialTop = rect.top;
    }

    toolbar.addEventListener('mousedown', onDragStart);
    window.addEventListener('mousemove', onDragMove, { passive: false });
    window.addEventListener('mouseup', onDragEnd);

    toolbar.addEventListener('touchstart', onDragStart, { passive: true });
    window.addEventListener('touchmove', onDragMove, { passive: false });
    window.addEventListener('touchend', onDragEnd);

    window.addEventListener('resize', () => {
      if (!hasCustomPosition) return;
      const rect = toolbar.getBoundingClientRect();
      const maxLeft = window.innerWidth - rect.width - 12;
      const maxTop = window.innerHeight - rect.height - 12;
      if (rect.left > maxLeft) toolbar.style.left = `${Math.max(12, maxLeft)}px`;
      if (rect.top > maxTop) toolbar.style.top = `${Math.max(12, maxTop)}px`;
    });
  }

  function initUI() {
    updateCodeDisplay();
    initLaserCanvas();
    bindViewerInputEvents();
    setupFloatingToolbar();
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

    on($('textSenderInput'), 'keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const btn = $('btnSendTextToRemote');
        if (btn) btn.click();
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

    // 10. Aspect Ratio / 3-Way Scaling Toggle (Fit -> Stretch -> 1:1 Original)
    on($('btnToggleFit'), 'click', () => {
      const modes = ['fit', 'stretch', 'original'];
      const nextIdx = (modes.indexOf(state.scalingMode) + 1) % modes.length;
      state.scalingMode = modes[nextIdx];
      const video = $('remoteVideo');
      const label = $('fitLabel');
      if (video) {
        video.classList.remove('fit-contain', 'fit-stretch', 'fit-original');
        video.classList.add(`fit-${state.scalingMode}`);
      }
      const labels = { fit: 'Fit', stretch: 'Stretch', original: '1:1' };
      if (label) label.textContent = labels[state.scalingMode] || 'Fit';
      showToast(`Display scaling: ${labels[state.scalingMode]}`, 'info');
    });

    // 11. Fullscreen Toggle with Keyboard Lock API
    on($('btnFullscreen'), 'click', async () => {
      const elem = $('sessionView');
      if (!document.fullscreenElement) {
        try {
          await elem.requestFullscreen();
          if (navigator.keyboard && navigator.keyboard.lock) {
            navigator.keyboard.lock(['Escape', 'AltLeft', 'AltRight', 'Tab', 'KeyW', 'KeyS']).catch(() => {});
          }
        } catch (e) {}
      } else {
        try {
          if (navigator.keyboard && navigator.keyboard.unlock) {
            navigator.keyboard.unlock();
          }
          await document.exitFullscreen();
        } catch (e) {}
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

    // 15. Drawer Tabs Switcher (Chat, Clipboard, Files)
    const tabs = [
      { btn: 'tabBtnChat', pane: 'tabPaneChat' },
      { btn: 'tabBtnClipboard', pane: 'tabPaneClipboard' },
      { btn: 'tabBtnFiles', pane: 'tabPaneFiles' }
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

    // File Transfer Picker & Drag-and-Drop
    on($('filePickerInput'), 'change', (e) => {
      if (e.target.files && e.target.files[0]) {
        sendFileOverDataChannel(e.target.files[0]);
        e.target.value = '';
      }
    });

    const dropZone = $('fileDropZone');
    if (dropZone) {
      ['dragenter', 'dragover'].forEach(name => {
        dropZone.addEventListener(name, (e) => {
          e.preventDefault();
          dropZone.classList.add('drag-active');
        });
      });
      ['dragleave', 'drop'].forEach(name => {
        dropZone.addEventListener(name, (e) => {
          e.preventDefault();
          dropZone.classList.remove('drag-active');
        });
      });
      dropZone.addEventListener('drop', (e) => {
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) {
          sendFileOverDataChannel(e.dataTransfer.files[0]);
        }
      });
    }

    // Unattended Access PIN Toggle & Input
    const unattendedToggle = $('unattendedToggle');
    const unattendedPinInput = $('unattendedPinInput');
    const unattendedBox = $('unattendedPinBox');
    if (unattendedToggle) {
      on(unattendedToggle, 'change', (e) => {
        state.unattendedEnabled = e.target.checked;
        if (unattendedBox) unattendedBox.classList.toggle('hidden', !state.unattendedEnabled);
        if (state.unattendedEnabled && unattendedPinInput) {
          unattendedPinInput.focus();
        }
      });
    }
    if (unattendedPinInput) {
      on(unattendedPinInput, 'input', (e) => {
        state.unattendedPin = e.target.value.trim();
        sessionStorage.setItem('omnicast_unattended_pin', state.unattendedPin);
      });
      if (state.unattendedPin) {
        unattendedPinInput.value = state.unattendedPin;
      }
    }

    // Granular Permissions Checkboxes
    const permAudio = $('permAudio');
    if (permAudio) on(permAudio, 'change', (e) => { state.permissions.allowAudio = e.target.checked; });
    const permPointer = $('permPointer');
    if (permPointer) on(permPointer, 'change', (e) => { state.permissions.allowPointer = e.target.checked; });
    const permClipboard = $('permClipboard');
    if (permClipboard) on(permClipboard, 'change', (e) => { state.permissions.allowClipboard = e.target.checked; });
    const permFileTransfer = $('permFileTransfer');
    if (permFileTransfer) on(permFileTransfer, 'change', (e) => { state.permissions.allowFileTransfer = e.target.checked; });
    const permNative = $('permNativeControl');
    if (permNative) on(permNative, 'change', (e) => { state.permissions.nativeOsControl = e.target.checked; });

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
