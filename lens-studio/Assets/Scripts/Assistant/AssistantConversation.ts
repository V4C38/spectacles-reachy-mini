import { LLMService } from "./LLMService";
import { RobotDriver } from "../RobotDriver/RobotDriver";
import { ToolFactory } from "./Tools/ToolFactory";
import { AssistantMode, AssistantState } from "./AssistantMode";

/**
 * Handles all speech / ASR / wake-word / LLM conversation flow.
 * Created by AssistantMode; not a @component itself.
 */
export class AssistantConversation {

    // --- ASR state ---
    private currentTranscription: string = "";
    private asrOptions: AsrModule.AsrTranscriptionOptions | null = null;
    private readonly MAX_ASR_ERROR_RETRIES = 3;
    private readonly ASR_ERROR_RETRY_DELAY_SEC = 0.5;
    public isSessionActive: boolean = false;

    // --- Timers (public so AssistantMode.updateFrame can read them) ---
    public lastActivityTime: number = 0;
    public postSpeakListeningEndTime: number = 0;
    private debounceTimer: number = 0;
    private isProcessingSpeech: boolean = false;
    public isPaused: boolean = false;
    private asrErrorCount: number = 0;
    private isAsrMarkedActive: boolean = false;

    // --- Configuration ---
    private readonly WAKE_WORDS = ["reachy", "richie", "richy", "reach", "reachie", "ritchie", "richi", "reechy", "reechi", "reachi"];
    private readonly GREETING_PROMPT = "[The user just called your name to get your attention. Respond in a friendly and slightly funny way as if you have just woken up. One short sentence.]";
    private readonly WAKE_SILENCE_MS = 1500;
    private readonly CONVO_SILENCE_MS = 2000;
    private readonly POST_SPEAK_LISTENING_SEC = 4.0;

    constructor(
        private mode: AssistantMode,
        private robotDriver: RobotDriver | null,
        private llmInterface: LLMService | null,
        private assistantTools: ToolFactory | null,
        private camera: SceneObject,
        private asrModule: AsrModule,
    ) {
        this.initAsrOptions();
    }

    private initAsrOptions(): void {
        if (this.asrOptions) return;
        const options = AsrModule.AsrTranscriptionOptions.create();
        options.mode = AsrModule.AsrMode.HighAccuracy;
        options.onTranscriptionUpdateEvent.add((eventArgs: AsrModule.TranscriptionUpdateEvent) => {
            this.onTranscriptionUpdate(eventArgs);
        });
        options.onTranscriptionErrorEvent.add((errorCode: AsrModule.AsrStatusCode) => {
            this.onTranscriptionError(errorCode);
        });
        this.asrOptions = options;
    }

    // ----------------------------------------------------------------
    // Session Management
    // ----------------------------------------------------------------
    private openSession(): void {
        this.lastActivityTime = getTime();
        this.debounceTimer = 0;
        this.isSessionActive = true;
        this.asrErrorCount = 0;
        this.registerTools();
        print("AssistantMode: Conversation session opened");
        this.mode.onSessionChanged.forEach(cb => cb(true));
    }

    public closeSession(): void {
        this.isSessionActive = false;
        if (this.llmInterface) {
            this.llmInterface.clearHistory();
        }
        print("AssistantMode: Conversation session closed");
        this.mode.onSessionChanged.forEach(cb => cb(false));
    }

    public registerTools(): void {
        if (this.llmInterface && this.assistantTools) {
            this.assistantTools.registerTools(this.llmInterface);
        }
    }

    // ----------------------------------------------------------------
    // ASR / Speech to Text
    // ----------------------------------------------------------------
    public startASR(): void {
        this.initAsrOptions();
        const state = this.mode.getState();
        const silenceMs = state === AssistantState.Sleeping ? this.WAKE_SILENCE_MS : this.CONVO_SILENCE_MS;
        this.asrOptions!.silenceUntilTerminationMs = silenceMs;

        if (this.isAsrMarkedActive) {
            this.asrModule.stopTranscribing().then(() => this.beginTranscribing());
            return;
        }
        this.beginTranscribing();
    }

    private beginTranscribing(): void {
        this.asrModule.startTranscribing(this.asrOptions!);
        this.currentTranscription = "";
        this.isAsrMarkedActive = true;
        print("TTS / ASR started");
    }

    public stopASR(): void {
        this.currentTranscription = "";
        this.isAsrMarkedActive = false;
        this.asrModule.stopTranscribing();
        print("TTS / ASR stopped");
    }

    private onTranscriptionUpdate(eventArgs: AsrModule.TranscriptionUpdateEvent): void {
        const text = eventArgs.text;
        const isFinal = eventArgs.isFinal;

        if (this.isPaused) return;

        if (this.mode.getState() === AssistantState.Idle) {
            this.mode.setState(AssistantState.Listening);
        }

        if (this.isSessionActive && this.mode.getState() === AssistantState.Listening) {
            this.postSpeakListeningEndTime = getTime() + this.POST_SPEAK_LISTENING_SEC;
        }

        if (!isFinal) {
            this.currentTranscription = text;
            print(`AssistantMode: ASR partial: "${text}"`);
            this.mode.logDebug(`ASR: ${text}`);
            return;
        }

        print(`AssistantMode: ASR final: "${text}"`);
        this.mode.logDebug(`ASR final: ${text}`);
        this.currentTranscription = "";

        const state = this.mode.getState();
        if (state === AssistantState.Sleeping) {
            this.handleWakeWordDetection(text);
        } else {
            if (text.trim().length > 0) {
                if (state === AssistantState.Speaking) {
                    return;
                }
                this.postSpeakListeningEndTime = 0;
                this.processUserSpeech(text);
            }
        }
    }

    private onTranscriptionError(errorCode: AsrModule.AsrStatusCode): void {
        const state = this.mode.getState();
        this.asrErrorCount++;
        const message = `ASR error: ${errorCode}`;
        print(`AssistantMode: ${message} state: ${AssistantState[state]})`);
        this.mode.logDebug(message);
        this.mode.onErrorOccurred.forEach(cb => cb(message));

        if (this.isAsrMarkedActive) {
            this.stopASR();
        }

        if (
            errorCode === AsrModule.AsrStatusCode.Unauthenticated
            || errorCode === AsrModule.AsrStatusCode.NoInternet
        ) {
            print("AssistantMode: ASR not restarted (connectivity/auth error)");
            return;
        }

        if (this.asrErrorCount > this.MAX_ASR_ERROR_RETRIES) {
            print("AssistantMode: ASR error limit reached, not restarting");
            return;
        }

        print("AssistantMode: Scheduling ASR restart after error...");
        this.mode.scheduleOnce(this.ASR_ERROR_RETRY_DELAY_SEC, () => {
            if (this.mode.getState() !== AssistantState.Speaking && !this.isPaused) {
                this.startASR();
            }
        });
    }

    // ----------------------------------------------------------------
    // Wake Word Detection
    // ----------------------------------------------------------------
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
        if (this.mode.getState() === AssistantState.Sleeping) {
            this.mode.setState(AssistantState.Idle);
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

    // ----------------------------------------------------------------
    // Speech Processing
    // ----------------------------------------------------------------
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
            const response = await this.llmInterface.sendMessage(text);

            this.mode.setState(AssistantState.Speaking);
            this.stopASR();

            await this.robotDriver.playAudio(response.audioTrack);
            this.mode.setState(AssistantState.Listening);
            this.postSpeakListeningEndTime = getTime() + this.POST_SPEAK_LISTENING_SEC;
            this.asrErrorCount = 0;
            this.startASR();

            this.debounceTimer = getTime();
            this.lastActivityTime = getTime();
        } catch (error) {
            const message = `processUserSpeech failed: ${error}`;
            print(`AssistantMode: ${message}`);
            this.mode.logDebug(`Agent - Error: ${message}`);
            this.mode.onErrorOccurred.forEach(cb => cb(message));
            this.mode.setState(AssistantState.Idle);
        } finally {
            this.isProcessingSpeech = false;
        }
    }

    private async playGreeting(): Promise<void> {
        if (!this.llmInterface || !this.robotDriver) {
            this.mode.setState(AssistantState.Listening);
            this.startASR();
            return;
        }

        try {
            this.robotDriver.setGazeTarget(this.camera.getTransform().getWorldPosition());
            const response = await this.llmInterface.sendMessage(this.GREETING_PROMPT);

            this.mode.setState(AssistantState.Speaking);
            this.stopASR();

            await this.robotDriver.playAudio(response.audioTrack);
            this.mode.setState(AssistantState.Listening);
            this.postSpeakListeningEndTime = getTime() + this.POST_SPEAK_LISTENING_SEC;
            this.asrErrorCount = 0;
            this.startASR();

            this.debounceTimer = getTime();
            this.lastActivityTime = getTime();
        } catch (error) {
            const message = `playGreeting failed: ${error}`;
            print(`AssistantMode: ${message}`);
            this.mode.logDebug(`Agent - Error: ${message}`);
            this.mode.onErrorOccurred.forEach(cb => cb(message));
            this.mode.setState(AssistantState.Listening);
        }
    }
}
