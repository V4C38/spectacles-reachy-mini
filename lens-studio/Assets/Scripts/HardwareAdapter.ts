import { XYZRPYPose, RobotInterface } from "./RobotDriver";

export interface MoveUUID {
    uuid: string;
}

interface PendingRequest {
    resolve: (data: any) => void;
    reject: (error: Error) => void;
}

// WebSocket readyState constants (Lens Studio)
const WS_CONNECTING = 0;
const WS_OPEN = 1;
const WS_CLOSING = 2;
const WS_CLOSED = 3;

@component
export class HardwareAdapter extends BaseScriptComponent implements RobotInterface {

    @input
    public baseUrl: string = "192.168.1.98";

    @input
    private internetModule!: InternetModule;

    @input
    private audioComponent: AudioComponent | null = null;

    // --- WebSocket state ---
    private ws: WebSocket | null = null;
    private requestId: number = 0;
    private pendingRequests: Map<number, PendingRequest> = new Map();
    private isConnecting: boolean = false;

    // --- set_target throttling (reduces jitter from network flooding) ---
    private static readonly SET_TARGET_MIN_INTERVAL_SEC = 0.066; // ~15Hz max
    private lastSetTargetTime: number = 0;

    onAwake() {
    }

    // ================================================================
    // WebSocket Connection Lifecycle
    // ================================================================

    /**
     * Derive a ws:// URL from the user-entered IP (or baseUrl).
     * Port 8765 is always used; the user only enters the IP address.
     */
    private deriveWsUrl(input: string): string {
        let host = input.trim();
        // Strip any protocol prefix
        if (host.startsWith("http://")) host = host.substring(7);
        if (host.startsWith("https://")) host = host.substring(8);
        if (host.startsWith("ws://")) host = host.substring(5);
        if (host.startsWith("wss://")) host = host.substring(6);
        // Strip trailing slashes
        while (host.endsWith("/")) host = host.substring(0, host.length - 1);
        // Use fixed port 8765 (Spectacles bridge); strip any user-entered port
        const colonIdx = host.lastIndexOf(":");
        if (colonIdx > 0) {
            host = host.substring(0, colonIdx);
        }
        return `ws://${host}:8765/ws`;
    }

    /**
     * Open a WebSocket connection to the Python bridge app.
     * Resolves when the connection is open, rejects on failure/timeout.
     */
    public async connect(): Promise<void> {
        // Already connected
        if (this.ws && this.ws.readyState === WS_OPEN) {
            return;
        }
        // Avoid concurrent connect attempts
        if (this.isConnecting) {
            return;
        }
        this.isConnecting = true;

        // Close any existing connection
        this.disconnect();

        const wsUrl = this.deriveWsUrl(this.baseUrl);
        print(`HardwareAdapter: Connecting to ${wsUrl}`);

        return new Promise<void>((resolve, reject) => {
            try {
                this.ws = this.internetModule.createWebSocket(wsUrl);
            } catch (error) {
                this.isConnecting = false;
                print(`HardwareAdapter: Failed to create WebSocket: ${error}`);
                reject(new Error(`Failed to create WebSocket: ${error}`));
                return;
            }

            this.ws.onopen = (event: WebSocketEvent) => {
                this.isConnecting = false;
                print(`HardwareAdapter: WebSocket connected to ${wsUrl}`);
                resolve();
            };

            this.ws.onmessage = (event: WebSocketMessageEvent) => {
                this.onMessage(event);
            };

            this.ws.onerror = (event: WebSocketEvent) => {
                this.isConnecting = false;
                print(`HardwareAdapter: WebSocket error`);
                reject(new Error("WebSocket connection error"));
            };

            this.ws.onclose = (event: WebSocketCloseEvent) => {
                print(`HardwareAdapter: WebSocket closed`);
                this.ws = null;
                // Reject all pending requests
                this.pendingRequests.forEach((pending) => {
                    pending.reject(new Error("WebSocket closed"));
                });
                this.pendingRequests.clear();
            };

            // Timeout after 5 seconds
            const timeoutEvent = this.createEvent("DelayedCallbackEvent") as DelayedCallbackEvent;
            timeoutEvent.bind(() => {
                if (this.isConnecting) {
                    this.isConnecting = false;
                    if (this.ws) {
                        this.ws.close();
                        this.ws = null;
                    }
                    reject(new Error("WebSocket connection timeout"));
                }
            });
            timeoutEvent.reset(5.0);
        });
    }

    /**
     * Close the WebSocket connection.
     */
    public disconnect(): void {
        if (this.ws) {
            this.ws.onclose = null; // Prevent the onclose handler from running
            this.ws.close();
            this.ws = null;
        }
        this.pendingRequests.forEach((pending) => {
            pending.reject(new Error("Disconnected"));
        });
        this.pendingRequests.clear();
        this.isConnecting = false;
    }

    // ================================================================
    // Message Handling
    // ================================================================

    /**
     * Handle incoming WebSocket messages. Routes responses to pending requests by _id.
     */
    private onMessage(event: WebSocketMessageEvent): void {
        try {
            // In Lens Studio, text frames arrive as event.data (string)
            const raw = event.data as string;
            const data = JSON.parse(raw);
            const id = data._id;
            if (id !== undefined && this.pendingRequests.has(id)) {
                const pending = this.pendingRequests.get(id);
                this.pendingRequests.delete(id);
                pending.resolve(data);
            }
        } catch (error) {
            print(`HardwareAdapter: Failed to parse WebSocket message: ${error}`);
        }
    }

    /**
     * Send a JSON message over WebSocket (fire-and-forget).
     * Does nothing if the socket is not open.
     */
    private send(msg: any): void {
        if (this.ws && this.ws.readyState === WS_OPEN) {
            this.ws.send(JSON.stringify(msg));
        }
    }

    /**
     * Send a JSON message and wait for a correlated response (matched by _id).
     * @param msg The message payload (will have _id added automatically)
     * @param timeoutSec Timeout in seconds (default: 10)
     */
    private sendAndWait(msg: any, timeoutSec: number = 10): Promise<any> {
        const id = ++this.requestId;
        msg._id = id;

        return new Promise<any>((resolve, reject) => {
            if (!this.ws || this.ws.readyState !== WS_OPEN) {
                reject(new Error("WebSocket not connected"));
                return;
            }

            this.pendingRequests.set(id, { resolve, reject });
            this.ws.send(JSON.stringify(msg));

            // Timeout
            const timeoutEvent = this.createEvent("DelayedCallbackEvent") as DelayedCallbackEvent;
            timeoutEvent.bind(() => {
                if (this.pendingRequests.has(id)) {
                    this.pendingRequests.delete(id);
                    reject(new Error(`Request ${msg.type} timed out after ${timeoutSec}s`));
                }
            });
            timeoutEvent.reset(timeoutSec);
        });
    }

    // ================================================================
    // Connection Check
    // ================================================================

    /**
     * Check if the WebSocket bridge is available and responding.
     * Will attempt to connect if not already connected.
     */
    public async checkConnection(): Promise<boolean> {
        try {
            if (!this.ws || this.ws.readyState !== WS_OPEN) {
                await this.connect();
            }
            const result = await this.sendAndWait({ type: "status" }, 5);
            return result && result.type === "status_result";
        } catch (error) {
            print(`HardwareAdapter: checkConnection failed: ${error}`);
            return false;
        }
    }

    // ================================================================
    // Movement Commands
    // ================================================================

    /**
     * Stop a running move task.
     */
    public async stopMove(moveUuid: string): Promise<void> {
        const result = await this.sendAndWait({ type: "stop_move", uuid: moveUuid });
        if (!result || result.type === "error") {
            throw new Error(`Failed to stop move ${moveUuid}: ${result?.message || "unknown error"}`);
        }
    }

    /**
     * Request a movement to a specific target with interpolation.
     * @param headPose Target head pose (x, y, z in meters, roll, pitch, yaw in radians)
     * @param bodyYaw Optional target body yaw in radians
     * @param duration Duration of the movement in seconds (default: 0.5)
     * @param interpolation Interpolation mode: "linear", "minjerk", "ease", or "cartoon" (default: "minjerk")
     * @returns UUID to track/stop the move
     */
    public async goto(headPose: XYZRPYPose, bodyYaw?: number, duration: number = 0.5, interpolation: string = "minjerk"): Promise<string> {
        const msg: any = {
            type: "goto",
            head_pose: headPose,
            duration: duration,
            interpolation: interpolation,
            antennas: [0, 0]
        };
        if (bodyYaw !== undefined) {
            msg.body_yaw = bodyYaw;
        }
        const result = await this.sendAndWait(msg);
        if (!result || result.type === "error") {
            throw new Error(`Failed to execute goto: ${result?.message || "unknown error"}`);
        }
        return result.uuid;
    }

    /**
     * Set target pose immediately (no interpolation).
     * Used for real-time tracking at high frequency (e.g., 50Hz).
     * Fire-and-forget: does not wait for a response for maximum performance.
     * @param headPose Target head pose (x, y, z in meters, roll, pitch, yaw in radians)
     * @param bodyYaw Optional target body yaw in radians
     * @param antennas Optional antenna positions [left, right] in radians
     */
    public async setTarget(headPose: XYZRPYPose, bodyYaw?: number, antennas?: [number, number]): Promise<void> {
        const now = getTime();
        if (now - this.lastSetTargetTime < HardwareAdapter.SET_TARGET_MIN_INTERVAL_SEC) {
            return; // Throttle to ~15Hz; Python-side LERP at 30Hz fills the gaps
        }
        this.lastSetTargetTime = now;

        const msg: any = {
            type: "set_target",
            target_head_pose: headPose,
            target_antennas: antennas ?? [0, 0]
        };
        if (bodyYaw !== undefined) {
            msg.target_body_yaw = bodyYaw;
        }
        this.send(msg);
    }

    // ================================================================
    // Audio
    // ================================================================

    /**
     * Read the AudioTrackAsset via its provider, encode as base64 float32 PCM, and send to the
     * Python bridge for playback on the Reachy Mini speaker.
     * Requires the track's control to be FileAudioTrackProvider or FileLicensedSoundProvider.
     */
    public async playAudio(audioTrack: AudioTrackAsset): Promise<void> {
        const control = audioTrack.control;
        const hasGetBuffer =
            control.isOfType("Provider.FileAudioTrackProvider") ||
            control.isOfType("Provider.FileLicensedSoundProvider");
        if (!hasGetBuffer) {
            throw new Error(
                "HardwareAdapter.playAudio: AudioTrackAsset must use FileAudioTrackProvider or FileLicensedSoundProvider"
            );
        }

        const provider = control as FileAudioTrackProvider;
        const durationSec = provider.duration;
        const sampleRate = provider.sampleRate;
        const maxFrameSize = provider.maxFrameSize;
        const totalSamples = Math.ceil(durationSec * sampleRate);
        if (totalSamples <= 0) {
            return;
        }

        const buffer = new Float32Array(maxFrameSize);
        const chunks: Float32Array[] = [];
        let readTotal = 0;

        while (readTotal < totalSamples) {
            const toRead = Math.min(maxFrameSize, totalSamples - readTotal);
            const result = provider.getAudioBuffer(buffer, toRead);
            const got = result.x;
            if (got <= 0) break;
            chunks.push(buffer.slice(0, got));
            readTotal += got;
        }

        const all = new Float32Array(readTotal);
        let offset = 0;
        for (const c of chunks) {
            all.set(c, offset);
            offset += c.length;
        }

        const bytes = new Uint8Array(all.buffer, all.byteOffset, all.byteLength);
        const dataB64 = Base64.encode(bytes);

        const msg = {
            type: "play_audio",
            data: dataB64,
            sample_rate: sampleRate,
            channels: 1
        };
        const result = await this.sendAndWait(msg, Math.ceil(durationSec) + 30);
        if (!result || result.type === "error") {
            throw new Error(`playAudio failed: ${(result as any)?.message || "unknown error"}`);
        }
        print(`HardwareAdapter: Played ${readTotal} samples (${durationSec.toFixed(2)}s) on Reachy Mini speaker`);
    }

    /**
     * Send text to the Python bridge for server-side TTS and robot speaker playback.
     * @param text The text to speak
     * @param voice OpenAI TTS voice (default: "alloy")
     */
    public async playTTS(text: string, voice: string = "alloy"): Promise<void> {
        const result = await this.sendAndWait({ type: "play_tts", text: text, voice: voice }, 30);
        if (!result || result.type === "error") {
            throw new Error(`playTTS failed: ${result?.message || "unknown error"}`);
        }
    }

    // ================================================================
    // Animations
    // ================================================================

    /**
     * Play a named animation on the robot. Blocks until the animation completes.
     * The caller (RobotDriver) should pause the update loop for the duration.
     */
    public async playAnimation(name: string): Promise<{ durationSec: number }> {
        const result = await this.sendAndWait({ type: "play_animation", name: name }, 60);
        if (!result || result.type === "error") {
            throw new Error(`playAnimation failed: ${(result as any)?.message || "unknown error"}`);
        }
        const durationSec = (result as any).duration_sec ?? 0;
        return { durationSec };
    }

    /**
     * Get the list of available animation names from the Python bridge.
     */
    public async getAvailableAnimations(): Promise<string[]> {
        const result = await this.sendAndWait({ type: "get_available_animations" }, 5);
        if (!result || result.type === "error") {
            throw new Error(`getAvailableAnimations failed: ${(result as any)?.message || "unknown error"}`);
        }
        const names = (result as any).names;
        return Array.isArray(names) ? names : [];
    }
}
