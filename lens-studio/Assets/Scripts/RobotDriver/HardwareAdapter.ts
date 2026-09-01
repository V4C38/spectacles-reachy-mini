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
    private static readonly CONNECT_TIMEOUT_S = 5.0;
    private ws: WebSocket | null = null;
    private requestId: number = 0;
    private pendingRequests: Map<number, PendingRequest> = new Map();
    private isConnecting: boolean = false;
    private openHost: string | null = null;
    private connectingHost: string | null = null;
    private connectingSocket: WebSocket | null = null;
    private connectPromise: Promise<void> | null = null;
    private pendingConnectResolve: (() => void) | null = null;
    private pendingConnectReject: ((error: Error) => void) | null = null;
    private retiredSockets = new Set<WebSocket>();
    private connectTimeoutEvent: DelayedCallbackEvent | null = null;

    // --- set_target coalescing (20 Hz max; latest pose always wins) ---
    private static readonly SET_TARGET_MIN_INTERVAL_SEC = 0.05; // 20 Hz max
    private lastSetTargetTime: number = 0;
    private pendingTarget: { headPose: XYZRPYPose; bodyYaw?: number; antennas?: [number, number] } | null = null;
    private flushEvent: DelayedCallbackEvent | null = null;
    private flushScheduled: boolean = false;

    // --- IP persistence ---
    private static readonly IP_KEY = "reachy_mini_ip";

    private get store(): GeneralDataStore {
        return global.persistentStorageSystem.store;
    }

    onAwake() {
        const saved = this.loadIp();
        if (saved) {
            this.baseUrl = saved;
        }
        this.flushEvent = this.createEvent("DelayedCallbackEvent") as DelayedCallbackEvent;
        this.flushEvent.bind(() => this.flushPendingTarget());

        const connectTimeout = this.createEvent("DelayedCallbackEvent") as DelayedCallbackEvent;
        connectTimeout.bind(() => {
            const socket = this.connectingSocket;
            if (!this.isConnecting || this.ws !== socket || socket === null) {
                return;
            }
            if (socket.readyState === WS_OPEN) {
                this.completeConnectOpen(socket);
                return;
            }
            this.retireSocket(socket);
            this.ws = null;
            this.finishConnectAttempt(new Error("WebSocket connection timeout"));
        });
        this.connectTimeoutEvent = connectTimeout;
    }

    public saveIp(ip: string): void {
        this.store.putString(HardwareAdapter.IP_KEY, ip);
    }

    public loadIp(): string | null {
        if (this.store.has(HardwareAdapter.IP_KEY)) {
            return this.store.getString(HardwareAdapter.IP_KEY);
        }
        return null;
    }

    // ================================================================
    // WebSocket Connection Lifecycle
    // ================================================================

    /**
     * Strip protocol, trailing slashes, and a user-entered port from an IP/host string.
     */
    private normalizeIp(raw: string): string {
        let host = raw.trim();
        if (host.startsWith("http://")) host = host.substring(7);
        if (host.startsWith("https://")) host = host.substring(8);
        if (host.startsWith("ws://")) host = host.substring(5);
        if (host.startsWith("wss://")) host = host.substring(6);
        while (host.endsWith("/")) host = host.substring(0, host.length - 1);
        const colonIdx = host.lastIndexOf(":");
        if (colonIdx > 0) {
            host = host.substring(0, colonIdx);
        }
        return host;
    }

    /**
     * Derive a ws:// URL from the user-entered IP (or baseUrl).
     * Port 8765 is always used; the user only enters the IP address.
     */
    private deriveWsUrl(input: string): string {
        return `ws://${this.normalizeIp(input)}:8765/ws`;
    }

    private isSocketOpen(): boolean {
        return this.ws !== null && this.ws.readyState === WS_OPEN;
    }

    /**
     * Open a WebSocket connection to the Python bridge app.
     * Resolves when the connection is open, rejects on failure/timeout.
     * Spectacles-safe: never hard-closes a CONNECTING socket; host change
     * reconnects after the in-flight attempt settles.
     */
    public connect(): Promise<void> {
        const targetHost = this.normalizeIp(this.baseUrl);
        if (this.isSocketOpen() && this.openHost === targetHost) {
            return Promise.resolve();
        }
        if (this.isConnecting && this.connectPromise) {
            return this.connectPromise;
        }

        this.disconnect();
        this.drainRetiredSockets();
        this.isConnecting = true;
        this.connectingHost = targetHost;

        const wsUrl = this.deriveWsUrl(this.baseUrl);
        print(`HardwareAdapter: Connecting to ${wsUrl}`);

        this.connectPromise = new Promise<void>((resolve, reject) => {
            this.pendingConnectResolve = resolve;
            this.pendingConnectReject = reject;
            try {
                this.ws = this.internetModule.createWebSocket(wsUrl);
            } catch (error) {
                print(`HardwareAdapter: Failed to create WebSocket: ${error}`);
                this.finishConnectAttempt(new Error(`Failed to create WebSocket: ${error}`));
                return;
            }

            const socket = this.ws;
            this.connectingSocket = socket;

            socket.onopen = () => {
                if (this.ws !== socket) {
                    return;
                }
                this.completeConnectOpen(socket);
            };

            socket.onmessage = (event: WebSocketMessageEvent) => {
                if (this.ws !== socket) {
                    return;
                }
                if (this.isConnecting && this.connectingSocket === socket) {
                    this.completeConnectOpen(socket);
                }
                this.onMessage(event);
            };

            socket.onerror = () => {
                if (this.ws !== socket) {
                    return;
                }
                print(`HardwareAdapter: WebSocket error`);
                this.retireSocket(socket);
                this.ws = null;
                this.cancelPendingTarget();
                this.rejectPendingRequests("WebSocket connection error");
                this.finishConnectAttempt(new Error("WebSocket connection error"));
            };

            socket.onclose = () => {
                if (this.ws !== socket) {
                    return;
                }
                print(`HardwareAdapter: WebSocket closed`);
                const wasConnecting = this.isConnecting && this.connectingSocket === socket;
                this.ws = null;
                this.openHost = null;
                this.cancelPendingTarget();
                this.rejectPendingRequests("WebSocket closed");
                if (wasConnecting) {
                    this.finishConnectAttempt(new Error("WebSocket connection closed"));
                }
            };

            this.connectTimeoutEvent?.reset(HardwareAdapter.CONNECT_TIMEOUT_S);
        });

        return this.connectPromise;
    }

    /**
     * Close the WebSocket connection. Never hard-closes a CONNECTING native socket
     * (that freezes Spectacles); retired sockets close themselves if they open later.
     */
    public disconnect(): void {
        this.cancelPendingTarget();
        this.rejectPendingRequests("Disconnected");

        if (this.isConnecting) {
            const socket = this.connectingSocket ?? this.ws;
            if (socket) {
                this.retireSocket(socket);
            }
            this.ws = null;
            this.openHost = null;
            this.finishConnectAttempt(new Error("Disconnected"));
        } else if (this.ws) {
            const socket = this.ws;
            if (socket.readyState === WS_OPEN) {
                this.detachSocketHandlers(socket);
                socket.close();
            } else {
                this.retireSocket(socket);
            }
            this.ws = null;
            this.openHost = null;
        }
        this.isConnecting = false;
    }

    private rejectPendingRequests(message: string): void {
        this.pendingRequests.forEach((pending) => {
            pending.reject(new Error(message));
        });
        this.pendingRequests.clear();
    }

    private detachSocketHandlers(socket: WebSocket): void {
        socket.onopen = () => {};
        socket.onmessage = () => {};
        socket.onerror = () => {};
        socket.onclose = () => {};
    }

    private clearConnectTimeout(): void {
        this.connectTimeoutEvent?.reset(0);
    }

    private completeConnectOpen(socket: WebSocket): void {
        if (!this.isConnecting || this.ws !== socket || this.connectingSocket !== socket) {
            return;
        }
        this.clearConnectTimeout();
        this.isConnecting = false;
        this.connectingSocket = null;
        this.openHost = this.connectingHost;
        this.connectingHost = null;
        const resolveFn = this.pendingConnectResolve;
        this.pendingConnectReject = null;
        this.pendingConnectResolve = null;
        this.connectPromise = null;
        print(`HardwareAdapter: WebSocket connected to ${this.deriveWsUrl(this.openHost ?? this.baseUrl)}`);
        if (resolveFn) {
            resolveFn();
        }
    }

    /**
     * Abort a socket without hard-closing while CONNECTING (Spectacles freeze risk).
     * Close only if already OPEN; if it opens later while retired, close then.
     */
    private retireSocket(socket: WebSocket): void {
        if (this.retiredSockets.has(socket)) {
            return;
        }
        this.detachSocketHandlers(socket);
        this.retiredSockets.add(socket);
        socket.onopen = () => {
            if (this.retiredSockets.has(socket)) {
                socket.close();
            }
        };
        socket.onclose = () => {
            this.retiredSockets.delete(socket);
        };
        socket.onerror = () => {};
        socket.onmessage = () => {};
        if (socket.readyState === WS_OPEN) {
            socket.close();
        }
    }

    private drainRetiredSockets(): void {
        for (const socket of Array.from(this.retiredSockets)) {
            if (socket.readyState === WS_OPEN) {
                socket.close();
            }
        }
    }

    private finishConnectAttempt(error?: Error): void {
        this.clearConnectTimeout();
        this.isConnecting = false;
        this.connectingSocket = null;
        this.connectingHost = null;
        if (error) {
            this.openHost = null;
        }
        this.connectPromise = null;
        const rejectFn = this.pendingConnectReject;
        const resolveFn = this.pendingConnectResolve;
        this.pendingConnectReject = null;
        this.pendingConnectResolve = null;
        if (error && rejectFn) {
            rejectFn(error);
        } else if (!error && resolveFn) {
            resolveFn();
        }
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
                if (pending) {
                    pending.resolve(data);
                }
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
     * Will attempt to connect if not already connected to baseUrl.
     * Never aborts an in-flight CONNECTING socket — a changed IP is picked
     * up by the next attempt after the current one settles.
     */
    public async checkConnection(): Promise<boolean> {
        const host = this.normalizeIp(this.baseUrl);
        if (!host) {
            print("HardwareAdapter: checkConnection failed — empty IP");
            return false;
        }

        try {
            if (this.isSocketOpen() && this.openHost !== host) {
                this.disconnect();
            }

            if (!this.isSocketOpen()) {
                await this.connect();
            }

            if (!this.isSocketOpen() || this.openHost !== host) {
                return false;
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
        this.dropPendingTarget();
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
     * Calls within the 20 Hz window replace a pending slot (latest wins) and
     * flush when the window opens — never drop the newest pose.
     * @param headPose Target head pose (x, y, z in meters, roll, pitch, yaw in radians)
     * @param bodyYaw Optional target body yaw in radians
     * @param antennas Optional antenna positions [left, right] in radians
     */
    public async setTarget(headPose: XYZRPYPose, bodyYaw?: number, antennas?: [number, number]): Promise<void> {
        const now = getTime();
        const elapsed = now - this.lastSetTargetTime;
        if (elapsed >= HardwareAdapter.SET_TARGET_MIN_INTERVAL_SEC) {
            // Drop any older buffered pose so a delayed flush cannot overwrite this one.
            this.dropPendingTarget();
            this.sendSetTarget(headPose, bodyYaw, antennas);
            return;
        }

        this.pendingTarget = {
            headPose: { ...headPose },
            bodyYaw,
            antennas: antennas ? [antennas[0], antennas[1]] : undefined,
        };
        if (!this.flushScheduled && this.flushEvent) {
            this.flushScheduled = true;
            this.flushEvent.enabled = true;
            const wait = Math.max(0, HardwareAdapter.SET_TARGET_MIN_INTERVAL_SEC - elapsed);
            this.flushEvent.reset(wait);
        }
    }

    private sendSetTarget(headPose: XYZRPYPose, bodyYaw?: number, antennas?: [number, number]): void {
        this.lastSetTargetTime = getTime();
        const msg: any = {
            type: "set_target",
            target_head_pose: { ...headPose },
            target_antennas: antennas ? [antennas[0], antennas[1]] : [0, 0]
        };
        if (bodyYaw !== undefined) {
            msg.target_body_yaw = bodyYaw;
        }
        this.send(msg);
    }

    private flushPendingTarget(): void {
        this.flushScheduled = false;
        const pending = this.pendingTarget;
        this.pendingTarget = null;
        if (this.flushEvent) {
            this.flushEvent.enabled = false;
        }
        if (!pending) return;
        if (!this.ws || this.ws.readyState !== WS_OPEN) return;
        this.sendSetTarget(pending.headPose, pending.bodyYaw, pending.antennas);
    }

    /** Drop a buffered pose without resetting the 20 Hz window (used when a newer send wins). */
    private dropPendingTarget(): void {
        this.pendingTarget = null;
        this.flushScheduled = false;
        if (this.flushEvent) {
            this.flushEvent.enabled = false;
        }
    }

    private cancelPendingTarget(): void {
        this.dropPendingTarget();
        this.lastSetTargetTime = 0;
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
     * Capture a frame from the Reachy Mini onboard camera and return as base64 JPEG.
     */
    public async getRobotCameraFrame(): Promise<string> {
        const result = await this.sendAndWait({ type: "get_robot_camera_frame" }, 15);
        if (!result || result.type === "error") {
            throw new Error(`getRobotCameraFrame failed: ${(result as any)?.message || "unknown error"}`);
        }
        const base64 = (result as any).image_base64;
        if (typeof base64 !== "string") {
            throw new Error("getRobotCameraFrame: missing or invalid image_base64 in response");
        }
        return base64;
    }

}
