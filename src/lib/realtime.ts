/**
 * Browser side of the realtime link.
 *
 * We talk to our own Node server, not to Azure directly, because the API key is
 * long-lived and must never reach client code. The server owns the Voice Live
 * session; this socket carries PCM16 audio as binary frames and small JSON
 * control messages.
 */

/** Azure offers exactly two Malayalam voices, so this is the whole palette. */
export type VoiceChoice = "male" | "female";

/** How hard the character goes after the user. */
export type RoastLevel = "savage" | "normal";

export type SessionState =
  | "idle"
  | "connecting"
  | "ready"
  | "listening"
  | "thinking"
  | "speaking"
  | "error"
  | "ended";

export type ServerMessage =
  | { type: "state"; state: Exclude<SessionState, "speaking"> }
  | { type: "captionText"; text: string }
  | { type: "userTranscript"; text: string }
  | { type: "responseStart"; itemId: string }
  | { type: "interrupted" }
  | { type: "error"; message: string };

export interface RealtimeHandlers {
  onAudio: (pcm16: ArrayBuffer) => void;
  onMessage: (message: ServerMessage) => void;
  onClosed: () => void;
}

export class RealtimeLink {
  private socket: WebSocket | null = null;

  constructor(private readonly handlers: RealtimeHandlers) {}

  /**
   * @param characterId id returned by /api/analyse. Omitted means the built-in
   *   demo chair.
   * @param voice which of the two Malayalam voices to use.
   *
   * Both are passed at connect time so the session is configured on its first
   * update. That also means the voice never changes mid-session, which matters
   * because mid-session voice switching is untested against this provider.
   */
  connect(
    characterId?: string,
    voice: VoiceChoice = "male",
    roast: RoastLevel = "savage",
  ): void {
    if (this.socket) return;

    const params = new URLSearchParams({ voice, roast });
    if (characterId) params.set("character", characterId);

    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${location.host}/realtime?${params}`);
    socket.binaryType = "arraybuffer";
    this.socket = socket;

    socket.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        this.handlers.onAudio(event.data);
        return;
      }
      try {
        this.handlers.onMessage(JSON.parse(event.data as string) as ServerMessage);
      } catch {
        // Ignore anything we cannot parse rather than killing the session.
      }
    };

    socket.onclose = () => {
      this.socket = null;
      this.handlers.onClosed();
    };

    socket.onerror = () => {
      this.handlers.onMessage({
        type: "error",
        message: "Lost the connection to the server. Is it running?",
      });
    };
  }

  private get isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  sendAudio(frame: ArrayBuffer): void {
    if (this.isOpen) this.socket!.send(frame);
  }

  send(
    message:
      | { type: "greet" | "interrupt" | "escape" }
      | { type: "ask"; text: string }
      | { type: "played"; itemId: string; ms: number },
  ): void {
    if (this.isOpen) this.socket!.send(JSON.stringify(message));
  }

  close(): void {
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onclose = null;
      socket.close();
    }
  }
}
