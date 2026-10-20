/**
 * OmniCast - Ultra-Low Latency WebRTC Remote Desktop
 * High-Performance Signaling Server & Host OS Input Bridge
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const cors = require('cors');
const nativeController = require('./native-controller');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  pingInterval: 10000,
  pingTimeout: 5000
});

const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// In-Memory Room Registry: code -> { hostSocketId, pin, permissions, viewerSocketId, createdAt }
const activeRooms = new Map();
// Socket to Code mapping: socketId -> { role: 'host' | 'viewer', code }
const socketDirectory = new Map();

// Normalize 9-digit code (remove spaces, hyphens)
function normalizeCode(rawCode) {
  if (!rawCode) return '';
  return String(rawCode).replace(/[\s-]/g, '').trim();
}

// REST Endpoints
app.get('/api/status', (req, res) => {
  res.json({
    status: 'online',
    appName: 'OmniCast',
    version: '1.0.0',
    activeHosts: activeRooms.size,
    osControlAvailable: nativeController.isReady,
    platform: nativeController.platform,
    screenMetrics: {
      width: nativeController.screenWidth,
      height: nativeController.screenHeight
    }
  });
});

// Host Browser Input Relay Endpoint (when Host forwards DataChannel input to OS)
app.post('/api/host-input', (req, res) => {
  try {
    const { event } = req.body;
    if (event) {
      nativeController.handleEvent(event);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Socket.io Real-time Signaling
io.on('connection', (socket) => {
  console.log(`[Socket] Connected: ${socket.id}`);

  // 1. Host registers their 9-digit code
  socket.on('register-host', ({ code, pin, permissions }, callback) => {
    const cleanCode = normalizeCode(code);
    if (!cleanCode || cleanCode.length !== 9) {
      if (callback) callback({ success: false, error: 'Invalid 9-digit access code' });
      return;
    }

    // Clean up any old registration for this socket
    const existing = socketDirectory.get(socket.id);
    if (existing && existing.role === 'host') {
      activeRooms.delete(existing.code);
    }

    activeRooms.set(cleanCode, {
      hostSocketId: socket.id,
      pin: pin ? String(pin).trim() : null,
      permissions: permissions || {
        allowControl: true,
        allowAudio: true,
        allowFileTransfer: true,
        allowClipboard: true,
        nativeOsControl: false
      },
      viewerSocketId: null,
      createdAt: Date.now()
    });

    socketDirectory.set(socket.id, { role: 'host', code: cleanCode });
    socket.join(cleanCode);

    console.log(`[Host Registered] Code: ${cleanCode} (Socket: ${socket.id})`);
    if (callback) callback({ success: true, code: cleanCode });
  });

  // 2. Viewer requests connection to Host via 9-digit code
  socket.on('request-connection', ({ code, pin, clientInfo }, callback) => {
    const cleanCode = normalizeCode(code);
    if (!cleanCode || cleanCode.length !== 9) {
      if (callback) callback({ success: false, error: 'Please enter a valid 9-digit Access Code.' });
      return;
    }

    const room = activeRooms.get(cleanCode);
    if (!room) {
      if (callback) callback({ success: false, error: 'Remote Desk is offline or code is invalid. Check the code and try again.' });
      return;
    }

    if (room.hostSocketId === socket.id) {
      if (callback) callback({ success: false, error: 'Cannot connect to your own desk from the same browser session.' });
      return;
    }

    if (room.viewerSocketId && room.viewerSocketId !== socket.id) {
      if (callback) callback({ success: false, error: 'Remote Desk is currently in an active session with another user.' });
      return;
    }

    // Verify PIN if host set one
    if (room.pin && room.pin !== String(pin).trim()) {
      if (callback) callback({ success: false, error: 'Invalid Security PIN for this Remote Desk.' });
      return;
    }

    socketDirectory.set(socket.id, { role: 'viewer', code: cleanCode });
    socket.join(cleanCode);

    // Notify Host of incoming request
    io.to(room.hostSocketId).emit('incoming-connection-request', {
      viewerSocketId: socket.id,
      clientInfo: clientInfo || { userAgent: 'Web Browser', ip: socket.handshake.address }
    });

    console.log(`[Connection Requested] Viewer ${socket.id} -> Host ${room.hostSocketId} for room ${cleanCode}`);
    if (callback) callback({ success: true, waitingForHost: true });
  });

  // 3. Host accepts or rejects incoming request
  socket.on('respond-connection', ({ viewerSocketId, accepted, reason, updatedPermissions }) => {
    const info = socketDirectory.get(socket.id);
    if (!info || info.role !== 'host') return;

    const room = activeRooms.get(info.code);
    if (!room || room.hostSocketId !== socket.id) return;

    if (!accepted) {
      console.log(`[Host Rejected] Host ${socket.id} rejected viewer ${viewerSocketId}. Reason: ${reason}`);
      io.to(viewerSocketId).emit('connection-rejected', {
        reason: reason || 'Host declined the connection request.'
      });
      return;
    }

    // Accepted
    room.viewerSocketId = viewerSocketId;
    if (updatedPermissions) {
      room.permissions = { ...room.permissions, ...updatedPermissions };
    }

    console.log(`[Host Accepted] Host ${socket.id} accepted viewer ${viewerSocketId} with permissions:`, room.permissions);

    // Send accept notification to viewer with approved permissions
    io.to(viewerSocketId).emit('connection-accepted', {
      hostSocketId: socket.id,
      permissions: room.permissions
    });

    // Notify host to get display stream ready and start WebRTC handshake
    socket.emit('session-started', {
      viewerSocketId,
      permissions: room.permissions
    });
  });

  // 4. WebRTC Signaling Relays (Offer, Answer, ICE Candidates)
  socket.on('webrtc-offer', ({ targetSocketId, offer }) => {
    io.to(targetSocketId).emit('webrtc-offer', {
      senderSocketId: socket.id,
      offer
    });
  });

  socket.on('webrtc-answer', ({ targetSocketId, answer }) => {
    io.to(targetSocketId).emit('webrtc-answer', {
      senderSocketId: socket.id,
      answer
    });
  });

  socket.on('webrtc-ice-candidate', ({ targetSocketId, candidate }) => {
    io.to(targetSocketId).emit('webrtc-ice-candidate', {
      senderSocketId: socket.id,
      candidate
    });
  });

  // 5. Host or Viewer terminates session manually
  socket.on('end-session', ({ reason }) => {
    const info = socketDirectory.get(socket.id);
    if (!info) return;

    const room = activeRooms.get(info.code);
    if (!room) return;

    console.log(`[Session Ended] Triggered by ${socket.id} (${info.role}). Reason: ${reason}`);

    if (info.role === 'host') {
      if (room.viewerSocketId) {
        io.to(room.viewerSocketId).emit('session-terminated', {
          by: 'host',
          reason: reason || 'Host ended the remote session.'
        });
      }
      room.viewerSocketId = null;
    } else if (info.role === 'viewer') {
      io.to(room.hostSocketId).emit('session-terminated', {
        by: 'viewer',
        reason: reason || 'Viewer disconnected from remote desk.'
      });
      room.viewerSocketId = null;
    }
  });

  // 6. Direct Input Event Relay via Socket (optional backup when data channel is re-establishing)
  socket.on('relay-input', (eventData) => {
    const info = socketDirectory.get(socket.id);
    if (!info || info.role !== 'viewer') return;

    const room = activeRooms.get(info.code);
    if (!room || !room.hostSocketId) return;

    // Send to host browser
    io.to(room.hostSocketId).emit('remote-input-event', eventData);

    // If host allows native OS control, dispatch directly
    if (room.permissions && room.permissions.nativeOsControl) {
      nativeController.handleEvent(eventData);
    }
  });

  // 7. Disconnect cleanup
  socket.on('disconnect', () => {
    console.log(`[Socket] Disconnected: ${socket.id}`);
    const info = socketDirectory.get(socket.id);
    if (!info) return;

    const room = activeRooms.get(info.code);
    if (room) {
      if (info.role === 'host' && room.hostSocketId === socket.id) {
        if (room.viewerSocketId) {
          io.to(room.viewerSocketId).emit('session-terminated', {
            by: 'host',
            reason: 'Host closed their session or lost network connection.'
          });
        }
        activeRooms.delete(info.code);
        console.log(`[Room Cleaned] Code: ${info.code}`);
      } else if (info.role === 'viewer' && room.viewerSocketId === socket.id) {
        io.to(room.hostSocketId).emit('session-terminated', {
          by: 'viewer',
          reason: 'Remote viewer disconnected.'
        });
        room.viewerSocketId = null;
      }
    }

    socketDirectory.delete(socket.id);
  });
});

// Graceful cleanup
process.on('SIGINT', () => {
  console.log('\n[OmniCast] Shutting down gracefully...');
  nativeController.destroy();
  process.exit(0);
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log('====================================================');
    console.log('   OmniCast - Ultra-Low Latency WebRTC Remote Desk  ');
    console.log('====================================================');
    console.log(`🚀 Server running at: http://localhost:${PORT}`);
    console.log(`📡 Native OS Input Bridge: ${nativeController.isReady ? 'ACTIVE' : 'STANDBY'}`);
    console.log('====================================================');
  });
}

module.exports = app;
