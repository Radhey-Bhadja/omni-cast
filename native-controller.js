/**
 * OmniCast Native OS Input Controller
 * Simulates mouse & keyboard on the host OS via low-overhead persistent child process.
 * On Windows, leverages user32.dll via PowerShell P/Invoke (zero npm native build dependencies).
 */

const { spawn } = require('child_process');
const os = require('os');

class NativeController {
  constructor() {
    this.platform = os.platform();
    this.isWindows = this.platform === 'win32';
    this.process = null;
    this.screenWidth = 1920;
    this.screenHeight = 1080;
    this.isReady = false;
    this.init();
  }

  init() {
    if (!this.isWindows) {
      console.log(`[NativeController] Platform is ${this.platform}. Running in visual web-pointer mode.`);
      this.isReady = true;
      return;
    }

    try {
      // Spawn persistent PowerShell session with C# P/Invoke compiled in memory
      const psScript = `
$ErrorActionPreference = 'SilentlyContinue'
$source = @"
using System;
using System.Runtime.InteropServices;
public class WinInputHelper {
    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int X, int Y);

    [DllImport("user32.dll")]
    public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);

    [DllImport("user32.dll")]
    public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

    [DllImport("user32.dll")]
    public static extern int GetSystemMetrics(int nIndex);
}
"@
Add-Type -TypeDefinition $source

$w = [WinInputHelper]::GetSystemMetrics(0)
$h = [WinInputHelper]::GetSystemMetrics(1)
Write-Output "READY:$w,$h"

$MOUSEEVENTF_LEFTDOWN   = 0x0002
$MOUSEEVENTF_LEFTUP     = 0x0004
$MOUSEEVENTF_RIGHTDOWN  = 0x0008
$MOUSEEVENTF_RIGHTUP    = 0x0010
$MOUSEEVENTF_MIDDLEDOWN = 0x0020
$MOUSEEVENTF_MIDDLEUP   = 0x0040
$MOUSEEVENTF_WHEEL      = 0x0800

$KEYEVENTF_EXTENDEDKEY = 0x0001
$KEYEVENTF_KEYUP       = 0x0002

while($line = [Console]::ReadLine()) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    $parts = $line.Split(' ')
    $cmd = $parts[0]
    
    switch ($cmd) {
        "MOVE" {
            $x = [int]$parts[1]
            $y = [int]$parts[2]
            [WinInputHelper]::SetCursorPos($x, $y)
        }
        "MOVE_PCT" {
            $px = [double]$parts[1]
            $py = [double]$parts[2]
            $x = [int]($px * $w)
            $y = [int]($py * $h)
            [WinInputHelper]::SetCursorPos($x, $y)
        }
        "MDOWN" {
            $btn = [int]$parts[1]
            if ($btn -eq 0) { [WinInputHelper]::mouse_event($MOUSEEVENTF_LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero) }
            elseif ($btn -eq 2) { [WinInputHelper]::mouse_event($MOUSEEVENTF_RIGHTDOWN, 0, 0, 0, [UIntPtr]::Zero) }
            elseif ($btn -eq 1) { [WinInputHelper]::mouse_event($MOUSEEVENTF_MIDDLEDOWN, 0, 0, 0, [UIntPtr]::Zero) }
        }
        "MUP" {
            $btn = [int]$parts[1]
            if ($btn -eq 0) { [WinInputHelper]::mouse_event($MOUSEEVENTF_LEFTUP, 0, 0, 0, [UIntPtr]::Zero) }
            elseif ($btn -eq 2) { [WinInputHelper]::mouse_event($MOUSEEVENTF_RIGHTUP, 0, 0, 0, [UIntPtr]::Zero) }
            elseif ($btn -eq 1) { [WinInputHelper]::mouse_event($MOUSEEVENTF_MIDDLEUP, 0, 0, 0, [UIntPtr]::Zero) }
        }
        "WHEEL" {
            $delta = [int]$parts[1]
            [WinInputHelper]::mouse_event($MOUSEEVENTF_WHEEL, 0, 0, [uint]$delta, [UIntPtr]::Zero)
        }
        "KDOWN" {
            $vk = [byte]$parts[1]
            [WinInputHelper]::keybd_event($vk, 0, 0, [UIntPtr]::Zero)
        }
        "KUP" {
            $vk = [byte]$parts[1]
            [WinInputHelper]::keybd_event($vk, 0, $KEYEVENTF_KEYUP, [UIntPtr]::Zero)
        }
        "SPECIAL" {
            $action = $parts[1]
            if ($action -eq "CAD") {
                # Windows intercepts Ctrl+Alt+Del for security; Ctrl+Shift+Esc opens Task Manager
                [WinInputHelper]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero) # Ctrl
                [WinInputHelper]::keybd_event(0x10, 0, 0, [UIntPtr]::Zero) # Shift
                [WinInputHelper]::keybd_event(0x1B, 0, 0, [UIntPtr]::Zero) # Esc
                [WinInputHelper]::keybd_event(0x1B, 0, $KEYEVENTF_KEYUP, [UIntPtr]::Zero)
                [WinInputHelper]::keybd_event(0x10, 0, $KEYEVENTF_KEYUP, [UIntPtr]::Zero)
                [WinInputHelper]::keybd_event(0x11, 0, $KEYEVENTF_KEYUP, [UIntPtr]::Zero)
            } elseif ($action -eq "WIN") {
                [WinInputHelper]::keybd_event(0x5B, 0, 0, [UIntPtr]::Zero) # Win
                [WinInputHelper]::keybd_event(0x5B, 0, $KEYEVENTF_KEYUP, [UIntPtr]::Zero)
            } elseif ($action -eq "ALTTAB") {
                [WinInputHelper]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero) # Alt
                [WinInputHelper]::keybd_event(0x09, 0, 0, [UIntPtr]::Zero) # Tab
                [WinInputHelper]::keybd_event(0x09, 0, $KEYEVENTF_KEYUP, [UIntPtr]::Zero)
                [WinInputHelper]::keybd_event(0x12, 0, $KEYEVENTF_KEYUP, [UIntPtr]::Zero)
            }
        }
    }
}
`;

      this.process = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '-'], {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      this.process.stdin.write(psScript + '\n');

      this.process.stdout.on('data', (data) => {
        const str = data.toString();
        if (str.includes('READY:')) {
          const match = str.match(/READY:(\d+),(\d+)/);
          if (match) {
            this.screenWidth = parseInt(match[1], 10) || 1920;
            this.screenHeight = parseInt(match[2], 10) || 1080;
          }
          this.isReady = true;
          console.log(`[NativeController] Windows Input Bridge Ready (${this.screenWidth}x${this.screenHeight})`);
        }
      });

      this.process.stderr.on('data', (data) => {
        // Log errors only if needed
      });

      this.process.on('close', (code) => {
        this.isReady = false;
        console.log(`[NativeController] Child process exited with code ${code}`);
      });
    } catch (err) {
      console.warn('[NativeController] Failed to start native controller:', err.message);
      this.isReady = false;
    }
  }

  execute(command) {
    if (!this.isReady || !this.process || !this.process.stdin.writable) return;
    try {
      this.process.stdin.write(command + '\n');
    } catch (err) {
      // ignore write error
    }
  }

  handleEvent(payload) {
    if (!payload || typeof payload !== 'object') return;
    const { type } = payload;

    switch (type) {
      case 'mousemove':
        if (payload.xPercent !== undefined && payload.yPercent !== undefined) {
          this.execute(`MOVE_PCT ${payload.xPercent} ${payload.yPercent}`);
        } else if (payload.x !== undefined && payload.y !== undefined) {
          this.execute(`MOVE ${Math.round(payload.x)} ${Math.round(payload.y)}`);
        }
        break;

      case 'mousedown':
        this.execute(`MDOWN ${payload.button ?? 0}`);
        break;

      case 'mouseup':
        this.execute(`MUP ${payload.button ?? 0}`);
        break;

      case 'wheel':
        // deltaY in browser is typically 100 or -100
        const delta = Math.sign(payload.deltaY || 0) * -120;
        this.execute(`WHEEL ${delta}`);
        break;

      case 'keydown':
        if (payload.keyCode) {
          this.execute(`KDOWN ${payload.keyCode}`);
        }
        break;

      case 'keyup':
        if (payload.keyCode) {
          this.execute(`KUP ${payload.keyCode}`);
        }
        break;

      case 'special':
        if (payload.key) {
          this.execute(`SPECIAL ${payload.key}`);
        }
        break;
    }
  }

  destroy() {
    if (this.process) {
      try {
        this.process.kill();
      } catch (e) {}
      this.process = null;
    }
  }
}

module.exports = new NativeController();
