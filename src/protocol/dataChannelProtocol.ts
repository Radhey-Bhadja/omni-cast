/**
 * OmniCast DataChannel Protocol Handler
 * Complete TypeScript type definitions and packet serializer / deserializer
 * for Ultra-Low Latency WebRTC Remote Desktop Control, Chat, and 16KB File Transfer.
 */

export const DATA_CHANNEL_CONFIG = {
  label: 'omnicast-control',
  ordered: true,
  maxRetransmits: 3,
  chunkSize: 16 * 1024 // 16KB per file transfer packet
};

// ============================================================================
// Protocol Message Definitions
// ============================================================================

export type MouseButton = 0 | 1 | 2; // 0 = Left, 1 = Middle, 2 = Right

export interface MouseMoveMessage {
  type: 'mouse-move';
  x: number; // 0.0 to 1.0 (normalized percentage)
  y: number; // 0.0 to 1.0 (normalized percentage)
}

export interface MouseDownMessage {
  type: 'mouse-down';
  button: MouseButton;
  x: number;
  y: number;
}

export interface MouseUpMessage {
  type: 'mouse-up';
  button: MouseButton;
  x: number;
  y: number;
}

export interface MouseClickMessage {
  type: 'mouse-click';
  button: MouseButton;
  x: number;
  y: number;
}

export interface MouseWheelMessage {
  type: 'mouse-wheel';
  deltaX: number;
  deltaY: number;
  x: number;
  y: number;
}

export interface KeyDownMessage {
  type: 'key-down';
  key: string;
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

export interface KeyUpMessage {
  type: 'key-up';
  key: string;
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

export interface LaserPointerMessage {
  type: 'laser';
  x: number;
  y: number;
}

export interface SpecialKeyMessage {
  type: 'special-key';
  key: 'CAD' | 'WIN' | 'ALTTAB' | 'ESC';
}

export interface TextInputMessage {
  type: 'text-input';
  text: string;
}

export interface ChatMessage {
  type: 'chat';
  text: string;
  timestamp: number;
  from?: string;
}

export interface FileStartMessage {
  type: 'file-start';
  id: string;
  name: string;
  size: number;
  mimeType: string;
  totalChunks: number;
}

export interface FileChunkMessage {
  type: 'file-chunk';
  id: string;
  chunkIndex: number;
  totalChunks: number;
  data: string; // Base64 data URL
}

export interface FileEndMessage {
  type: 'file-end';
  id: string;
}

export interface ClipboardPushMessage {
  type: 'clipboard-push';
  text: string;
}

export interface ClipboardPullReqMessage {
  type: 'clipboard-pull-req';
}

export interface ClipboardPullRespMessage {
  type: 'clipboard-pull-resp';
  text: string;
}

export interface SessionPermissions {
  allowAudio: boolean;
  allowPointer: boolean;
  allowFiles: boolean;
  allowClipboard: boolean;
  nativeOsControl?: boolean;
}

export interface AskPermissionMessage {
  type: 'ask-permission';
  fromCode: string;
  clientInfo?: {
    browser: string;
    platform: string;
  };
  permissions?: SessionPermissions;
}

export interface AcceptedMessage {
  type: 'accepted';
  permissions?: SessionPermissions;
}

export interface PermissionDeniedMessage {
  type: 'permission-denied';
  reason?: string;
}

export interface SessionEndMessage {
  type: 'session-end';
  reason?: string;
}

export type DataChannelPacket =
  | MouseMoveMessage
  | MouseDownMessage
  | MouseUpMessage
  | MouseClickMessage
  | MouseWheelMessage
  | KeyDownMessage
  | KeyUpMessage
  | LaserPointerMessage
  | SpecialKeyMessage
  | TextInputMessage
  | ChatMessage
  | FileStartMessage
  | FileChunkMessage
  | FileEndMessage
  | ClipboardPushMessage
  | ClipboardPullReqMessage
  | ClipboardPullRespMessage
  | AskPermissionMessage
  | AcceptedMessage
  | PermissionDeniedMessage
  | SessionEndMessage;

// ============================================================================
// Serializer & Deserializer
// ============================================================================

export function encodePacket(packet: DataChannelPacket): string {
  return JSON.stringify(packet);
}

export function decodePacket(raw: string | ArrayBuffer): DataChannelPacket | null {
  try {
    if (typeof raw === 'string') {
      return JSON.parse(raw) as DataChannelPacket;
    }
    const decoder = new TextDecoder('utf-8');
    const text = decoder.decode(raw);
    return JSON.parse(text) as DataChannelPacket;
  } catch (err) {
    console.error('[OmniCast Protocol] Failed to decode packet:', err);
    return null;
  }
}
