/**
 * OmniCast — Production React/Next.js WebRTC Remote Desktop Hook
 * Manages RTCPeerConnection lifecycle, RTCDataChannel multiplexing,
 * displayMedia screen capture, live WebRTC stats polling,
 * and shared clipboard synchronization.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  DataChannelPacket,
  SessionPermissions,
  ChatMessage,
  DATA_CHANNEL_CONFIG,
  encodePacket,
  decodePacket
} from '../protocol/dataChannelProtocol';

export type ConnectionState =
  | 'idle'
  | 'connecting'
  | 'waiting-approval'
  | 'connected'
  | 'disconnected'
  | 'error';

export interface WebRTCStats {
  rtt: number;
  fps: number;
  bitrate: string;
  resolution: string;
}

export interface UseWebRTCOptions {
  iceServers?: RTCIceServer[];
  signalingUrl?: string;
  onRemoteTrack?: (track: MediaStreamTrack, stream: MediaStream) => void;
  onIncomingRequest?: (callerId: string, clientInfo?: any) => void;
}

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:global.stun.twilio.com:3478' }
];

export function useWebRTC(options: UseWebRTCOptions = {}) {
  const [connectionState, setConnectionState] = useState<ConnectionState>('idle');
  const [myId, setMyId] = useState<string>('');
  const [remoteId, setRemoteId] = useState<string | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [stats, setStats] = useState<WebRTCStats>({ rtt: 0, fps: 0, bitrate: '0 kbps', resolution: '--' });
  const [clipboardText, setClipboardText] = useState<string>('');
  
  const [permissions, setPermissions] = useState<SessionPermissions>({
    allowAudio: true,
    allowPointer: true,
    allowClipboard: true,
    nativeOsControl: true
  });

  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const statsIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const prevBytesRef = useRef<number>(0);
  const prevTimeRef = useRef<number>(0);

  // Generate readable 9-digit session ID (e.g. 482 910 334)
  useEffect(() => {
    const raw = String(Math.floor(100000000 + Math.random() * 900000000));
    setMyId(raw);
  }, []);

  // Setup RTCPeerConnection
  const createPeerConnection = useCallback(() => {
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
    }

    const pc = new RTCPeerConnection({
      iceServers: options.iceServers || DEFAULT_ICE_SERVERS,
      iceCandidatePoolSize: 4
    });

    pc.oniceconnectionstatechange = () => {
      console.log('[WebRTC ICE State]', pc.iceConnectionState);
      if (pc.iceConnectionState === 'connected') {
        setConnectionState('connected');
        startStatsPolling(pc);
      } else if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') {
        setConnectionState('disconnected');
        stopStatsPolling();
      }
    };

    pc.ontrack = (event) => {
      console.log('[WebRTC ontrack]', event.track.kind);
      const stream = event.streams[0] || new MediaStream([event.track]);
      setRemoteStream(stream);
      if (options.onRemoteTrack) {
        options.onRemoteTrack(event.track, stream);
      }
    };

    peerConnectionRef.current = pc;
    return pc;
  }, [options]);

  // Bind DataChannel message handlers
  const setupDataChannelEvents = useCallback((channel: RTCDataChannel) => {
    dataChannelRef.current = channel;

    channel.onopen = () => {
      console.log('[RTCDataChannel Opened]');
    };

    channel.onmessage = (event) => {
      const packet = decodePacket(event.data);
      if (!packet) return;

      switch (packet.type) {
        case 'chat':
          setChatMessages((prev) => [...prev, packet]);
          break;
        case 'clipboard-push':
          setClipboardText(packet.text);
          if (navigator.clipboard?.writeText) {
            navigator.clipboard.writeText(packet.text).catch(() => {});
          }
          break;
        case 'session-end':
          disconnect();
          break;
        default:
          break;
      }
    };

    channel.onclose = () => {
      console.log('[RTCDataChannel Closed]');
    };
  }, []);

  // Start Screen Capture (Host Flow)
  const startScreenShare = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          cursor: 'always',
          displaySurface: 'monitor',
          frameRate: { ideal: 60, max: 60 },
          width: { ideal: 1920 },
          height: { ideal: 1080 }
        },
        audio: permissions.allowAudio,
        // @ts-ignore
        selfBrowserSurface: 'exclude',
        surfaceSwitching: 'include'
      });

      setLocalStream(stream);
      const pc = createPeerConnection();

      // Add tracks to RTCPeerConnection
      stream.getTracks().forEach((track) => {
        pc.addTrack(track, stream);
        track.onended = () => disconnect();
      });

      // Host creates DataChannel
      const dc = pc.createDataChannel(DATA_CHANNEL_CONFIG.label, {
        ordered: DATA_CHANNEL_CONFIG.ordered,
        maxRetransmits: DATA_CHANNEL_CONFIG.maxRetransmits
      });
      setupDataChannelEvents(dc);

      return stream;
    } catch (err) {
      console.error('[Failed to get display media]', err);
      throw err;
    }
  }, [createPeerConnection, permissions.allowAudio, setupDataChannelEvents]);

  // Connect to Remote Peer (Viewer Flow)
  const connectToRemoteDesk = useCallback(async (targetId: string) => {
    setRemoteId(targetId);
    setConnectionState('connecting');

    const pc = createPeerConnection();

    // Viewer listens for incoming DataChannel
    pc.ondatachannel = (event) => {
      setupDataChannelEvents(event.channel);
    };

    setConnectionState('waiting-approval');
  }, [createPeerConnection, setupDataChannelEvents]);

  // Live WebRTC Stats Polling
  const startStatsPolling = useCallback((pc: RTCPeerConnection) => {
    stopStatsPolling();
    prevBytesRef.current = 0;
    prevTimeRef.current = performance.now();

    statsIntervalRef.current = setInterval(async () => {
      try {
        const reports = await pc.getStats();
        let rtt = 0;
        let fps = 0;
        let bitrate = '0 kbps';
        let resolution = '--';

        reports.forEach((report) => {
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
              resolution = `${report.frameWidth}x${report.frameHeight}`;
            }
            if (report.bytesReceived !== undefined) {
              const now = performance.now();
              const dt = (now - prevTimeRef.current) / 1000;
              if (dt > 0.5 && prevBytesRef.current > 0) {
                const bps = ((report.bytesReceived - prevBytesRef.current) * 8) / dt;
                bitrate = bps > 1000000 ? `${(bps / 1000000).toFixed(1)} Mbps` : `${Math.round(bps / 1000)} kbps`;
              }
              prevBytesRef.current = report.bytesReceived;
              prevTimeRef.current = now;
            }
          }
        });

        setStats({ rtt, fps, bitrate, resolution });
      } catch (e) {
        console.warn('[WebRTC Stats Error]', e);
      }
    }, 1000);
  }, []);

  const stopStatsPolling = useCallback(() => {
    if (statsIntervalRef.current) {
      clearInterval(statsIntervalRef.current);
      statsIntervalRef.current = null;
    }
  }, []);

  // Send packet over DataChannel
  const sendPacket = useCallback((packet: DataChannelPacket) => {
    if (dataChannelRef.current && dataChannelRef.current.readyState === 'open') {
      dataChannelRef.current.send(encodePacket(packet));
    }
  }, []);

  // Disconnect & Teardown
  const disconnect = useCallback(() => {
    stopStatsPolling();

    if (dataChannelRef.current) {
      try {
        sendPacket({ type: 'session-end', reason: 'Session closed' });
        dataChannelRef.current.close();
      } catch (e) {}
      dataChannelRef.current = null;
    }

    if (peerConnectionRef.current) {
      try {
        peerConnectionRef.current.close();
      } catch (e) {}
      peerConnectionRef.current = null;
    }

    if (localStream) {
      localStream.getTracks().forEach((t) => t.stop());
      setLocalStream(null);
    }

    setRemoteStream(null);
    setConnectionState('disconnected');
    setRemoteId(null);
  }, [localStream, sendPacket, stopStatsPolling]);

  return {
    connectionState,
    myId,
    remoteId,
    localStream,
    remoteStream,
    stats,
    chatMessages,
    clipboardText,
    permissions,
    setPermissions,
    startScreenShare,
    connectToRemoteDesk,
    disconnect,
    sendPacket,
    sendChatMessage: (text: string) => {
      const msg: ChatMessage = { type: 'chat', text, timestamp: Date.now(), from: 'You' };
      setChatMessages((prev) => [...prev, msg]);
      sendPacket(msg);
    },
    pushClipboard: (text: string) => {
      setClipboardText(text);
      sendPacket({ type: 'clipboard-push', text });
    }
  };
}
