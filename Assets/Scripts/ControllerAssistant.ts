import { MLObjectDetector } from "./Utils/MLObjectDetector";
import { DepthCacheHelper } from "./Utils/DepthCacheHelper";
import { XYZRPYPose, IMovementInterface } from "./MovementInterface";
import { LLMInterface } from "./LLMInterface";

export enum AssistantState {
    Inactive,
    Idle,
    Listening,
    Speaking,
    Searching
}

@component
export class ControllerAssistant extends BaseScriptComponent {

    // --- Inputs ---
    @input
    private objectMarkerPrefab: ObjectPrefab;
    @input
    private camera: SceneObject;
    @input
    private headRoot: SceneObject;
    @input
    private depthCacheHelper: DepthCacheHelper;
    @input
    public llmInterface: LLMInterface | null = null;
    @input
    public mlDetector: MLObjectDetector;


    public isActive: boolean = true;
    private isScanning: boolean = false;
    private movementInterface: IMovementInterface | null = null;
    public currentState: AssistantState = AssistantState.Inactive;

    // --- ASR ---
    @input
    public asrModule: AsrModule | null = null;
    private isTranscribing: boolean = false;
    private isSessionActive: boolean = false;

    /**
     * Returns true when a conversation session is ongoing
     * (wake word was detected and no timeout has occurred yet).
     */
    public get isConversationActive(): boolean {
        return this.isSessionActive;
    }

    /** Callbacks fired when the conversation session opens or closes. Receives `true` on open, `false` on close. */
    public onSessionChanged: ((active: boolean) => void)[] = [];

    /** Callbacks fired on every state transition. */
    public onStateChanged: ((newState: AssistantState) => void)[] = [];
    private isProcessingSpeech: boolean = false;
    private currentTranscription: string = "";

    // --- Timers ---
    private debounceTimer: number = 0;
    private lastActivityTime: number = 0;

    // --- Configuration ---
    private readonly WAKE_WORDS = ["reachy", "richie", "richy", "reach", "reachie", "ritchie", "richi", "reechy", "reechi", "reachi"];
    private readonly IDLE_DEBOUNCE_SEC = 3.0;
    private readonly SESSION_TIMEOUT_SEC = 15.0;
    private readonly WAKE_SILENCE_MS = 1500;
    private readonly CONVO_SILENCE_MS = 2000;

    // (TTS audio format is handled by LLMInterface and returned as AudioTrackAsset)

    // --- Tracked axes ---
    private headYaw: number = 0;
    private headPitch: number = 0;
    private headRoll: number = 0;
    private headY: number = 0;
    private bodyYaw: number = 0;
    private prevHeadYaw: number = 0;
    private antennaLeft: number = 0;
    private antennaRight: number = 0;

    // --- Smoothing (slow for idle, fast for speaking/searching/listening) ---
    private readonly HEAD_YAW_SMOOTHING_IDLE = 0.03;
    private readonly HEAD_YAW_SMOOTHING_FAST = 0.06;
    private readonly HEAD_PITCH_SMOOTHING_IDLE = 0.02;
    private readonly HEAD_PITCH_SMOOTHING_FAST = 0.04;
    private readonly BODY_SMOOTHING_IDLE = 0.03;
    private readonly BODY_SMOOTHING_FAST = 0.04;
    private readonly ROLL_SMOOTHING_IDLE = 0.03;
    private readonly ROLL_SMOOTHING_FAST = 0.04;
    private readonly ANTENNA_SMOOTHING_IDLE = 0.06;
    private readonly ANTENNA_SMOOTHING_FAST = 0.08;
    private readonly MAX_YAW_DELTA_IDLE = 1.5 * Math.PI / 180;
    private readonly MAX_YAW_DELTA_FAST = 3 * Math.PI / 180;
    private readonly MAX_PITCH_DELTA_IDLE = 0.8 * Math.PI / 180;
    private readonly MAX_PITCH_DELTA_FAST = 1.5 * Math.PI / 180;

    // --- Mechanical limits ---
    private readonly MIN_PITCH = -30 * Math.PI / 180;
    private readonly MAX_PITCH = 20 * Math.PI / 180;
    private readonly MAX_HEAD_YAW = 35 * Math.PI / 180;
    private readonly MAX_BODY_YAW = 160 * Math.PI / 180;
    private readonly MAX_ROLL = 15 * Math.PI / 180;
    private readonly ROLL_YAW_COUPLING = 0.12;
    private readonly Y_SMOOTHING_IDLE = 0.03;
    private readonly Y_SMOOTHING_FAST = 0.04;

    // --- Glance behavior ---
    private isGlancingAway: boolean = false;
    private nextGlanceChangeTime: number = 0;
    private glanceOffsetYaw: number = 0;
    private glanceOffsetPitch: number = 0;
    private glanceOffsetRoll: number = 0;

    // --- Speaking ---
    private speakingStartTime: number = 0;
    private readonly SPEAK_NOD_SPEED = 2.5;
    private readonly SPEAK_NOD_AMPLITUDE = 3 * Math.PI / 180;

    // --- Listening ---
    private listeningStartTime: number = 0;
    private readonly LISTEN_NOD_SPEED = 1.5;
    private readonly LISTEN_NOD_AMPLITUDE = 2 * Math.PI / 180;

    // --- Searching ---
    private searchTarget: vec3 | null = null;
    private searchStartTime: number = 0;
    private readonly SEARCH_SWEEP_SPEED = 0.8;
    private readonly SEARCH_YAW_AMP = 20 * Math.PI / 180;
    private readonly SEARCH_PITCH_AMP = 10 * Math.PI / 180;

    // --- Look-at override (timed gaze from tool calls) ---
    private lookAtOverrideTarget: vec3 | null = null;
    private lookAtOverrideEndTime: number = 0;

    // ================================================================
    // Lifecycle
    // ================================================================

    onAwake() {
        this.createEvent("OnStartEvent").bind(() => {
            this.registerTools();
        });
    }

    // ================================================================
    // Movement Interface
    // ================================================================

    public initMovement(movementInterface: IMovementInterface): void {
        this.movementInterface = movementInterface;
        this.headYaw = 0;
        this.headPitch = 0;
        this.headRoll = 0;
        this.headY = 0;
        this.bodyYaw = 0;
        this.prevHeadYaw = 0;
        this.antennaLeft = 0;
        this.antennaRight = 0;
    }

    // ================================================================
    // State Machine
    // ================================================================

    public getState(): AssistantState {
        return this.currentState;
    }

    public setState(newState: AssistantState): void {
        if (this.currentState === newState) return;
        const oldState = this.currentState;
        this.currentState = newState;

        switch (newState) {
            case AssistantState.Inactive:
                this.enterInactive();
                break;
            case AssistantState.Idle:
                this.enterIdle();
                break;
            case AssistantState.Listening:
                this.enterListening();
                break;
            case AssistantState.Speaking:
                this.enterSpeaking();
                break;
            case AssistantState.Searching:
                this.enterSearching();
                break;
        }
        print(`ControllerAssistant: ${AssistantState[oldState]} -> ${AssistantState[newState]}`);
        this.onStateChanged.forEach(cb => cb(newState));
    }

    private enterInactive(): void {
        this.stopASR();
        this.closeSession();
        if (this.movementInterface) {
            this.movementInterface.goto(
                { x: 0, y: 0, z: 0, roll: this.headRoll, pitch: this.headPitch, yaw: this.headYaw },
                this.bodyYaw, 0.3, "minjerk"
            ).catch(() => {});
        }
    }

    private enterIdle(): void {
        this.resetGlance(1.0, 3.0);
        // Start ASR: wake word mode if no session, conversation mode if session active
        this.startASR();
    }

    private enterListening(): void {
        this.listeningStartTime = getTime();
        this.lastActivityTime = getTime();
        this.resetGlance(2.0, 5.0); // Look at user with minimal glancing
    }

    private enterSpeaking(): void {
        this.resetGlance(1.5, 3.5);
        this.speakingStartTime = getTime();
        this.lastActivityTime = getTime();
    }

    private enterSearching(): void {
        this.searchStartTime = getTime();
        this.searchTarget = null;
        if (this.depthCacheHelper) {
            this.searchTarget = this.depthCacheHelper.getForwardIntersection();
        }
        if (!this.searchTarget && this.camera) {
            const cam = this.camera.getTransform();
            this.searchTarget = cam.getWorldPosition().add(cam.forward.uniformScale(200));
        }
    }

    public setSpeaking(speaking: boolean): void {
        if (this.currentState === AssistantState.Inactive || this.currentState === AssistantState.Searching) return;
        if (speaking && this.currentState === AssistantState.Idle) {
            this.setState(AssistantState.Speaking);
        } else if (!speaking && this.currentState === AssistantState.Speaking) {
            this.setState(AssistantState.Idle);
        }
    }

    // ================================================================
    // ASR (Speech-to-Text)
    // ================================================================

    private startASR(): void {
        if (this.isTranscribing) {
            // If already transcribing but mode needs to change, restart
            this.stopASR();
        }

        const options = AsrModule.AsrTranscriptionOptions.create();
        options.silenceUntilTerminationMs = this.isSessionActive ? this.CONVO_SILENCE_MS : this.WAKE_SILENCE_MS;
        options.mode = this.isSessionActive ? AsrModule.AsrMode.HighAccuracy : AsrModule.AsrMode.HighSpeed;

        options.onTranscriptionUpdateEvent.add((eventArgs: AsrModule.TranscriptionUpdateEvent) => {
            this.onTranscriptionUpdate(eventArgs);
        });

        options.onTranscriptionErrorEvent.add((errorCode: AsrModule.AsrStatusCode) => {
            this.onTranscriptionError(errorCode);
        });

        this.asrModule.startTranscribing(options);
        this.isTranscribing = true;
        this.currentTranscription = "";

        const mode = this.isSessionActive ? "conversation" : "wake word";
        print(`ControllerAssistant: ASR started in ${mode} mode`);
    }

    private stopASR(): void {
        if (!this.isTranscribing) return;
        this.asrModule.stopTranscribing();
        this.isTranscribing = false;
        this.currentTranscription = "";
        print("ControllerAssistant: ASR stopped");
    }

    private onTranscriptionUpdate(eventArgs: AsrModule.TranscriptionUpdateEvent): void {
        const text = eventArgs.text;
        const isFinal = eventArgs.isFinal;

        if (!isFinal) {
            // Partial transcription -- show we're listening
            this.currentTranscription = text;
            if (this.isSessionActive && this.currentState === AssistantState.Idle) {
                this.setState(AssistantState.Listening);
            }
            return;
        }

        // Final transcription
        print(`ControllerAssistant: ASR final: "${text}"`);
        this.currentTranscription = "";

        if (!this.isSessionActive) {
            // Wake word detection mode
            this.handleWakeWordDetection(text);
        } else {
            // Active conversation mode
            if (text.trim().length > 0 && !this.isProcessingSpeech) {
                this.processUserSpeech(text);
            }
        }
    }

    private onTranscriptionError(errorCode: AsrModule.AsrStatusCode): void {
        print(`ControllerAssistant: ASR error: ${errorCode}`);
        this.isTranscribing = false;

        // Try to restart ASR if we're still in an active state
        if (this.currentState !== AssistantState.Inactive) {
            print("ControllerAssistant: Restarting ASR after error...");
            this.startASR();
        }
    }

    // ================================================================
    // Wake Word Detection
    // ================================================================

    private handleWakeWordDetection(text: string): void {
        const lowerText = text.toLowerCase().trim();

        // Find the first matching wake word variant
        let wakeIndex = -1;
        let matchedLength = 0;
        for (const word of this.WAKE_WORDS) {
            const idx = lowerText.indexOf(word);
            if (idx >= 0) {
                wakeIndex = idx;
                matchedLength = word.length;
                break;
            }
        }

        if (wakeIndex < 0) {
            // No wake word found, keep listening
            return;
        }

        print(`ControllerAssistant: Wake word detected in: "${text}"`);

        // Open a conversation session
        this.openSession();

        // Extract any text after the wake word as the first command
        const afterWake = text.substring(wakeIndex + matchedLength).trim();
        // Also strip common filler words after wake word
        const cleaned = afterWake.replace(/^[,.\s!?]+/, "").trim();

        if (cleaned.length > 0) {
            // User said something after the wake word, process it immediately
            this.processUserSpeech(cleaned);
        } else {
            // Just the wake word -- greet the user and start listening
            this.playGreeting();
        }
    }

    // -----------------------------------------------------------  
    // Conversation Management
    // -----------------------------------------------------------
    private openSession(): void {
        this.isSessionActive = true;
        this.lastActivityTime = getTime();
        this.debounceTimer = 0;

        // Restart ASR in conversation mode
        this.stopASR();
        this.startASR();

        print("ControllerAssistant: Conversation session opened");
        this.onSessionChanged.forEach(cb => cb(true));
    }

    private closeSession(): void {
        if (!this.isSessionActive) return;
        this.isSessionActive = false;
        this.isProcessingSpeech = false;

        // Clear LLM conversation history
        if (this.llmInterface) {
            this.llmInterface.clearHistory();
        }

        // Restart ASR in wake word mode (if not going Inactive)
        if (this.currentState !== AssistantState.Inactive) {
            this.stopASR();
            this.startASR();
        }

        print("ControllerAssistant: Conversation session closed");
        this.onSessionChanged.forEach(cb => cb(false));
    }

    // -----------------------------------------------------------
    // Conversation Orchestration
    // -----------------------------------------------------------
    private async processUserSpeech(text: string): Promise<void> {
        if (!this.llmInterface || !this.movementInterface) {
            print("ControllerAssistant: LLMInterface or MovementInterface not initialized");
            return;
        }
        if (this.isProcessingSpeech) {
            print("ControllerAssistant: Already processing speech, ignoring");
            return;
        }

        this.isProcessingSpeech = true;
        this.setState(AssistantState.Listening);

        try {
            // Send to LLM (may trigger tool calls internally)
            const response = await this.llmInterface.sendMessage(text);

            // Play audio response
            this.setState(AssistantState.Speaking);
            await this.movementInterface.playAudio(response.audioTrack);

            // Audio done -- start debounce period
            this.debounceTimer = getTime();
            this.lastActivityTime = getTime();
            this.setState(AssistantState.Idle);

        } catch (error) {
            print(`ControllerAssistant: processUserSpeech failed: ${error}`);
            this.setState(AssistantState.Idle);
        } finally {
            this.isProcessingSpeech = false;
        }
    }

    /**
     * Send a greeting prompt to the LLM and play the audio response.
     * Called when the user says only the wake word with no follow-up.
     */
    private async playGreeting(): Promise<void> {
        if (!this.llmInterface || !this.movementInterface) {
            this.setState(AssistantState.Listening);
            return;
        }

        this.isProcessingSpeech = true;

        try {
            const response = await this.llmInterface.sendMessage(
                "[The user just called your name to get your attention. Greet them briefly and ask how you can help. Keep it to one short sentence.]"
            );

            this.setState(AssistantState.Speaking);
            await this.movementInterface.playAudio(response.audioTrack);

            // After greeting, go to Listening to wait for their request
            this.debounceTimer = getTime();
            this.lastActivityTime = getTime();
            this.setState(AssistantState.Listening);
        } catch (error) {
            print(`ControllerAssistant: playGreeting failed: ${error}`);
            this.setState(AssistantState.Listening);
        } finally {
            this.isProcessingSpeech = false;
        }
    }

    // -----------------------------------------------------------
    // Tools
    // -----------------------------------------------------------
    private registerTools(): void {
        if (!this.llmInterface) {
            print("ControllerAssistant: LLMInterface not assigned, skipping tool registration");
            return;
        }

        // Tool: scan_objects
        this.llmInterface.registerTool({
            name: "scan_objects",
            description: "Scan the user's surroundings for objects matching a description. Use this when the user asks about objects around them or wants to find something.",
            parameters: {
                type: "object",
                properties: {
                    prompt: {
                        type: "string",
                        description: "What kind of objects to look for (e.g. 'all objects', 'cups and bottles', 'electronics')"
                    }
                },
                required: ["prompt"]
            },
            handler: async (args: { prompt: string }): Promise<string> => {
                const prevState = this.currentState;
                this.setState(AssistantState.Searching);
                try {
                    await this.triggerScan(args.prompt);
                    const objects = this.mlDetector.getTrackedObjectSummaries();
                    return JSON.stringify({ count: objects.length, objects: objects });
                } catch (error) {
                    return JSON.stringify({ error: `Scan failed: ${error}` });
                } finally {
                    // Restore to Listening (the agentic loop is still running)
                    if (this.currentState === AssistantState.Searching) {
                        this.setState(AssistantState.Listening);
                    }
                }
            }
        });

        // Tool: look_at_location
        this.llmInterface.registerTool({
            name: "look_at_location",
            description: "Make Reachy look at a world-space position for a given duration. Use get_state to obtain the robot's current position and orientation, then compute the target location relative to that. The robot will hold its gaze on the point for the specified duration before resuming normal behavior.",
            parameters: {
                type: "object",
                properties: {
                    x: {
                        type: "number",
                        description: "World X coordinate to look at"
                    },
                    y: {
                        type: "number",
                        description: "World Y coordinate to look at"
                    },
                    z: {
                        type: "number",
                        description: "World Z coordinate to look at"
                    },
                    duration: {
                        type: "number",
                        description: "How long to look at the location in seconds (default: 3)"
                    }
                },
                required: ["x", "y", "z"]
            },
            handler: async (args: { x: number; y: number; z: number; duration?: number }): Promise<string> => {
                const dur = args.duration ?? 3;
                const target = new vec3(args.x, args.y, args.z);

                // Set timed look-at override
                this.lookAtOverrideTarget = target;
                this.lookAtOverrideEndTime = getTime() + dur;

                // Wait for the look duration before returning to the agentic loop
                await new Promise<void>((resolve) => {
                    const delayEvent = this.createEvent("DelayedCallbackEvent") as DelayedCallbackEvent;
                    delayEvent.bind(() => resolve());
                    delayEvent.reset(dur);
                });

                return JSON.stringify({ success: true, looked_at: { x: args.x, y: args.y, z: args.z }, duration: dur });
            }
        });

        // Tool: get_state
        this.llmInterface.registerTool({
            name: "get_state",
            description: "Get the robot's current world position and orientation. Useful for computing relative positions (e.g. 'look to your left' or 'look behind you'). Returns the head world position, current head angles (yaw, pitch, roll in radians), and body yaw.",
            parameters: {
                type: "object",
                properties: {},
                required: []
            },
            handler: async (): Promise<string> => {
                const headPos = this.headRoot.getTransform().getWorldPosition();
                return JSON.stringify({
                    position: { x: headPos.x, y: headPos.y, z: headPos.z },
                    head: {
                        yaw: this.headYaw,
                        pitch: this.headPitch,
                        roll: this.headRoll
                    },
                    bodyYaw: this.bodyYaw
                });
            }
        });

        print("ControllerAssistant: Tools registered");
    }

    // -----------------------------------------------------------
    // Object Detection
    // -----------------------------------------------------------

    public async triggerScan(prompt: string): Promise<void> {
        if (this.isScanning) {
            return;
        }
        if (!prompt || prompt.trim().length === 0) {
            throw new Error("ControllerAssistant: prompt is required");
        }

        this.isScanning = true;

        try {
            await this.mlDetector.requestObjectDetection(prompt, this.objectMarkerPrefab);
        } catch (error) {
            print(`ControllerAssistant: Scan failed: ${error}`);
            throw error;
        } finally {
            this.isScanning = false;
        }
    }

    public clearAllMarkers(): void {
        if (this.mlDetector) this.mlDetector.clearAll();
    }

    public getIsScanning(): boolean {
        return this.isScanning;
    }

    public getTrackedObjectCount(): number {
        return this.mlDetector ? this.mlDetector.getTrackedObjectCount() : 0;
    }

    // -----------------------------------------------------------
    // Frame Update
    // -----------------------------------------------------------

    public updateMovement(): void {
        if (this.currentState === AssistantState.Inactive) return;
        if (!this.movementInterface || !this.headRoot) return;

        const now = getTime();

        // --- Session timeout check ---
        // Close the session if the user hasn't spoken and no response is being generated
        if (this.isSessionActive && !this.isProcessingSpeech
            && (this.currentState === AssistantState.Idle || this.currentState === AssistantState.Listening)) {
            const timeSinceActivity = now - this.lastActivityTime;
            if (timeSinceActivity > this.SESSION_TIMEOUT_SEC) {
                print("ControllerAssistant: Session timed out");
                this.closeSession();
                this.setState(AssistantState.Idle);
            }
        }

        // --- Movement ---
        const isIdle = this.currentState === AssistantState.Idle;

        // State-dependent smoothing
        const yawSmoothing = isIdle ? this.HEAD_YAW_SMOOTHING_IDLE : this.HEAD_YAW_SMOOTHING_FAST;
        const pitchSmoothing = isIdle ? this.HEAD_PITCH_SMOOTHING_IDLE : this.HEAD_PITCH_SMOOTHING_FAST;
        const bodySmoothing = isIdle ? this.BODY_SMOOTHING_IDLE : this.BODY_SMOOTHING_FAST;
        const rollSmoothing = isIdle ? this.ROLL_SMOOTHING_IDLE : this.ROLL_SMOOTHING_FAST;
        const antennaSmoothing = isIdle ? this.ANTENNA_SMOOTHING_IDLE : this.ANTENNA_SMOOTHING_FAST;
        const ySmoothing = isIdle ? this.Y_SMOOTHING_IDLE : this.Y_SMOOTHING_FAST;
        const maxYawDelta = isIdle ? this.MAX_YAW_DELTA_IDLE : this.MAX_YAW_DELTA_FAST;
        const maxPitchDelta = isIdle ? this.MAX_PITCH_DELTA_IDLE : this.MAX_PITCH_DELTA_FAST;

        // 1. Desired head angles
        const desired = this.computeDesiredAngles(now);

        // 2. Smooth interpolation
        this.headYaw += this.dampen((desired.yaw - this.headYaw) * yawSmoothing, maxYawDelta);
        this.headPitch += this.dampen((desired.pitch - this.headPitch) * pitchSmoothing, maxPitchDelta);
        this.headPitch = this.clamp(this.headPitch, this.MIN_PITCH, this.MAX_PITCH);

        // 3. Body follows head
        const relYaw = this.headYaw - this.bodyYaw;
        const strength = Math.abs(relYaw) > this.MAX_HEAD_YAW * 0.5 ? bodySmoothing * 2 : bodySmoothing;
        if (Math.abs(relYaw) > this.MAX_HEAD_YAW) {
            const excess = Math.abs(relYaw) - this.MAX_HEAD_YAW;
            this.bodyYaw += this.dampen(Math.sign(relYaw) * excess * bodySmoothing * 8, maxYawDelta);
        } else {
            this.bodyYaw += relYaw * strength;
        }
        this.bodyYaw = this.clamp(this.bodyYaw, -this.MAX_BODY_YAW, this.MAX_BODY_YAW);
        this.headYaw = this.clamp(this.headYaw, -(this.MAX_BODY_YAW + this.MAX_HEAD_YAW), this.MAX_BODY_YAW + this.MAX_HEAD_YAW);

        // 4. Roll: yaw-velocity coupling + ambient sway + random glance offset
        const yawVel = this.headYaw - this.prevHeadYaw;
        this.prevHeadYaw = this.headYaw;
        const rollAmp = this.getAmplitude(5, 7, 7, 10);
        const ambientRoll = Math.sin(now * 0.23) * Math.sin(now * 0.71) * rollAmp;
        const desiredRoll = -yawVel * this.ROLL_YAW_COUPLING / yawSmoothing
            + ambientRoll + this.glanceOffsetRoll;
        this.headRoll += (this.clamp(desiredRoll, -this.MAX_ROLL, this.MAX_ROLL) - this.headRoll) * rollSmoothing;

        // 5. Vertical bob
        const yAmp = this.getAmplitude(0.006, 0.012, 0.018, 0.008);
        const desiredY = this.dualSine(now, 0.41, 0.29) * yAmp;
        this.headY += (desiredY - this.headY) * ySmoothing;

        // 6. Antennas
        const antAmp = this.getAmplitude(18, 20, 22, 30);
        const desiredL = this.dualSine(now, 1.3, 3.11) * antAmp;
        const desiredR = this.dualSine(now, 1.7, 2.73) * antAmp;
        this.antennaLeft += (desiredL - this.antennaLeft) * antennaSmoothing;
        this.antennaRight += (desiredR - this.antennaRight) * antennaSmoothing;

        // 7. Send
        this.movementInterface.setTarget(
            { x: 0, y: this.headY, z: 0, roll: this.headRoll, pitch: this.headPitch, yaw: this.headYaw },
            this.bodyYaw,
            [this.antennaLeft, this.antennaRight]
        ).catch(() => {});
    }

    // ------------------------------------------------  
    // Per-state target computation
    // ------------------------------------------------

    private computeDesiredAngles(now: number): { yaw: number; pitch: number } {
        // Timed look-at override takes priority over state-based behavior
        if (this.lookAtOverrideTarget && now < this.lookAtOverrideEndTime) {
            return this.anglesToTarget(this.lookAtOverrideTarget);
        }
        // Clear expired override
        if (this.lookAtOverrideTarget && now >= this.lookAtOverrideEndTime) {
            this.lookAtOverrideTarget = null;
        }

        switch (this.currentState) {
            case AssistantState.Idle:
                return this.computeGlanceTarget(now, 0.5, 1.5, 1.5, 4.0, 40, 22);
            case AssistantState.Listening:
                return this.computeListeningTarget(now);
            case AssistantState.Speaking:
                return this.computeSpeakingTarget(now);
            case AssistantState.Searching:
                return this.computeSearchingTarget(now);
            default:
                return { yaw: this.headYaw, pitch: this.headPitch };
        }
    }

    /**
     * Listening behavior: look directly at the user with gentle attentive nods.
     * Minimal glancing away to show attentiveness.
     */
    private computeListeningTarget(now: number): { yaw: number; pitch: number } {
        const base = this.computeGlanceTarget(now, 2.0, 5.0, 0.3, 0.8, 8, 5);
        const nod = Math.sin((now - this.listeningStartTime) * this.LISTEN_NOD_SPEED) * this.LISTEN_NOD_AMPLITUDE;
        return { yaw: base.yaw, pitch: base.pitch + nod };
    }

    /**
     * Look at camera with periodic glances away.
     * Params: lookMin/Max = seconds looking at camera, glanceMin/Max = seconds glancing,
     * yawDeg/pitchDeg = max glance offset in degrees.
     */
    private computeGlanceTarget(
        now: number,
        lookMin: number, lookMax: number,
        glanceMin: number, glanceMax: number,
        yawDeg: number, pitchDeg: number
    ): { yaw: number; pitch: number } {
        if (now >= this.nextGlanceChangeTime) {
            const rollRange = 10 * Math.PI / 180;
            if (this.isGlancingAway) {
                this.isGlancingAway = false;
                this.nextGlanceChangeTime = now + this.randomRange(lookMin, lookMax);
                this.glanceOffsetYaw = 0;
                this.glanceOffsetPitch = 0;
                this.glanceOffsetRoll = this.randomRange(-rollRange * 0.3, rollRange * 0.3);
            } else {
                this.isGlancingAway = true;
                this.nextGlanceChangeTime = now + this.randomRange(glanceMin, glanceMax);
                const yr = yawDeg * Math.PI / 180;
                const pr = pitchDeg * Math.PI / 180;
                this.glanceOffsetYaw = this.randomRange(-yr, yr);
                this.glanceOffsetPitch = this.randomRange(-pr * 0.8, pr * 0.3);
                this.glanceOffsetRoll = this.randomRange(-rollRange, rollRange);
            }
        }
        const cam = this.anglesToTarget(this.camera.getTransform().getWorldPosition());
        return { yaw: cam.yaw + this.glanceOffsetYaw, pitch: cam.pitch + this.glanceOffsetPitch };
    }

    private computeSpeakingTarget(now: number): { yaw: number; pitch: number } {
        const base = this.computeGlanceTarget(now, 1.5, 3.5, 0.6, 1.5, 14, 8);
        const nod = Math.sin((now - this.speakingStartTime) * this.SPEAK_NOD_SPEED) * this.SPEAK_NOD_AMPLITUDE;
        return { yaw: base.yaw, pitch: base.pitch + nod };
    }

    private computeSearchingTarget(now: number): { yaw: number; pitch: number } {
        if (!this.searchTarget) return { yaw: this.headYaw, pitch: this.headPitch };
        const elapsed = now - this.searchStartTime;
        const base = this.anglesToTarget(this.searchTarget);
        return {
            yaw: base.yaw + Math.sin(elapsed * this.SEARCH_SWEEP_SPEED) * this.SEARCH_YAW_AMP,
            pitch: base.pitch + Math.sin(elapsed * this.SEARCH_SWEEP_SPEED * 1.7) * this.SEARCH_PITCH_AMP
        };
    }

    private resetGlance(lookMin: number, lookMax: number): void {
        this.isGlancingAway = false;
        this.nextGlanceChangeTime = getTime() + this.randomRange(lookMin, lookMax);
        this.glanceOffsetYaw = 0;
        this.glanceOffsetPitch = 0;
        this.glanceOffsetRoll = 0;
    }

    // ================================================================
    // Helpers
    // ================================================================

    /** Returns a per-state amplitude in radians given idle/listen/speak/search values in degrees */
    private getAmplitude(idleDeg: number, listenDeg: number, speakDeg: number, searchDeg: number): number {
        const d = Math.PI / 180;
        switch (this.currentState) {
            case AssistantState.Idle: return idleDeg * d;
            case AssistantState.Listening: return listenDeg * d;
            case AssistantState.Speaking: return speakDeg * d;
            case AssistantState.Searching: return searchDeg * d;
            default: return 0;
        }
    }

    /** Two layered sines producing an organic pattern in roughly [-1, 1] range */
    private dualSine(t: number, freqA: number, freqB: number): number {
        return Math.sin(t * freqA) * 0.6 + Math.sin(t * freqB) * 0.4;
    }

    private anglesToTarget(pos: vec3): { yaw: number; pitch: number } {
        const dir = pos.sub(this.headRoot.getTransform().getWorldPosition());
        const hDist = Math.sqrt(dir.x * dir.x + dir.z * dir.z);
        if (hDist < 0.001) {
            return { yaw: this.headYaw, pitch: dir.y > 0 ? this.MAX_PITCH : this.MIN_PITCH };
        }
        return { yaw: Math.atan2(dir.x, dir.z), pitch: -Math.atan2(dir.y, hDist) };
    }

    private dampen(delta: number, max: number): number {
        return this.clamp(delta, -max, max);
    }

    private clamp(val: number, min: number, max: number): number {
        return Math.max(min, Math.min(max, val));
    }

    private randomRange(min: number, max: number): number {
        return min + Math.random() * (max - min);
    }
}
