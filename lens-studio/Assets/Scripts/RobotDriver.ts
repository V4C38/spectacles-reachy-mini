import { HardwareAdapter } from "./HardwareAdapter";
import { SimulationAdapter } from "./SimulationAdapter";
import { AnimationParams, AnimationGazeContext, NAMED_ANIMATIONS, PRESETS } from "./RobotAnimationConfig";

// ================================================================
// Shared types (used by adapters)
// ================================================================

/** 3D pose: position (x, y, z) in meters, orientation (roll, pitch, yaw) in radians. */
export interface XYZRPYPose {
    x: number;
    y: number;
    z: number;
    roll: number;
    pitch: number;
    yaw: number;
}

/** Interface that both HardwareAdapter and SimulationAdapter implement. */
export interface RobotInterface {
    goto(headPose: XYZRPYPose, bodyYaw?: number, duration?: number, interpolation?: string): Promise<string>;
    setTarget(headPose: XYZRPYPose, bodyYaw?: number, antennas?: [number, number]): Promise<void>;
    playAudio(audioTrack: AudioTrackAsset): Promise<void>;
}

// ----------------------------------------------------------------
// RobotDriver
/**
 * Parameter-driven animation loop for the robot.
 *
 * Callers set a gaze target (world position) and animation parameters
 * (via presets or partial overrides).  The loop smoothly tracks the
 * target while adding ambient motion (roll, bob, antennas, gaze
 * variation) scaled by the current parameters.
 *
 * RobotDriver does NOT know about modes or states -- that logic
 * lives in PuppeteerMode / AssistantMode.
 */
// ----------------------------------------------------------------

@component
export class RobotDriver extends BaseScriptComponent {

    // --- Scene inputs ---
    @input
    private hardwareAdapter: HardwareAdapter | null = null;
    @input
    private simulationAdapter: SimulationAdapter | null = null;
    @input
    private headRoot: SceneObject | null = null;

    // --- User-tunable base parameters (scaled by AnimationParams) ---
    @input
    public headMoveSpeed: number = 0.05;
    @input
    public maxHeadDelta: number = 2.0;
    @input
    public rollAmplitude: number = 8.0;
    @input
    public yBobAmplitude: number = 0.012;
    /** Max vertical offset when headHeight = 1. Meters. */
    @input
    public headYBase: number = 0.10;
    @input
    public antennaAmplitude: number = 15.0;

    // --- Mechanical limits: match Reachy Mini daemon / IK safety; ±30° roll/pitch for Stewart workspace ---
    private readonly MIN_PITCH = -30 * Math.PI / 180;
    private readonly MAX_PITCH = 30 * Math.PI / 180;
    private readonly MAX_HEAD_YAW = 65 * Math.PI / 180;   // max head–body yaw delta
    private readonly MAX_BODY_YAW = 160 * Math.PI / 180;
    private readonly MAX_ROLL = 30 * Math.PI / 180;
    private readonly MAX_HEAD_YAW_ABSOLUTE = 180 * Math.PI / 180;  // total head yaw ±180°
    private readonly ROLL_YAW_COUPLING = 0.12;

    // --- Tracked axes (internal state driven by the loop) ---
    private headYaw: number = 0;
    private headPitch: number = 0;
    private headRoll: number = 0;
    private headY: number = 0;
    private bodyYaw: number = 0;
    private prevHeadYaw: number = 0;
    private antennaLeft: number = 0;
    private antennaRight: number = 0;

    // --- Head Y base position (smoothed toward param target) ---
    private headYBase_current: number = 0;

    // --- Neutral pitch when no gaze target (e.g. 0.6 for sleeping) ---
    private neutralPitch: number = 0;

    // --- Current animation parameters ---
    private params: AnimationParams = { ...PRESETS.idle };

    // --- Gaze target (world position, null = look straight ahead) ---
    private gazeTarget: vec3 | null = null;

    // --- Gaze variation (smooth random offset, replaces old glance system) ---
    private gazeVarTargetYaw: number = 0;
    private gazeVarTargetPitch: number = 0;
    private gazeVarCurrentYaw: number = 0;
    private gazeVarCurrentPitch: number = 0;
    private gazeVarNextChangeTime: number = 0;

    // --- Pause ---
    private isPaused: boolean = false;

    // --- Local animation overlay (params, gaze, end time) ---
    private localAnimation: {
        params: AnimationParams;
        endTime: number;
        startTime: number;
        durationSec: number;
        getGazeTarget?: (t: number, ctx: AnimationGazeContext) => vec3;
    } | null = null;

    // --- Simulation mode ---
    private simulationMode: boolean = false;

    onAwake() {
    }

    // ================================================================
    // Public API: parameters
    // ================================================================

    /** Merge partial params into the current set. Pass a full PRESET or individual overrides. */
    public setParams(incoming: Partial<AnimationParams>): void {
        this.params = { ...this.params, ...incoming };
    }

    /** Get a copy of the current params (useful for save/restore). */
    public getParams(): AnimationParams {
        return { ...this.params };
    }

    /** Set the pitch used when gaze target is null (radians). Positive = look down. */
    public setNeutralPitch(pitch: number): void {
        this.neutralPitch = pitch;
    }

    // ================================================================
    // Public API: gaze target
    // ================================================================

    /** Set the world-space position to look at. Pass null to look straight ahead. */
    public setGazeTarget(pos: vec3 | null): void {
        this.gazeTarget = pos;
    }

    /** Get the current gaze target (may be null). */
    public getGazeTarget(): vec3 | null {
        return this.gazeTarget;
    }

    /** Cancel any active named-animation overlay so base params and gaze apply immediately (e.g. when entering sleep). */
    public clearLocalAnimation(): void {
        this.localAnimation = null;
    }

    // ================================================================
    // State helpers
    // ================================================================

    public reset(): void {
        this.headYaw = 0;
        this.headPitch = 0;
        this.headRoll = 0;
        this.headY = 0;
        this.headYBase_current = 0;
        this.bodyYaw = 0;
        this.prevHeadYaw = 0;
        this.antennaLeft = 0;
        this.antennaRight = 0;
        this.gazeTarget = null;
        this.neutralPitch = 0;
        this.params = { ...PRESETS.idle };
        this.gazeVarTargetYaw = 0;
        this.gazeVarTargetPitch = 0;
        this.gazeVarCurrentYaw = 0;
        this.gazeVarCurrentPitch = 0;
        this.gazeVarNextChangeTime = 0;
    }

    /**
     * Snap internal tracked angles to the steady-state values implied by the
     * current params.  Use after setting params (e.g. sleeping preset) when the
     * robot should appear in the target pose immediately, without smoothing.
     */
    public snapToCurrentParams(): void {
        this.headPitch = this.neutralPitch;
        this.headYaw = 0;
        this.headRoll = 0;
        this.headY = this.headYBase * this.params.headHeight;
        this.headYBase_current = this.headY;
        this.bodyYaw = 0;
        this.prevHeadYaw = 0;
        this.antennaLeft = 0;
        this.antennaRight = 0;
    }

    public pause(): void {
        this.isPaused = true;
    }

    public resume(): void {
        this.isPaused = false;
    }

    public getIsPaused(): boolean {
        return this.isPaused;
    }

    public getHeadAngles(): { yaw: number; pitch: number; roll: number } {
        return { yaw: this.headYaw, pitch: this.headPitch, roll: this.headRoll };
    }

    public getBodyYaw(): number {
        return this.bodyYaw;
    }

    public getHeadWorldPosition(): vec3 {
        const pos = this.headRoot.getTransform().getWorldPosition();
        if (!this.simulationMode && !this.simulationAdapter) {
            return pos.add(new vec3(0, 20, 0));
        }
        return pos;
    }

    public getBaseRotation(): quat | null {
        if (!this.headRoot) return null;
        const parent = this.headRoot.getParent();
        if (!parent) {
            return this.getSceneObject().getTransform().getWorldRotation();
        }
        return parent.getTransform().getWorldRotation();
    }

    // ================================================================
    // Animations & Audio (Lens-side local animations)
    // ================================================================

    /**
     * Play a named animation.
     * @param name       Animation name (e.g. "greeting", "dance").
     * @param suppressAudio  When true, only the motion overlay plays — no sound
     *                       effect.  Use this when TTS speech is playing at the
     *                       same time and the animation SFX would clash.
     */
    public async playAnimation(name: string, suppressAudio: boolean = false): Promise<void> {
        await this.playLocalAnimation(name, suppressAudio);
    }

    public async getAvailableAnimations(): Promise<string[]> {
        return Object.keys(NAMED_ANIMATIONS);
    }

    /**
     * Play a named animation: overlay params for duration and optionally play audio.
     * Uses NAMED_ANIMATIONS config; audio comes from SimulationAdapter.
     * @param suppressAudio  Skip the animation's sound effect (motion-only).
     */
    public async playLocalAnimation(name: string, suppressAudio: boolean = false): Promise<void> {
        const entry = NAMED_ANIMATIONS[name.trim().toLowerCase()];
        if (!entry) {
            throw new Error(`Unknown animation: "${name}". Available: ${Object.keys(NAMED_ANIMATIONS).join(", ")}`);
        }
        const iface = this.getActiveInterface();
        if (!iface) {
            throw new Error("Animations are not available (no hardware or simulation adapter)");
        }

        const now = getTime();
        const endTime = now + entry.durationSec;
        this.localAnimation = {
            params: { ...entry.params },
            endTime,
            startTime: now,
            durationSec: entry.durationSec,
            getGazeTarget: entry.getGazeTarget,
        };

        // Get audio track from SimulationAdapter and play in parallel with param overlay
        let audioPromise: Promise<void> = Promise.resolve();
        if (!suppressAudio && this.simulationAdapter) {
            const track = this.simulationAdapter.getAudioTrackForAnimation(entry.audioKey);
            if (track) {
                audioPromise = iface.playAudio(track);
            }
        }

        // Wait for animation duration (param overlay expires in updateFrame)
        const delayEvent = this.createEvent("DelayedCallbackEvent") as DelayedCallbackEvent;
        const waitPromise = new Promise<void>((resolve) => {
            delayEvent.bind(() => resolve());
            delayEvent.reset(entry.durationSec);
        });

        await Promise.all([audioPromise, waitPromise]);
        if (this.localAnimation && getTime() >= this.localAnimation.endTime) {
            this.localAnimation = null;
        }
    }

    public async goto(pose: XYZRPYPose, bodyYaw: number, duration: number, interpolation: string): Promise<string> {
        const iface = this.getActiveInterface();
        if (!iface) throw new Error("RobotDriver: no active movement interface");
        if (!this.simulationMode && this.simulationAdapter) {
            this.simulationAdapter.goto(pose, bodyYaw, duration, interpolation).catch(() => {});
        }
        return iface.goto(pose, bodyYaw, duration, interpolation);
    }

    public async playAudio(track: AudioTrackAsset): Promise<void> {
        const iface = this.getActiveInterface();
        if (!iface) throw new Error("RobotDriver: no active movement interface");
        return iface.playAudio(track);
    }

    // ================================================================
    // Update Loop
    // ================================================================

    public updateFrame(): void {
        if (this.isPaused) return;
        const iface = this.getActiveInterface();
        if (!iface) return;

        const now = getTime();
        const DEG = Math.PI / 180;

        // --- Clear expired local animation overlay ---
        if (this.localAnimation && now >= this.localAnimation.endTime) {
            this.localAnimation = null;
        }

        // --- Effective params and gaze: use overlay when active ---
        const effectiveParams = this.localAnimation ? this.localAnimation.params : this.params;
        let effectiveGazeTarget: vec3 | null = this.gazeTarget;
        if (this.localAnimation && this.localAnimation.getGazeTarget) {
            const t = Math.min(1, Math.max(0, (now - this.localAnimation.startTime) / this.localAnimation.durationSec));
            const ctx: AnimationGazeContext = {
                headPos: this.getHeadWorldPosition(),
                baseRotation: this.getBaseRotation(),
            };
            effectiveGazeTarget = this.localAnimation.getGazeTarget(t, ctx);
        }

        // --- Derive per-axis values from simplified params ---
        const p = effectiveParams;
        let yawSmoothing = this.headMoveSpeed * p.gazeResponsiveness;
        let pitchSmoothing = this.headMoveSpeed * p.gazeResponsiveness * 0.8;
        let maxYawDelta = this.maxHeadDelta * p.gazeResponsiveness * DEG;
        let maxPitchDelta = this.maxHeadDelta * 0.5 * p.gazeResponsiveness * DEG;
        let bodySmoothing = yawSmoothing * 0.7 * (0.3 + p.liveliness * 0.4);
        const rollSmoothing = yawSmoothing * 0.8;
        const antennaSmoothing = yawSmoothing * 1.5;
        let ySmoothing = yawSmoothing * 0.8;
        const effectiveRollAmp = this.rollAmplitude * p.liveliness * DEG;
        const effectiveYAmp = this.yBobAmplitude * p.liveliness;
        const effectiveAntAmp = this.antennaAmplitude * p.antennaActivity * DEG;
        const antSpeed = 0.5 + p.antennaActivity * 0.5;

        // --- Boost tracking during named animations for visible motion ---
        const isAnimGaze = !!(this.localAnimation && this.localAnimation.getGazeTarget);
        if (isAnimGaze) {
            const ANIM_SPEED = 0.4;
            const ANIM_MAX_DELTA = 15 * DEG;
            yawSmoothing = Math.max(yawSmoothing, ANIM_SPEED);
            pitchSmoothing = Math.max(pitchSmoothing, ANIM_SPEED);
            maxYawDelta = Math.max(maxYawDelta, ANIM_MAX_DELTA);
            maxPitchDelta = Math.max(maxPitchDelta, ANIM_MAX_DELTA * 0.7);
            bodySmoothing = Math.max(bodySmoothing, ANIM_SPEED * 0.5);
            ySmoothing = Math.max(ySmoothing, ANIM_SPEED);
        }

        // --- 1. Compute desired angles from gaze target ---
        let desiredYaw: number;
        let desiredPitch: number;

        if (effectiveGazeTarget) {
            const angles = this.anglesToTarget(effectiveGazeTarget);
            if (isFinite(angles.yaw) && isFinite(angles.pitch)) {
                desiredYaw = angles.yaw;
                desiredPitch = angles.pitch;
            } else {
                // Keep current angles on invalid input
                desiredYaw = this.headYaw;
                desiredPitch = this.headPitch;
            }
        } else {
            // No target: use neutral pose (straight ahead or sleep-tucked)
            desiredYaw = 0;
            desiredPitch = this.neutralPitch;
        }

        // --- 2. Gaze variation (smooth random offset) ---
        if (p.gazeWander > 0) {
            if (now > this.gazeVarNextChangeTime) {
                const amp = p.gazeWander;
                this.gazeVarTargetYaw = this.randomRange(-amp, amp);
                this.gazeVarTargetPitch = this.randomRange(-amp * 0.5, amp * 0.3);
                this.gazeVarNextChangeTime = now + this.randomRange(1.5, 3.0);
            }
        } else {
            this.gazeVarTargetYaw = 0;
            this.gazeVarTargetPitch = 0;
        }
        const varSmoothing = 0.03;
        this.gazeVarCurrentYaw += (this.gazeVarTargetYaw - this.gazeVarCurrentYaw) * varSmoothing;
        this.gazeVarCurrentPitch += (this.gazeVarTargetPitch - this.gazeVarCurrentPitch) * varSmoothing;
        desiredYaw += this.gazeVarCurrentYaw;
        desiredPitch += this.gazeVarCurrentPitch;

        // --- 3. Smooth interpolation ---
        this.headYaw += this.dampen((desiredYaw - this.headYaw) * yawSmoothing, maxYawDelta);
        this.headPitch += this.dampen((desiredPitch - this.headPitch) * pitchSmoothing, maxPitchDelta);
        this.headPitch = this.clamp(this.headPitch, this.MIN_PITCH, this.MAX_PITCH);

        // --- 4. Body follows head (scaled by liveliness) ---
        const relYaw = this.headYaw - this.bodyYaw;
        const followStrength = Math.abs(relYaw) > this.MAX_HEAD_YAW * 0.5 ? bodySmoothing * 2 : bodySmoothing;
        if (Math.abs(relYaw) > this.MAX_HEAD_YAW) {
            const excess = Math.abs(relYaw) - this.MAX_HEAD_YAW;
            this.bodyYaw += this.dampen(Math.sign(relYaw) * excess * bodySmoothing * 8, maxYawDelta);
        } else {
            this.bodyYaw += relYaw * followStrength;
        }
        this.bodyYaw = this.clamp(this.bodyYaw, -this.MAX_BODY_YAW, this.MAX_BODY_YAW);
        const maxHeadYawRange = Math.min(this.MAX_BODY_YAW + this.MAX_HEAD_YAW, this.MAX_HEAD_YAW_ABSOLUTE);
        this.headYaw = this.clamp(this.headYaw, -maxHeadYawRange, maxHeadYawRange);

        // --- 5. Roll: yaw-velocity coupling + ambient sway ---
        const yawVel = this.headYaw - this.prevHeadYaw;
        this.prevHeadYaw = this.headYaw;
        const ambientRoll = Math.sin(now * 0.23) * Math.sin(now * 0.71) * effectiveRollAmp;
        const desiredRoll = -yawVel * this.ROLL_YAW_COUPLING / Math.max(yawSmoothing, 0.001)
            + ambientRoll;
        this.headRoll += (this.clamp(desiredRoll, -this.MAX_ROLL, this.MAX_ROLL) - this.headRoll) * rollSmoothing;

        // --- 6. Head Y: base position + bob ---
        const targetBaseY = this.headYBase * p.headHeight;
        this.headYBase_current += (targetBaseY - this.headYBase_current) * ySmoothing;
        const desiredY = this.headYBase_current + this.dualSine(now, 0.41, 0.29) * effectiveYAmp;
        this.headY += (desiredY - this.headY) * ySmoothing;

        // --- 7. Antennas (speed-scaled dual sine) ---
        const desiredL = this.dualSine(now * antSpeed, 1.3, 3.11) * effectiveAntAmp;
        const desiredR = this.dualSine(now * antSpeed, 1.7, 2.73) * effectiveAntAmp;
        this.antennaLeft += (desiredL - this.antennaLeft) * antennaSmoothing;
        this.antennaRight += (desiredR - this.antennaRight) * antennaSmoothing;

        // --- 8. Send to active interface ---
        const headPose: XYZRPYPose = { x: 0, y: 0, z: this.headY, roll: this.headRoll, pitch: this.headPitch, yaw: this.headYaw };
        const antennaPose: [number, number] = [this.antennaLeft, this.antennaRight];

        iface.setTarget(headPose, this.bodyYaw, antennaPose).catch(() => {});

        // Mirror to simulation when hardware is active
        if (!this.simulationMode && this.simulationAdapter) {
            this.simulationAdapter.setTarget(headPose, this.bodyYaw, antennaPose).catch(() => {});
        }
    }

    // ================================================================
    // Hardware / Connection
    // ================================================================

    public setSimulationMode(enabled: boolean): void {
        this.simulationMode = enabled;
    }

    public getIsSimulationMode(): boolean {
        return this.simulationMode;
    }

    private getActiveInterface(): RobotInterface | null {
        return this.simulationMode ? this.simulationAdapter : this.hardwareAdapter;
    }

    public setBaseUrl(url: string): void {
        if (this.hardwareAdapter) {
            this.hardwareAdapter.baseUrl = url;
        }
    }

    public getBaseUrl(): string {
        return this.hardwareAdapter ? this.hardwareAdapter.baseUrl : "";
    }

    public async checkConnection(): Promise<boolean> {
        if (!this.hardwareAdapter) return false;
        return this.hardwareAdapter.checkConnection();
    }

    public async connect(): Promise<void> {
        if (this.hardwareAdapter) await this.hardwareAdapter.connect();
    }

    public disconnect(): void {
        if (this.hardwareAdapter) this.hardwareAdapter.disconnect();
    }

    // ================================================================
    // Visual helpers (delegated to simulation adapter)
    // ================================================================

    public applyHologramMaterial(): void {
        if (this.simulationAdapter) {
            this.simulationAdapter.applyHologramMaterial();
        }
    }

    public applyDefaultMaterials(): void {
        if (this.simulationAdapter) {
            this.simulationAdapter.applyDefaultMaterials();
        }
    }

    // ================================================================
    // Geometry helpers
    // ================================================================

    /**
     * Compute yaw/pitch angles from head to a world position.
     * Expresses the direction in the base (parent of head/body) frame so that
     * look-at remains correct after the root is repositioned (move/rotate).
     */
    public anglesToTarget(pos: vec3): { yaw: number; pitch: number } {
        const dir = pos.sub(this.getHeadWorldPosition());
        const baseRot = this.getBaseRotation();
        const dirInBase = baseRot
            ? baseRot.invert().multiplyVec3(dir)
            : dir;
        const hDist = Math.sqrt(dirInBase.x * dirInBase.x + dirInBase.z * dirInBase.z);
        if (hDist < 0.001) {
            return { yaw: this.headYaw, pitch: dirInBase.y > 0 ? this.MAX_PITCH : this.MIN_PITCH };
        }
        return {
            yaw: Math.atan2(dirInBase.x, dirInBase.z),
            pitch: -Math.atan2(dirInBase.y, hDist),
        };
    }

    // ================================================================
    // Internal math
    // ================================================================

    private dualSine(t: number, freqA: number, freqB: number): number {
        return Math.sin(t * freqA) * 0.6 + Math.sin(t * freqB) * 0.4;
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
