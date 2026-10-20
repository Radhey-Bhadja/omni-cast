# OmniCast — Browser-to-Browser Remote Desktop

<div align="center">
  <img src="public/logo.png" alt="OmniCast Logo" width="140" style="border-radius: 18px; margin-bottom: 14px;">
  
  <h3>Ultra-Low Latency Peer-to-Peer Screen Streaming</h3>
  <p>A clean, human-crafted remote screen viewer powered by WebRTC and PeerJS with public Google STUN servers. Connect two real computers across different networks with a simple 6-digit Desk ID.</p>

  <p><b>Live-ready for Vercel, Netlify, Cloudflare Pages, or Local Node.js</b></p>
</div>

---

## ✨ Features

- **Direct P2P Screen Capture**: Stream screens at 60 FPS directly between browsers using `navigator.mediaDevices.getDisplayMedia`.
- **Zero Server Dependency**: PeerJS signaling with Google STUN servers (`stun:stun.l.google.com:19302`) eliminates the need for stateful WebSocket backends.
- **6-Digit Desk ID**: Clean `XXX-XXX` numerical codes (e.g., `482-910`) for 1-click connection.
- **Consent Verification**: Hosts receive an interactive popup modal ("Accept Connection & Share Screen") before any video stream begins.
- **Remote Laser Pointer**: Real-time laser pointer and click ripple effects relayed over an unordered low-latency `RTCDataChannel`.
- **Live Text Chat**: Embedded bi-directional chat drawer with unread message badges.
- **Chunked File Transfer**: High-speed P2P 64KB file transfers with progress bars and auto-download.
- **Clean Aesthetic UI**: Minimalist slate design inspired by Linear and CleanShot with zero AI clutter or fake buttons.

---

## 🚀 Live Deployment to Vercel (1-Click Ready)

1. Push this repository to GitHub:
   ```bash
   git add .
   git commit -m "feat: live-ready PeerJS WebRTC remote desktop with 6-digit Desk IDs"
   git push origin main
   ```
2. In the [Vercel Dashboard](https://vercel.com/new), click **Import Repository**.
3. Keep default settings (Framework: **Other**, Root Directory: `./`).
4. Click **Deploy**.

Your app is live with zero backend configuration needed!

---

## 💻 Running Locally

```bash
npm install
npm start
```
Open [`http://localhost:3000`](http://localhost:3000) in your browser.

---

## 📖 How to Use

1. **Host Computer**:
   - Open OmniCast.
   - Note your 6-digit Desk Code (e.g. `482-910`) and click **Copy Code**.
2. **Viewer Computer**:
   - Open OmniCast on another computer or browser tab.
   - Enter your partner's 6-digit code in **Connect to a Computer** and click **Connect Now**.
3. **Approval**:
   - An incoming connection popup appears on the Host screen.
   - Click **Accept & Share Screen** and pick your screen or application window.
4. **Live Session**:
   - The viewer sees the live 60 FPS remote screen.
   - Use the bottom floating toolbar to toggle the Remote Laser Pointer, open the Live Chat drawer, send files, or toggle fullscreen.
