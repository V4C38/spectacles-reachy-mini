import { MLObjectDetector } from "./Utils/MLObjectDetector";
import { DepthCache } from "./Utils/DepthCache";
import { LLMService } from "./Utils/LLMService";
import { RobotDriver, PROFILES } from "./RobotDriver";
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
    private currentTranscription: string = "";

    // --- State ---
    public currentState: AssistantState = AssistantState.Sleeping;
    public onStateChanged: ((newState: AssistantState) => void)[] = [];
    private isPaused: boolean = false;

    // --- Timers ---
    private debounceTimer: number = 0;
    private lastActivityTime: number = 0;

    // --- Configuration ---
    private readonly WAKE_WORDS = ["reachy", "richie", "richy", "reach", "reachie", "ritchie", "richi", "reechy", "reechi", "reachi"];
    private readonly GREETING_PROMPT = "[The user just called your name to get your attention. Respond in a friendly and slightly funny way as if you have just woken up. One short sentence.]";
    private readonly IDLE_TIMEOUT_SEC = 30.0;
    private readonly WAKE_SILENCE_MS = 1500;
    private readonly CONVO_SILENCE_MS = 2000;

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

        // --- Set gaze target based on state ---
        switch (this.currentState) {
            case AssistantState.Sleeping:
                this.robotDriver.setSleepPose();
                break;
            case AssistantState.Idle:
            case AssistantState.Listening:
            case AssistantState.Speaking:
                this.robotDriver.lookAtCamera(this.camera);
                break;
            case AssistantState.Searching:
                this.updateSearchSweep(now);
                break;
        }

        // --- Look-at override takes priority ---
        if (this.lookAtOverrideTarget) {
            if (now < this.lookAtOverrideEndTime) {
                this.robotDriver.lookAt(this.lookAtOverrideTarget);
            } else {
                this.lookAtOverrideTarget = null;
            }
        }
        this.robotDriver.updateFrame();
    }

    private updateSearchSweep(now: number): void {
        if (!this.searchTarget || !this.robotDriver) return;
        const elapsed = now - this.searchStartTime;
        const base = this.robotDriver.anglesToTarget(this.searchTarget);
        this.robotDriver.lookAtAngles(
            base.yaw + Math.sin(elapsed * this.SEARCH_SWEEP_SPEED) * this.SEARCH_YAW_AMP,
            base.pitch + Math.sin(elapsed * this.SEARCH_SWEEP_SPEED * 1.7) * this.SEARCH_PITCH_AMP
        );
    }

    // ------------------------------------------------------------
    // State
    // ------------------------------------------------------------
    public activate(): void {
        if (!this.robotDriver) return;
        this.robotDriver.reset();

        this.setState(AssistantState.Sleeping);
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

    private enterSleeping(): void {
        this.closeSession();
        if (this.robotDriver) {
            this.robotDriver.setSleepPose();
            this.robotDriver.setProfile(PROFILES.sleeping);
        }
    }

    private enterIdle(): void {
        this.lastActivityTime = getTime();
        if (this.robotDriver) {
            this.robotDriver.setProfile(PROFILES.idle);
            this.robotDriver.clearNod();
            this.robotDriver.setGlanceBehavior({
                lookMinSec: 0.5, lookMaxSec: 1.5,
                glanceMinSec: 1.5, glanceMaxSec: 4.0,
                yawOffsetDeg: 40, pitchOffsetDeg: 22
            });
        }
    }

    private enterListening(): void {
        this.lastActivityTime = getTime();
        if (this.robotDriver) {
            this.robotDriver.setProfile(PROFILES.listening);
            this.robotDriver.setNod(1.5, 2);
            this.robotDriver.setGlanceBehavior({
                lookMinSec: 2.0, lookMaxSec: 5.0,
                glanceMinSec: 0.3, glanceMaxSec: 0.8,
                yawOffsetDeg: 8, pitchOffsetDeg: 5
            });
        }
    }

    private enterSpeaking(): void {
        this.lastActivityTime = getTime();
        if (this.robotDriver) {
            this.robotDriver.setProfile(PROFILES.speaking);
            this.robotDriver.setNod(2.5, 3);
            this.robotDriver.setGlanceBehavior({
                lookMinSec: 1.5, lookMaxSec: 3.5,
                glanceMinSec: 0.6, glanceMaxSec: 1.5,
                yawOffsetDeg: 14, pitchOffsetDeg: 8
            });
        }
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
        if (this.robotDriver) {
            this.robotDriver.setProfile(PROFILES.searching);
            this.robotDriver.clearNod();
            this.robotDriver.setGlanceBehavior(null);
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


    // ----------------------------------------------------------------
    // Conversation Management
    // ----------------------------------------------------------------
    private openSession(): void {
        this.lastActivityTime = getTime();
        this.debounceTimer = 0;
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

        if (!isFinal) {
            this.currentTranscription = text;
            print(`AssistantMode: ASR partial: "${text}"`);
            this.logDebug(`ASR: ${text}`);
            if (this.currentState === AssistantState.Idle) {
                this.setState(AssistantState.Listening);
            }
            return;
        }

        print(`AssistantMode: ASR final: "${text}"`);
        this.logDebug(`ASR final: ${text}`);
        this.currentTranscription = "";

        if (this.currentState === AssistantState.Sleeping) {
            this.handleWakeWordDetection(text);
        } else {
            if (text.trim().length > 0) {
                this.processUserSpeech(text);
            }
        }
    }

    private onTranscriptionError(errorCode: AsrModule.AsrStatusCode): void {
        print(`AssistantMode: ASR error: ${errorCode} state: ${AssistantState[this.currentState]})`);
        this.logDebug(`ASR error: ${errorCode}`);
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

        try {
            this.robotDriver.lookAt(this.camera.getTransform().getWorldPosition());
            const response = await this.llmInterface.sendMessage(text);

            this.setState(AssistantState.Speaking);
            this.stopASR();
            await this.robotDriver.playAudio(response.audioTrack);
            this.startASR();

            this.debounceTimer = getTime();
            this.lastActivityTime = getTime();
            this.setState(AssistantState.Idle);

        } catch (error) {
            print(`AssistantMode: processUserSpeech failed: ${error}`);
            this.logDebug(`Agent - Error: processUserSpeech failed: ${error}`);
            this.setState(AssistantState.Idle);
        }
    }

    private async playGreeting(): Promise<void> {
        if (!this.llmInterface || !this.robotDriver) {
            this.setState(AssistantState.Listening);
            this.startASR();
            return;
        }

        try {
            this.robotDriver.lookAt(this.camera.getTransform().getWorldPosition());
            const response = await this.llmInterface.sendMessage(this.GREETING_PROMPT);

            this.setState(AssistantState.Speaking);
            await this.robotDriver.playAudio(response.audioTrack);

            this.debounceTimer = getTime();
            this.lastActivityTime = getTime();
            this.setState(AssistantState.Listening);
        } catch (error) {
            print(`AssistantMode: playGreeting failed: ${error}`);
            this.logDebug(`Agent - Error: playGreeting failed: ${error}`);
            this.setState(AssistantState.Listening);
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
}