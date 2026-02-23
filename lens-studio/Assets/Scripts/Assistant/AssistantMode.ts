import { MLObjectDetector } from "../Utils/MLObjectDetector";
import { DepthCache } from "../Utils/DepthCache";
import { LLMService } from "./LLMService";
import { RobotDriver } from "../RobotDriver/RobotDriver";
import { PRESETS } from "../RobotDriver/RobotAnimationConfig";
import { AssistantConversation } from "./AssistantConversation";
import { ToolFactory } from "./Tools/ToolFactory";

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
    public assistantTools: ToolFactory | null = null;

    // --- ASR module ---
    public asrModule: AsrModule = require("LensStudio:AsrModule");

    // --- Event callbacks ---
    public onStateChanged: ((newState: AssistantState) => void)[] = [];
    public onSessionChanged: ((active: boolean) => void)[] = [];
    public onErrorOccurred: ((message: string) => void)[] = [];

    // --- State ---
    public currentState: AssistantState = AssistantState.Idle;

    // --- Look-at override (timed gaze from tool calls) ---
    public lookAtOverrideTarget: vec3 | null = null;
    public lookAtOverrideEndTime: number = 0;

    // --- Idle wander ---
    private idleTarget: vec3 | null = null;
    private nextIdleTargetTime: number = 0;
    private readonly IDLE_LOOK_DISTANCE = 200;
    private readonly IDLE_TIMEOUT_SEC = 45.0;

    // --- Nod ---
    private readonly NOD_LISTENING = { freq: 1.5, amp: 5 };
    private readonly NOD_SPEAKING  = { freq: 2.5, amp: 8 };

    // --- Searching ---
    private searchTarget: vec3 | null = null;
    private searchStartTime: number = 0;
    private readonly SEARCH_SWEEP_SPEED = 0.8;
    private readonly SEARCH_YAW_AMP = 20 * Math.PI / 180;
    private readonly SEARCH_PITCH_AMP = 10 * Math.PI / 180;

    @input
    private textDebugInfo: Text | null = null;

    // --- Conversation handler (created in onAwake) ---
    private conversation!: AssistantConversation;

    public logDebug(message: string): void {
        if (this.textDebugInfo) {
            this.textDebugInfo.text = message;
        }
    }

    onAwake() {
        this.createEvent("OnStartEvent").bind(() => {
            this.conversation = new AssistantConversation(
                this,
                this.robotDriver,
                this.llmInterface,
                this.assistantTools,
                this.camera,
                this.asrModule,
            );
            this.conversation.registerTools();
        });
    }

    // ----------------------------------------------------------------
    // Update Loop
    // ----------------------------------------------------------------
    public updateFrame(): void {
        if (!this.robotDriver || this.robotDriver.getIsPaused()) return;

        const now = getTime();

        if (this.currentState === AssistantState.Idle) {
            if (now - this.conversation.lastActivityTime >= this.IDLE_TIMEOUT_SEC) {
                this.setState(AssistantState.Sleeping);
            }
        }

        if (this.currentState === AssistantState.Listening && this.conversation.postSpeakListeningEndTime > 0) {
            if (now >= this.conversation.postSpeakListeningEndTime) {
                this.conversation.postSpeakListeningEndTime = 0;
                this.setState(AssistantState.Idle);
            }
        }

        // --- Look-at override takes priority ---
        if (this.lookAtOverrideTarget) {
            if (now < this.lookAtOverrideEndTime) {
                this.robotDriver.setGazeTarget(this.lookAtOverrideTarget);
                this.robotDriver.setParams({ gazeWander: 0 });
                this.robotDriver.updateFrame();
                return;
            } else {
                this.lookAtOverrideTarget = null;
                this.applyStateParams();
            }
        }

        // --- Gaze target based on state ---
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
    // Idle wander
    // ----------------------------------------------------------------
    private updateIdleWander(now: number, cameraPos: vec3): void {
        if (!this.robotDriver) return;

        if (now > this.nextIdleTargetTime || !this.idleTarget) {
            if (Math.random() < 0.3) {
                this.idleTarget = cameraPos;
            } else {
                this.idleTarget = this.randomLookTarget();
            }
            this.nextIdleTargetTime = now + this.randomRange(3, 6);
        }

        this.robotDriver.setGazeTarget(this.idleTarget);
    }

    private randomLookTarget(): vec3 {
        const headPos = this.robotDriver!.getHeadWorldPosition();
        const baseRot = this.robotDriver!.getBaseRotation() || quat.quatIdentity();

        const forward = baseRot.multiplyVec3(new vec3(0, 0, 1));
        const right = baseRot.multiplyVec3(new vec3(1, 0, 0));

        const rightAmount = this.randomRange(-150, 150);
        const upAmount = this.randomRange(-30, 60);

        return headPos
            .add(forward.uniformScale(this.IDLE_LOOK_DISTANCE))
            .add(right.uniformScale(rightAmount))
            .add(new vec3(0, upAmount, 0));
    }

    // ----------------------------------------------------------------
    // Search sweep
    // ----------------------------------------------------------------
    private updateSearchSweep(now: number): void {
        if (!this.searchTarget || !this.robotDriver) return;
        const elapsed = now - this.searchStartTime;
        const headPos = this.robotDriver.getHeadWorldPosition();
        const toTarget = this.searchTarget.sub(headPos);
        const dist = toTarget.length;

        const forward = toTarget.normalize();
        const right = forward.cross(new vec3(0, 1, 0)).normalize();
        const up = new vec3(0, 1, 0);

        const yawOffset = Math.sin(elapsed * this.SEARCH_SWEEP_SPEED) * dist * Math.tan(this.SEARCH_YAW_AMP);
        const pitchOffset = Math.sin(elapsed * this.SEARCH_SWEEP_SPEED * 1.7) * dist * Math.tan(this.SEARCH_PITCH_AMP);

        this.robotDriver.setGazeTarget(
            this.searchTarget.add(right.uniformScale(yawOffset)).add(up.uniformScale(pitchOffset))
        );
    }

    // ----------------------------------------------------------------
    // State machine
    // ----------------------------------------------------------------
    public activate(): void {
        if (!this.robotDriver) return;
        this.robotDriver.reset();

        this.currentState = AssistantState.Idle;
        this.setState(AssistantState.Sleeping);
        this.robotDriver.snapToCurrentParams();
        this.conversation.startASR();
    }

    public deactivate(): void {
        if (this.conversation) {
            this.conversation.stopASR();
        }
        this.mlDetector.clearAllDetections();
        if (this.robotDriver) {
            this.robotDriver.pause();
        }
    }

    public pause(): void {
        if (!this.conversation) return;
        this.conversation.isPaused = true;
        if (this.robotDriver) {
            this.robotDriver.pause();
        }
    }

    public resume(): void {
        if (!this.conversation) return;
        this.conversation.isPaused = false;
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
            case AssistantState.Sleeping:  this.enterSleeping();  break;
            case AssistantState.Idle:      this.enterIdle();      break;
            case AssistantState.Listening: this.enterListening(); break;
            case AssistantState.Speaking:  this.enterSpeaking();  break;
            case AssistantState.Searching: this.enterSearching(); break;
        }
        print(`AssistantMode: ${AssistantState[oldState]} -> ${AssistantState[newState]}`);
        this.logDebug(`Agent - State: ${AssistantState[newState]}`);
        this.onStateChanged.forEach(cb => cb(newState));
    }

    public getState(): AssistantState {
        return this.currentState;
    }

    private applyStateParams(): void {
        if (!this.robotDriver) return;
        switch (this.currentState) {
            case AssistantState.Sleeping:
                this.robotDriver.setParams(PRESETS.sleeping);
                this.robotDriver.setNeutralPitch(0.6);
                break;
            case AssistantState.Idle:
                this.robotDriver.setParams(PRESETS.idle);
                this.robotDriver.setNeutralPitch(0);
                break;
            case AssistantState.Listening: this.robotDriver.setParams(PRESETS.listening); break;
            case AssistantState.Speaking:  this.robotDriver.setParams(PRESETS.speaking);  break;
            case AssistantState.Searching: this.robotDriver.setParams(PRESETS.searching); break;
        }
    }

    private enterSleeping(): void {
        this.conversation.closeSession();
        this.conversation.postSpeakListeningEndTime = 0;
        if (this.robotDriver) {
            this.robotDriver.setParams(PRESETS.sleeping);
            this.robotDriver.setNeutralPitch(0.6);
            this.robotDriver.setGazeTarget(null);
        }
    }

    private enterIdle(): void {
        this.conversation.lastActivityTime = getTime();
        this.conversation.postSpeakListeningEndTime = 0;
        this.idleTarget = null;
        this.nextIdleTargetTime = 0;
        if (this.robotDriver) {
            this.robotDriver.setParams(PRESETS.idle);
            this.robotDriver.setNeutralPitch(0);
        }
    }

    private enterListening(): void {
        this.conversation.lastActivityTime = getTime();
        if (this.robotDriver) {
            this.robotDriver.setParams(PRESETS.listening);
        }
    }

    private enterSpeaking(): void {
        this.conversation.lastActivityTime = getTime();
        this.conversation.postSpeakListeningEndTime = 0;
        if (this.robotDriver) {
            this.robotDriver.setParams(PRESETS.speaking);
        }
    }

    private enterSearching(): void {
        this.searchStartTime = getTime();
        this.conversation.postSpeakListeningEndTime = 0;
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

    // ----------------------------------------------------------------
    // Helpers
    // ----------------------------------------------------------------
    public setSpeaking(speaking: boolean): void {
        if (this.currentState === AssistantState.Sleeping || this.currentState === AssistantState.Searching) return;
        if (speaking && this.currentState === AssistantState.Idle) {
            this.setState(AssistantState.Speaking);
        } else if (!speaking && this.currentState === AssistantState.Speaking) {
            this.setState(AssistantState.Idle);
        }
    }

    public getViewerCameraWorldPosition(): vec3 | null {
        if (!this.camera) return null;
        return this.camera.getTransform().getWorldPosition();
    }

    public getViewerCameraWorldRotation(): quat | null {
        if (!this.camera) return null;
        return this.camera.getTransform().getWorldRotation();
    }

    private randomRange(min: number, max: number): number {
        return min + Math.random() * (max - min);
    }
}
