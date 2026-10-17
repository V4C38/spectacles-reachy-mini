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
    // stopTranscribing() resolves later. A start must wait for that promise.
    // Status 0 is Success from the session that just ended, not a failure.
    private asrWanted: boolean = false;
    private asrGeneration: number = 0;
    private stopPromise: Promise<void> = Promise.resolve();
    private asrRestarting: boolean = false;

    // --- Timers (public so AssistantMode.updateFrame can read them) ---
    public lastActivityTime: number = 0;
    public postSpeakListeningEndTime: number = 0;
    private debounceTimer: number = 0;
    private isProcessingSpeech: boolean = false;
    public isPaused: boolean = false;

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
    ) {}

    // ----------------------------------------------------------------
    // Session Management
    // ----------------------------------------------------------------
    private openSession(): void {
        this.lastActivityTime = getTime();
        this.debounceTimer = 0;
        this.registerTools();
        print("AssistantMode: Conversation session opened");
        this.mode.onSessionChanged.forEach(cb => cb(true));
    }

    public closeSession(): void {
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
        this.asrWanted = true;
        const generation = ++this.asrGeneration;
        this.stopPromise.then(() => {
            if (!this.asrWanted || generation !== this.asrGeneration) return;
            this.beginAsrSession(generation);
        });
    }

    public stopASR(): void {
        this.asrWanted = false;
        ++this.asrGeneration;
        this.currentTranscription = "";
        this.enqueueStop();
        print("TTS / ASR stopped");
    }

    private enqueueStop(): void {
        const previous = this.stopPromise;
        this.stopPromise = previous.then(() => this.invokeStop(), () => this.invokeStop());
    }

    private invokeStop(): Promise<void> {
        try {
            const pending = this.asrModule.stopTranscribing();
            if (pending && typeof pending.then === "function") {
                return pending.then(() => undefined, () => undefined);
            }
        } catch (_error) {
            // No session was running, or the module rejected the stop.
        }
        return Promise.resolve();
    }

    private beginAsrSession(generation: number): void {
        if (!this.asrWanted || generation !== this.asrGeneration) return;

        const state = this.mode.getState();
        const options = AsrModule.AsrTranscriptionOptions.create();
        options.silenceUntilTerminationMs = state === AssistantState.Sleeping ? this.WAKE_SILENCE_MS : this.CONVO_SILENCE_MS;
        options.mode = AsrModule.AsrMode.HighSpeed;

        options.onTranscriptionUpdateEvent.add((eventArgs: AsrModule.TranscriptionUpdateEvent) => {
            if (generation !== this.asrGeneration || !this.asrWanted) return;
            this.onTranscriptionUpdate(eventArgs);
        });

        options.onTranscriptionErrorEvent.add((errorCode: AsrModule.AsrStatusCode) => {
            if (generation !== this.asrGeneration || !this.asrWanted) return;
            this.onTranscriptionError(errorCode, generation);
        });

        this.asrModule.startTranscribing(options);
        this.currentTranscription = "";
        this.asrRestarting = false;
        print("TTS / ASR started");
    }

    private onTranscriptionUpdate(eventArgs: AsrModule.TranscriptionUpdateEvent): void {
        const text = eventArgs.text;
        const isFinal = eventArgs.isFinal;

        if (this.isPaused) return;

        if (this.mode.getState() === AssistantState.Idle) {
            this.mode.setState(AssistantState.Listening);
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

    private onTranscriptionError(errorCode: AsrModule.AsrStatusCode, generation: number): void {
        if (errorCode === AsrModule.AsrStatusCode.Success) return;
        if (generation !== this.asrGeneration || !this.asrWanted) return;
        if (this.asrRestarting) return;

        const state = this.mode.getState();
        const message = `ASR error: ${errorCode}`;
        print(`AssistantMode: ${message} state: ${AssistantState[state]})`);
        this.mode.logDebug(message);
        this.mode.onErrorOccurred.forEach(cb => cb(message));

        this.asrRestarting = true;
        print("AssistantMode: Restarting ASR after error...");
        this.stopASR();
        this.startASR();
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
            const asrGenerationAtStop = this.asrGeneration;

            await this.robotDriver.playAudio(response.audioTrack);
            if (this.asrGeneration === asrGenerationAtStop) {
                this.startASR();
            }
            this.mode.setState(AssistantState.Listening);
            this.postSpeakListeningEndTime = getTime() + this.POST_SPEAK_LISTENING_SEC;

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
            const asrGenerationAtStop = this.asrGeneration;

            await this.robotDriver.playAudio(response.audioTrack);
            if (this.asrGeneration === asrGenerationAtStop) {
                this.startASR();
            }

            this.debounceTimer = getTime();
            this.lastActivityTime = getTime();
            this.mode.setState(AssistantState.Listening);
            this.postSpeakListeningEndTime = getTime() + this.POST_SPEAK_LISTENING_SEC;
        } catch (error) {
            const message = `playGreeting failed: ${error}`;
            print(`AssistantMode: ${message}`);
            this.mode.logDebug(`Agent - Error: ${message}`);
            this.mode.onErrorOccurred.forEach(cb => cb(message));
            this.mode.setState(AssistantState.Listening);
        }
    }
}
