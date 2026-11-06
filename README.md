# OmniCast — Ultra-Fast WebRTC Remote Desktop

<div align="center">
  <img src="logo.png" alt="OmniCast Logo" width="120" style="border-radius: 18px; margin-bottom: 12px;">
  
  <h3>Real-Time, Browser-Based Remote Desktop Powered by WebRTC & Node.js</h3>
  <p>Ultra-low latency browser-to-browser screen viewing, live mouse & keyboard input control, laser pointer, real-time chat, and chunked file transfer — AnyDesk experience directly in your browser.</p>

  <p>
    <a href="https://vercel.com"><img src="https://img.shields.io/badge/Deploy%20on-Vercel-black?style=flat&logo=vercel" alt="Deploy to Vercel"></a>
    <img src="https://img.shields.io/badge/WebRTC-P2P%20Mesh-blue" alt="WebRTC P2P">
    <img src="https://img.shields.io/badge/FPS-60%20FPS-green" alt="60 FPS">
    <img src="https://img.shields.io/badge/License-MIT-purple" alt="License MIT">
  </p>
</div>

---

## 🌟 Key Capabilities

- **Ultra-Low Latency 60 FPS Video**: Hardware-accelerated WebRTC media streaming (`navigator.mediaDevices.getDisplayMedia`) with audio capture.
- **6-Digit Desk Code**: Instant, AnyDesk-style `XXX XXX` numerical connection code (e.g. `482 910`) with 1-click copy.
- **Two-Way Consent Protection**: Hosts see an incoming request modal with partner code before sharing.
- **Full Mouse & Keyboard Remote Control**:
  - Live normalized pointer coordinates with letterbox compensation and stretch mode.
  - Left, right (context menu), and double clicks.
  - Smooth scroll wheel relay.
  - Full keyboard keystroke forwarding (alphanumeric, arrows, Backspace, Enter, Tab, shortcuts).
  - Window-level drag safety (no stuck mouse buttons when dragging outside video container).
- **Special System Keys & String Injection**:
  - `Ctrl + Alt + Del` (Ctrl+Shift+Esc Task Manager invocation).
  - Windows Key (`Win`).
  - `Alt + Tab` application switcher.
  - Remote text typer to send entire strings or clipboard snippets.
- **Native OS Input Bridge (Node.js)**:
  - When running locally via `server.js` or `start.bat`, Windows host receives physical OS cursor & keyboard simulation via low-overhead user32.dll P/Invoke.
- **Visual Presentation & Laser Pointer**:
  - Interactive laser pointer mode with dynamic glowing beacon and click ripple effects.
  - On-screen remote cursor tag and HUD notifications for remote typing.
- **Built-in Real-Time Chat & File Transfer**:
  - Floating bi-directional live chat drawer with unread counters.
  - P2P 64KB chunked file transfer with live progress bar and automatic file download.
- **Modern Clean UI**:
  - Sleek linear-inspired theme with 1-click Light / Dark theme toggle.
  - Bottom floating pill toolbar with fit/stretch toggle, audio mute, fullscreen, and latency RTT monitor.

---

## 🚀 Live Deployment to Vercel

OmniCast is configured for instant, 1-click live deployment on **Vercel** with zero backend infrastructure required:

1. Push this repository to your GitHub account:
   ```bash
   git add .
   git commit -m "feat: complete functional WebRTC remote desktop for Vercel"
   git push origin main
   ```
2. Go to [Vercel Dashboard](https://vercel.com/new) and click **Import Git Repository**.
3. Select `omni-cast` (or `Radhey-Bhadja/omni-cast`).
4. Keep the default settings:
   - **Framework Preset**: `Other`
   - **Root Directory**: `./`
   - **Build Command**: Leave default
   - **Output Directory**: Leave default
5. Click **Deploy**.

Your WebRTC Remote Desktop is immediately live on your Vercel URL!

---

## 💻 Running Locally with Node.js & Windows OS Control

To run locally with the active Windows OS Mouse & Keyboard Controller:

```bash
# 1. Install dependencies
npm install

# 2. Launch the server
npm start
# or on Windows simply double click:
# start.bat
```

Open `http://localhost:3000` in your browser. The native Windows controller automatically initializes (`user32.dll` via PowerShell P/Invoke).

---

## 📖 How to Use

1. **Host Computer (Share Screen)**:
   - Open OmniCast.
   - Note your 6-digit code in the **This Desk** card (e.g. `482 910`) and click **Copy Code**.
2. **Viewer Computer (Control Partner)**:
   - Open OmniCast in another computer, browser window, or mobile device.
   - Enter your partner's 6-digit code in **Remote Desk** and click **Connect Now**.
3. **Approve Connection**:
   - Host receives an alert modal: *"Your partner wants to view and control your screen"*.
   - Click **Yes, Allow Control** and choose your screen, window, or tab.
4. **Active Session**:
   - Remote screen displays instantly at 60 FPS.
   - Use the bottom floating toolbar to toggle **Control** or **Laser**, send **Keys ⌨️**, open **Chat**, or drop **Files**.

---

## 🛠️ Architecture

```
OmniCast/
├── index.html            # Primary single-page web app (light & dark theme)
├── css/style.css         # AnyDesk-grade styles & responsive layout
├── js/
│   ├── app.js            # WebRTC PeerJS engine, DataChannel input, laser, chat & files
│   └── peerjs.min.js     # Bundled PeerJS library fallback
├── api/
│   ├── index.js          # Vercel serverless entrypoint
│   ├── status.js         # Health check & environment status endpoint
│   └── host-input.js     # Serverless input relay endpoint
├── public/               # Static distribution directory (mirrored)
├── server.js             # Node.js Express & Socket.io server + host input relay
├── native-controller.js  # Windows OS user32.dll P/Invoke mouse & keyboard bridge
├── start.bat             # 1-click Windows starter script
├── vercel.json           # Vercel routing, CORS headers & clean URLs configuration
└── package.json          # Node.js project manifest & scripts
```

---

## 📄 License

MIT License © 2026 OmniCast Team
