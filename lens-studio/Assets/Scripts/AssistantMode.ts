import { MLObjectDetector } from "./Utils/MLObjectDetector";
import { DepthCache } from "./Utils/DepthCache";
import { LLMService } from "./Utils/LLMService";
import { RobotDriver } from "./RobotDriver";
import { PRESETS } from "./RobotAnimationConfig";
import { AssistantTools } from "./Utils/AssistantTools";

export enum AssistantState {
    Sleeping,
    Idle,
    Listening,
    Speaking,
    Searching
}

@component
export class AssistantMode extends BaseScriptComponent {
    
    // --- Inputs ---
    @input
    public robotDriver: RobotDriver | null = null;
    @input
    public objectMarkerPrefab: ObjectPrefab;
    @input
    private camera: SceneObject;
    @input
    private depthCacheHelper: DepthCache;
    @input
    public llmInterface: LLMService | null = null;
    @input
    public mlDetector: MLObjectDetector;
    @input
    public assistantTools: AssistantTools | null = null;


    // --- ASR / Speech to Text ---
    public asrModule: AsrModule = require("LensStudio:AsrModule");
    public onSessionChanged: ((active: boolean) => void)[] = [];
    public onErrorOccurred: ((message: string) => void)[] = [];
    private currentTranscription: string = "";

    // --- State ---
    public currentState: AssistantState = AssistantState.Idle;
    public onStateChanged: ((newState: AssistantState) => void)[] = [];
    private isPaused: boolean = false;

    // --- Pending animation (set by tool call, started alongside TTS) ---
    public pendingAnimationName: string | null = null;

    // --- Timers ---
    private debounceTimer: number = 0;
    private lastActivityTime: number = 0;
    private postSpeakListeningEndTime: number = 0;
    private isProcessingSpeech: boolean = false;

    // --- Configuration ---
    private readonly WAKE_WORDS = ["reachy", "richie", "richy", "reach", "reachie", "ritchie", "richi", "reechy", "reechi", "reachi"];
    private readonly GREETING_PROMPT = "[The user just called your name to get your attention. Respond in a friendly and slightly funny way as if you have just woken up. One short sentence.]";
    private readonly IDLE_TIMEOUT_SEC = 45.0;
    private readonly WAKE_SILENCE_MS = 1500;
    private readonly CONVO_SILENCE_MS = 2000;
    private readonly POST_SPEAK_LISTENING_SEC = 4.0;

    // --- Idle wander ---
    private idleTarget: vec3 | null = null;
    private nextIdleTargetTime: number = 0;
    private readonly IDLE_LOOK_DISTANCE = 200;

    // --- Nod (applied by varying gaze target Y) ---
    private readonly NOD_LISTENING = { freq: 1.5, amp: 5 };
    private readonly NOD_SPEAKING  = { freq: 2.5, amp: 8 };

    // --- Searching ---
    private searchTarget: vec3 | null = null;
    private searchStartTime: number = 0;
    private readonly SEARCH_SWEEP_SPEED = 0.8;
    private readonly SEARCH_YAW_AMP = 20 * Math.PI / 180;
    private readonly SEARCH_PITCH_AMP = 10 * Math.PI / 180;

    // --- Look-at override (timed gaze from tool calls) ---
    public lookAtOverrideTarget: vec3 | null = null;
    public lookAtOverrideEndTime: number = 0;

    @input
    private textDebugInfo: Text | null = null;

    private logDebug(message: string): void {
        if (this.textDebugInfo) {
            this.textDebugInfo.text = message;
        }
    }

    onAwake() {
        this.createEvent("OnStartEvent").bind(() => {
            this.registerTools();
        });
    }

    // ----------------------------------------------------------------
    // Update Loop
    // ----------------------------------------------------------------
    public updateFrame(): void {
        if (!this.robotDriver || this.robotDriver.getIsPaused()) return;

        const now = getTime();

        // --- Idle timeout: go back to sleep after no activity ---
        if (this.currentState === AssistantState.Idle) {
            if (now - this.lastActivityTime >= this.IDLE_TIMEOUT_SEC) {
                this.setState(AssistantState.Sleeping);
            }
        }
        
        if (this.currentState === AssistantState.Listening && this.postSpeakListeningEndTime > 0) {
            if (now >= this.postSpeakListeningEndTime) {
                this.postSpeakListeningEndTime = 0;
                this.setState(AssistantState.Idle);
            }
        }

        // --- Look-at override takes priority over state-based gaze ---
        if (this.lookAtOverrideTarget) {
            if (now < this.lookAtOverrideEndTime) {
                this.robotDriver.setGazeTarget(this.lookAtOverrideTarget);
                // Exact tracking during override (no gaze variation)
                this.robotDriver.setParams({ gazeVariation: 0 });
                this.robotDriver.updateFrame();
                return;
            } else {
                // Override expired -- restore state params
                this.lookAtOverrideTarget = null;
                this.applyStateParams();
            }
        }

        // --- Set gaze target based on state ---
        const cameraPos = this.camera.getTransform().getWorldPosition();

        switch (this.currentState) {
            case AssistantState.Sleeping:
                this.robotDriver.setGazeTarget(null);
                break;

            case AssistantState.Idle:
                this.updateIdleWander(now, cameraPos);
                break;

            case AssistantState.Listening:
                this.robotDriver.setGazeTarget(
                    cameraPos.add(new vec3(0, Math.sin(now * this.NOD_LISTENING.freq) * this.NOD_LISTENING.amp, 0))
                );
                break;

            case AssistantState.Speaking:
                this.robotDriver.setGazeTarget(
                    cameraPos.add(new vec3(0, Math.sin(now * this.NOD_SPEAKING.freq) * this.NOD_SPEAKING.amp, 0))
                );
                break;

            case AssistantState.Searching:
                this.updateSearchSweep(now);
                break;
        }

        this.robotDriver.updateFrame();
    }

    // ----------------------------------------------------------------
    // Idle: look around slowly, occasionally at camera
    // ----------------------------------------------------------------
    private updateIdleWander(now: number, cameraPos: vec3): void {
        if (!this.robotDriver) return;

        if (now > this.nextIdleTargetTime || !this.idleTarget) {
            if (Math.random() < 0.3) {
                // 30% chance: look at user
                this.idleTarget = cameraPos;
            } else {
                // 70% chance: look somewhere around the room
                this.idleTarget = this.randomLookTarget();
            }
            this.nextIdleTargetTime = now + this.randomRange(3, 6);
        }

        this.robotDriver.setGazeTarget(this.idleTarget);
    }

    private randomLookTarget(): vec3 {
        const headPos = this.robotDriver!.getHeadWorldPosition();
        const baseRot = this.robotDriver!.getBaseRotation() || quat.quatIdentity();

        // Robot forward and right in world space
        const forward = baseRot.multiplyVec3(new vec3(0, 0, 1));
        const right = baseRot.multiplyVec3(new vec3(1, 0, 0));

        // Random point in a wide cone around robot forward
        const rightAmount = this.randomRange(-150, 150);
        const upAmount = this.randomRange(-30, 60);

        return headPos
            .add(forward.uniformScale(this.IDLE_LOOK_DISTANCE))
            .add(right.uniformScale(rightAmount))
            .add(new vec3(0, upAmount, 0));
    }

    // ----------------------------------------------------------------
    // Searching: sweep around the search target
    // ----------------------------------------------------------------
    private updateSearchSweep(now: number): void {
        if (!this.searchTarget || !this.robotDriver) return;
        const elapsed = now - this.searchStartTime;
        const headPos = this.robotDriver.getHeadWorldPosition();
        const toTarget = this.searchTarget.sub(headPos);
        const dist = toTarget.length;

        // Build perpendicular axes from the direction to target
        const forward = toTarget.normalize();
        const right = forward.cross(new vec3(0, 1, 0)).normalize();
        const up = new vec3(0, 1, 0);

        // Oscillating offset
        const yawOffset = Math.sin(elapsed * this.SEARCH_SWEEP_SPEED) * dist * Math.tan(this.SEARCH_YAW_AMP);
        const pitchOffset = Math.sin(elapsed * this.SEARCH_SWEEP_SPEED * 1.7) * dist * Math.tan(this.SEARCH_PITCH_AMP);

        this.robotDriver.setGazeTarget(
            this.searchTarget.add(right.uniformScale(yawOffset)).add(up.uniformScale(pitchOffset))
        );
    }

    // ------------------------------------------------------------
    // State
    // ------------------------------------------------------------
    public activate(): void {
        if (!this.robotDriver) return;
        this.robotDriver.reset();

        // Force currentState so setState(Sleeping) always runs enterSleeping(),
        // even if we were already Sleeping from a previous session.
        this.currentState = AssistantState.Idle;
        this.setState(AssistantState.Sleeping);
        this.robotDriver.snapToCurrentParams();  // Snap to sleeping pose immediately
        this.startASR();
    }

    public deactivate(): void {
        this.stopASR();
        this.mlDetector.clearAllDetections();
        if (this.robotDriver) {
            this.robotDriver.pause();
        }
    }

    public pause(): void {
        this.isPaused = true;
        if (this.robotDriver) {
            this.robotDriver.pause();
        }
    }

    public resume(): void {
        this.isPaused = false;
        if (this.robotDriver) {
            this.robotDriver.resume();
        }
        this.logDebug(`Agent - State: ${AssistantState[this.currentState]}`);
    }

    public setState(newState: AssistantState): void {
        if (this.currentState === newState) return;
        const oldState = this.currentState;
        this.currentState = newState;

        switch (newState) {
            case AssistantState.Sleeping:
                this.enterSleeping();
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
        print(`AssistantMode: ${AssistantState[oldState]} -> ${AssistantState[newState]}`);
        this.logDebug(`Agent - State: ${AssistantState[newState]}`);
        this.onStateChanged.forEach(cb => cb(newState));
    }

    public getState(): AssistantState {
        return this.currentState;
    }

    /** Apply the correct preset for the current state. */
    private applyStateParams(): void {
        if (!this.robotDriver) return;
        switch (this.currentState) {
            case AssistantState.Sleeping:  this.robotDriver.setParams(PRESETS.sleeping);  break;
            case AssistantState.Idle:      this.robotDriver.setParams(PRESETS.idle);      break;
            case AssistantState.Listening: this.robotDriver.setParams(PRESETS.listening); break;
            case AssistantState.Speaking:  this.robotDriver.setParams(PRESETS.speaking);  break;
            case AssistantState.Searching: this.robotDriver.setParams(PRESETS.searching); break;
        }
    }

    private enterSleeping(): void {
        this.closeSession();
        this.postSpeakListeningEndTime = 0;
        if (this.robotDriver) {
            this.robotDriver.clearLocalAnimation();
            this.robotDriver.setParams(PRESETS.sleeping);
            this.robotDriver.setGazeTarget(null);
        }
    }

    private enterIdle(): void {
        this.lastActivityTime = getTime();
        this.postSpeakListeningEndTime = 0;
        this.idleTarget = null;
        this.nextIdleTargetTime = 0;
        if (this.robotDriver) {
            this.robotDriver.setParams(PRESETS.idle);
        }
    }

    private enterListening(): void {
        this.lastActivityTime = getTime();
        if (this.robotDriver) {
            this.robotDriver.setParams(PRESETS.listening);
        }
    }

    private enterSpeaking(): void {
        this.lastActivityTime = getTime();
        this.postSpeakListeningEndTime = 0;
        if (this.robotDriver) {
            this.robotDriver.setParams(PRESETS.speaking);
        }
    }

    private enterSearching(): void {
        this.searchStartTime = getTime();
        this.postSpeakListeningEndTime = 0;
        this.searchTarget = null;
        if (this.depthCacheHelper) {
            this.searchTarget = this.depthCacheHelper.getForwardIntersection();
        }
        if (!this.searchTarget && this.camera) {
            const cam = this.camera.getTransform();
            this.searchTarget = cam.getWorldPosition().add(cam.forward.uniformScale(200));
        }
        if (this.robotDriver) {
            this.robotDriver.setParams(PRESETS.searching);
        }
    }

    public setSpeaking(speaking: boolean): void {
        if (this.currentState === AssistantState.Sleeping || this.currentState === AssistantState.Searching) return;
        if (speaking && this.currentState === AssistantState.Idle) {
            this.setState(AssistantState.Speaking);
        } else if (!speaking && this.currentState === AssistantState.Speaking) {
            this.setState(AssistantState.Idle);
        }
    }

    /** World position of the AR headset (user) camera. Use for answering POV questions (e.g. "to your left"). */
    public getViewerCameraWorldPosition(): vec3 | null {
        if (!this.camera) return null;
        return this.camera.getTransform().getWorldPosition();
    }

    /** World rotation of the AR headset (user) camera. Use for answering POV questions. */
    public getViewerCameraWorldRotation(): quat | null {
        if (!this.camera) return null;
        return this.camera.getTransform().getWorldRotation();
    }

    // ----------------------------------------------------------------
    // Conversation Management
    // ----------------------------------------------------------------
    private openSession(): void {
        this.lastActivityTime = getTime();
        this.debounceTimer = 0;
        this.registerTools();
        print("AssistantMode: Conversation session opened");
        this.onSessionChanged.forEach(cb => cb(true));
    }

    private closeSession(): void {
        if (this.llmInterface) {
            this.llmInterface.clearHistory();
        }
        print("AssistantMode: Conversation session closed");
        this.onSessionChanged.forEach(cb => cb(false));
    }

    // ------------------------------------------------------------
    // ASR / Text to Speech 
    // ------------------------------------------------------------
    private startASR(): void {
        const options = AsrModule.AsrTranscriptionOptions.create();
        options.silenceUntilTerminationMs = this.currentState === AssistantState.Sleeping ? this.WAKE_SILENCE_MS : this.CONVO_SILENCE_MS;
        options.mode = AsrModule.AsrMode.HighSpeed;

        options.onTranscriptionUpdateEvent.add((eventArgs: AsrModule.TranscriptionUpdateEvent) => {
            this.onTranscriptionUpdate(eventArgs);
        });

        options.onTranscriptionErrorEvent.add((errorCode: AsrModule.AsrStatusCode) => {
            this.onTranscriptionError(errorCode);
        });

        this.asrModule.startTranscribing(options);
        this.currentTranscription = "";

        print("TTS / ASR started");
    }

    private stopASR(): void {
        this.currentTranscription = "";
        this.asrModule.stopTranscribing();
        print("TTS / ASR stopped");
    }

    private onTranscriptionUpdate(eventArgs: AsrModule.TranscriptionUpdateEvent): void {
        const text = eventArgs.text;
        const isFinal = eventArgs.isFinal;

        if (this.isPaused) return;

        if (this.currentState === AssistantState.Idle) {
            this.setState(AssistantState.Listening);
        }
        
        if (!isFinal) {
            this.currentTranscription = text;
            print(`AssistantMode: ASR partial: "${text}"`);
            this.logDebug(`ASR: ${text}`);
            return;
        }

        print(`AssistantMode: ASR final: "${text}"`);
        this.logDebug(`ASR final: ${text}`);
        this.currentTranscription = "";

        if (this.currentState === AssistantState.Sleeping) {
            this.handleWakeWordDetection(text);
        } else {
            if (text.trim().length > 0) {
                if (this.currentState === AssistantState.Speaking) {
                    return;
                }
                this.postSpeakListeningEndTime = 0;
                this.processUserSpeech(text);
            }
        }
    }

    private onTranscriptionError(errorCode: AsrModule.AsrStatusCode): void {
        const message = `ASR error: ${errorCode}`;
        print(`AssistantMode: ${message} state: ${AssistantState[this.currentState]})`);
        this.logDebug(message);
        this.onErrorOccurred.forEach(cb => cb(message));
        print("AssistantMode: Restarting ASR after error...");
        this.startASR();
    }

    private handleWakeWordDetection(text: string): void {
        const lowerText = text.toLowerCase().trim();

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

        if (wakeIndex < 0) return;

        print(`AssistantMode: Wake word detected in: "${text}"`);
        if (this.currentState === AssistantState.Sleeping) {
            this.setState(AssistantState.Idle);
        }
        this.openSession();

        const afterWake = text.substring(wakeIndex + matchedLength).trim();
        const cleaned = afterWake.replace(/^[,.\s!?]+/, "").trim();

        if (cleaned.length > 0) {
            this.processUserSpeech(cleaned);
        } else {
            this.playGreeting();
        }
    }

    private async processUserSpeech(text: string): Promise<void> {
        if (!this.llmInterface || !this.robotDriver) {
            print("AssistantMode: LLMService or RobotDriver not initialized");
            return;
        }
        if (this.isProcessingSpeech) {
            return;
        }
        this.isProcessingSpeech = true;

        try {
            this.robotDriver.setGazeTarget(this.camera.getTransform().getWorldPosition());
            this.pendingAnimationName = null;
            const response = await this.llmInterface.sendMessage(text);

            this.setState(AssistantState.Speaking);
            this.stopASR();

            // Start pending animation (motion-only, no SFX) alongside TTS
            if (this.pendingAnimationName) {
                const animName = this.pendingAnimationName;
                this.pendingAnimationName = null;
                this.robotDriver.playAnimation(animName, true).catch((err) => {
                    print(`AssistantMode: pending animation failed: ${err}`);
                });
            }

            await this.robotDriver.playAudio(response.audioTrack);
            this.startASR();
            this.setState(AssistantState.Listening);
            this.postSpeakListeningEndTime = getTime() + this.POST_SPEAK_LISTENING_SEC;

            this.debounceTimer = getTime();
            this.lastActivityTime = getTime();
        } catch (error) {
            const message = `processUserSpeech failed: ${error}`;
            print(`AssistantMode: ${message}`);
            this.logDebug(`Agent - Error: ${message}`);
            this.onErrorOccurred.forEach(cb => cb(message));
            this.setState(AssistantState.Idle);
        } finally {
            this.pendingAnimationName = null;
            this.isProcessingSpeech = false;
        }
    }

    private async playGreeting(): Promise<void> {
        if (!this.llmInterface || !this.robotDriver) {
            this.setState(AssistantState.Listening);
            this.startASR();
            return;
        }

        try {
            this.robotDriver.setGazeTarget(this.camera.getTransform().getWorldPosition());
            this.pendingAnimationName = null;
            const response = await this.llmInterface.sendMessage(this.GREETING_PROMPT);

            this.setState(AssistantState.Speaking);
            this.stopASR();

            // Start pending animation (motion-only, no SFX) alongside TTS
            if (this.pendingAnimationName) {
                const animName = this.pendingAnimationName;
                this.pendingAnimationName = null;
                this.robotDriver.playAnimation(animName, true).catch((err) => {
                    print(`AssistantMode: pending animation failed: ${err}`);
                });
            }

            await this.robotDriver.playAudio(response.audioTrack);
            this.startASR();

            this.debounceTimer = getTime();
            this.lastActivityTime = getTime();
            this.setState(AssistantState.Listening);
            this.postSpeakListeningEndTime = getTime() + this.POST_SPEAK_LISTENING_SEC;
        } catch (error) {
            const message = `playGreeting failed: ${error}`;
            print(`AssistantMode: ${message}`);
            this.logDebug(`Agent - Error: ${message}`);
            this.onErrorOccurred.forEach(cb => cb(message));
            this.setState(AssistantState.Listening);
        } finally {
            this.pendingAnimationName = null;
        }
    }


    // ----------------------------------------------------------------
    // LLM Tools
    // ----------------------------------------------------------------
    private registerTools(): void {
        if (this.llmInterface && this.assistantTools) {
            this.assistantTools.registerTools(this.llmInterface);
        }
    }

    // ----------------------------------------------------------------
    // Helpers
    // ----------------------------------------------------------------
    private randomRange(min: number, max: number): number {
        return min + Math.random() * (max - min);
    }
}
