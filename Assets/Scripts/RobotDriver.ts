import { HardwareAdapter } from "./HardwareAdapter";
import { SimulationAdapter } from "./SimulationAdapter";

// ================================================================
// Animation Profile
// ================================================================
// Represents a 3D pose using position (x, y, z) in meters and orientation (roll, pitch, yaw) angles in radians
export interface XYZRPYPose {
    x: number;
    y: number;
    z: number;
    roll: number;
    pitch: number;
    yaw: number;
}

// Interface that both HardwareAdapter and SimulationAdapter implement
export interface RobotInterface {
    goto(headPose: XYZRPYPose, bodyYaw?: number, duration?: number, interpolation?: string): Promise<string>;
    setTarget(headPose: XYZRPYPose, bodyYaw?: number, antennas?: [number, number]): Promise<void>;
    playAudio(audioTrack: AudioTrackAsset): Promise<void>;
}

// Interface that represents the different animation profiles
export interface AnimationProfile {
    headMoveSpeedMul: number;
    maxHeadDeltaMul: number;
    rollAmplitudeMul: number;
    yBobAmplitudeMul: number;
    headYPosMul: number;
    antennaAmplitudeMul: number;
    pitchSmoothingMul: number;
}

export const PROFILES: { [key: string]: AnimationProfile } = {
    //                                speed   delta   roll   yBob  yPos   antenna  pitch
    sleeping:  { headMoveSpeedMul: 0.3,  maxHeadDeltaMul: 0.3,  rollAmplitudeMul: 0.2, yBobAmplitudeMul: 0.2, headYPosMul: -0.3, antennaAmplitudeMul: 0.15, pitchSmoothingMul: 0.3 },
    idle:      { headMoveSpeedMul: 0.6,  maxHeadDeltaMul: 0.75, rollAmplitudeMul: 1.0, yBobAmplitudeMul: 1.0, headYPosMul:  0.5, antennaAmplitudeMul: 1.0,  pitchSmoothingMul: 0.5 },
    listening: { headMoveSpeedMul: 1.0,  maxHeadDeltaMul: 1.0,  rollAmplitudeMul: 0.8, yBobAmplitudeMul: 0.6, headYPosMul:  0.8, antennaAmplitudeMul: 1.3,  pitchSmoothingMul: 0.8 },
    speaking:  { headMoveSpeedMul: 1.2,  maxHeadDeltaMul: 1.0,  rollAmplitudeMul: 1.0, yBobAmplitudeMul: 0.8, headYPosMul:  0.8, antennaAmplitudeMul: 1.4,  pitchSmoothingMul: 0.8 },
    searching: { headMoveSpeedMul: 1.5,  maxHeadDeltaMul: 1.5,  rollAmplitudeMul: 0.6, yBobAmplitudeMul: 0.5, headYPosMul:  1.0, antennaAmplitudeMul: 2.0,  pitchSmoothingMul: 1.0 },
    puppeteer: { headMoveSpeedMul: 1.2,  maxHeadDeltaMul: 1.0,  rollAmplitudeMul: 1.0, yBobAmplitudeMul: 1.5, headYPosMul:  0.6, antennaAmplitudeMul: 0.8,  pitchSmoothingMul: 0.8 },
};

// ================================================================
// Glance Config
// ================================================================

export interface GlanceConfig {
    lookMinSec: number;
    lookMaxSec: number;
    glanceMinSec: number;
    glanceMaxSec: number;
    yawOffsetDeg: number;
    pitchOffsetDeg: number;
}

// ----------------------------------------------------------------
// RobotDriver
/**
 * Single entry point for controlling the robot -- animation, audio, and connection.
 * Owns both HardwareAdapter and SimulationAdapter; consumers never touch them directly.
 *
 * Usage:
 *   1. Call setProfile() to configure motion feel for the current state.
 *   2. Each frame, call lookAt() / lookAtCamera() / setSleepPose() then tick().
 *   3. Use setNod() / setGlanceBehavior() for overlays on top of the base gaze.
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

    // --- User-tunable base parameters ---
    @input
    public headMoveSpeed: number = 0.05;
    @input
    public maxHeadDelta: number = 2.0;
    @input
    public rollAmplitude: number = 8.0;
    @input
    public yBobAmplitude: number = 0.012;
    /** Max vertical offset when fully attentive (headYPosMul=1). Meters. */
    @input
    public headYBase: number = 0.10;
    @input
    public antennaAmplitude: number = 15.0;

    // --- Mechanical limits (fixed) ---
    private readonly MIN_PITCH = -30 * Math.PI / 180;
    private readonly MAX_PITCH = 20 * Math.PI / 180;
    private readonly MAX_HEAD_YAW = 35 * Math.PI / 180;
    private readonly MAX_BODY_YAW = 160 * Math.PI / 180;
    private readonly MAX_ROLL = 15 * Math.PI / 180;
    private readonly ROLL_YAW_COUPLING = 0.12;

    // --- Tracked axes ---
    private headYaw: number = 0;
    private headPitch: number = 0;
    private headRoll: number = 0;
    private headY: number = 0;
    private bodyYaw: number = 0;
    private prevHeadYaw: number = 0;
    private antennaLeft: number = 0;
    private antennaRight: number = 0;

    // --- Active profile ---
    private profile: AnimationProfile = PROFILES.idle;

    // --- Gaze target ---
    private targetYaw: number = 0;
    private targetPitch: number = 0;

    // --- Head Y base position (smoothed toward profile target) ---
    private headYBase_current: number = 0;

    // --- Sleep mode ---
    private isSleeping: boolean = false;

    // --- Nod overlay ---
    private nodSpeed: number = 0;
    private nodAmplitude: number = 0;
    private nodStartTime: number = 0;

    // --- Glance overlay ---
    private glanceConfig: GlanceConfig | null = null;
    private isGlancingAway: boolean = false;
    private nextGlanceChangeTime: number = 0;
    private glanceOffsetYaw: number = 0;
    private glanceOffsetPitch: number = 0;
    private glanceOffsetRoll: number = 0;

    // --- Pause ---
    private isPaused: boolean = false;

    // --- Simulation mode ---
    private simulationMode: boolean = false;

    onAwake() {
    }


    // ----------------------------------------------------------------
    // State
    // ----------------------------------------------------------------
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
        this.targetYaw = 0;
        this.targetPitch = 0;
        this.isSleeping = false;
        this.clearNod();
        this.setGlanceBehavior(null);
    }

    public pause(): void {
        this.isPaused = true;
    }

    public resume(): void {
        this.isPaused = false;
    }

    public getHeadAngles(): { yaw: number; pitch: number; roll: number } {
        return { yaw: this.headYaw, pitch: this.headPitch, roll: this.headRoll };
    }

    public getBodyYaw(): number {
        return this.bodyYaw;
    }

    public getHeadWorldPosition(): vec3 {
        return this.headRoot.getTransform().getWorldPosition();
    }

    public getBaseRotation(): quat | null {
        if (!this.headRoot) return null;
        // The base is typically the parent of the headRoot
        const parent = this.headRoot.getParent();
        if (!parent) {
            // Fallback to the sceneObject this component is on
            return this.getSceneObject().getTransform().getWorldRotation();
        }
        return parent.getTransform().getWorldRotation();
    }

    public getIsPaused(): boolean {
        return this.isPaused;
    }



    // ----------------------------------------------------------------
    // Update Loop
    // ----------------------------------------------------------------
    public updateFrame(): void {
        if (this.isPaused) return;
        const iface = this.getActiveInterface();
        if (!iface) return;

        const now = getTime();
        const DEG = Math.PI / 180;

        // --- Effective profile values ---
        const yawSmoothing = this.headMoveSpeed * this.profile.headMoveSpeedMul;
        const pitchSmoothing = this.headMoveSpeed * this.profile.pitchSmoothingMul;
        const maxYawDelta = this.maxHeadDelta * this.profile.maxHeadDeltaMul * DEG;
        const maxPitchDelta = this.maxHeadDelta * 0.5 * this.profile.maxHeadDeltaMul * DEG;
        const bodySmoothing = yawSmoothing * 0.7;
        const rollSmoothing = yawSmoothing * 0.8;
        const antennaSmoothing = yawSmoothing * 1.5;
        const ySmoothing = yawSmoothing * 0.8;
        const effectiveRollAmp = this.rollAmplitude * this.profile.rollAmplitudeMul * DEG;
        const effectiveYAmp = this.yBobAmplitude * this.profile.yBobAmplitudeMul;
        const effectiveAntAmp = this.antennaAmplitude * this.profile.antennaAmplitudeMul * DEG;

        // --- 1. Compute desired angles ---
        let desiredYaw: number;
        let desiredPitch: number;

        if (this.isSleeping) {
            desiredYaw = 0;
            desiredPitch = this.MAX_PITCH * 0.9;
        } else {
            desiredYaw = this.targetYaw;
            desiredPitch = this.targetPitch;
        }

        // --- 2. Glance overlay ---
        if (this.glanceConfig) {
            this.updateGlance(now);
            desiredYaw += this.glanceOffsetYaw;
            desiredPitch += this.glanceOffsetPitch;
        }

        // --- 3. Nod overlay ---
        if (this.nodAmplitude > 0 && this.nodSpeed > 0) {
            desiredPitch += Math.sin((now - this.nodStartTime) * this.nodSpeed) * this.nodAmplitude;
        }

        // --- 4. Smooth interpolation ---
        this.headYaw += this.dampen((desiredYaw - this.headYaw) * yawSmoothing, maxYawDelta);
        this.headPitch += this.dampen((desiredPitch - this.headPitch) * pitchSmoothing, maxPitchDelta);
        this.headPitch = this.clamp(this.headPitch, this.MIN_PITCH, this.MAX_PITCH);

        // --- 5. Body follows head ---
        const relYaw = this.headYaw - this.bodyYaw;
        const followStrength = Math.abs(relYaw) > this.MAX_HEAD_YAW * 0.5 ? bodySmoothing * 2 : bodySmoothing;
        if (Math.abs(relYaw) > this.MAX_HEAD_YAW) {
            const excess = Math.abs(relYaw) - this.MAX_HEAD_YAW;
            this.bodyYaw += this.dampen(Math.sign(relYaw) * excess * bodySmoothing * 8, maxYawDelta);
        } else {
            this.bodyYaw += relYaw * followStrength;
        }
        this.bodyYaw = this.clamp(this.bodyYaw, -this.MAX_BODY_YAW, this.MAX_BODY_YAW);
        this.headYaw = this.clamp(this.headYaw, -(this.MAX_BODY_YAW + this.MAX_HEAD_YAW), this.MAX_BODY_YAW + this.MAX_HEAD_YAW);

        // --- 6. Roll: yaw-velocity coupling + ambient sway ---
        const yawVel = this.headYaw - this.prevHeadYaw;
        this.prevHeadYaw = this.headYaw;
        const ambientRoll = Math.sin(now * 0.23) * Math.sin(now * 0.71) * effectiveRollAmp;
        const desiredRoll = -yawVel * this.ROLL_YAW_COUPLING / Math.max(yawSmoothing, 0.001)
            + ambientRoll + this.glanceOffsetRoll;
        this.headRoll += (this.clamp(desiredRoll, -this.MAX_ROLL, this.MAX_ROLL) - this.headRoll) * rollSmoothing;

        // --- 7. Head Y: base position + bob ---
        const targetBaseY = this.headYBase * this.profile.headYPosMul;
        this.headYBase_current += (targetBaseY - this.headYBase_current) * ySmoothing;
        const desiredY = this.headYBase_current + this.dualSine(now, 0.41, 0.29) * effectiveYAmp;
        this.headY += (desiredY - this.headY) * ySmoothing;

        // --- 8. Antennas ---
        const desiredL = this.dualSine(now, 1.3, 3.11) * effectiveAntAmp;
        const desiredR = this.dualSine(now, 1.7, 2.73) * effectiveAntAmp;
        this.antennaLeft += (desiredL - this.antennaLeft) * antennaSmoothing;
        this.antennaRight += (desiredR - this.antennaRight) * antennaSmoothing;

        // --- 9. Send to active interface ---
        // Reachy Mini head frame: x=forward, y=left, z=up
        iface.setTarget(
            { x: 0, y: 0, z: this.headY, roll: this.headRoll, pitch: this.headPitch, yaw: this.headYaw },
            this.bodyYaw,
            [this.antennaLeft, this.antennaRight]
        ).catch(() => {});
    }

    // ----------------------------------------------------------------
    // Hardware / Connection
    // ----------------------------------------------------------------
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

    // ----------------------------------------------------------------
    // Profile
    // ----------------------------------------------------------------

    public setProfile(profile: AnimationProfile): void {
        this.profile = profile;
    }

    // ================================================================
    // Gaze Targets
    // ================================================================

    /** Look at a world-space position. Clears sleep pose if active. */
    public lookAt(worldPos: vec3): void {
        this.isSleeping = false;
        const angles = this.anglesToTarget(worldPos);
        this.targetYaw = angles.yaw;
        this.targetPitch = angles.pitch;
    }

    // Shorthand: look at the camera scene object.
    public lookAtCamera(camera: SceneObject): void {
        this.lookAt(camera.getTransform().getWorldPosition());
    }

    // Set target angles directly (radians). Used when the caller computes angles itself (e.g. search sweep).
    public lookAtAngles(yaw: number, pitch: number): void {
        this.isSleeping = false;
        this.targetYaw = yaw;
        this.targetPitch = pitch;
    }

    // ----------------------------------------------------------------
    // Overrides
    // ----------------------------------------------------------------
    // Start a rhythmic pitch nod. Speed is in rad/s, amplitude in degrees.
    public setNod(speed: number, amplitudeDeg: number): void {
        this.nodSpeed = speed;
        this.nodAmplitude = amplitudeDeg * Math.PI / 180;
        this.nodStartTime = getTime();
    }

    public clearNod(): void {
        this.nodSpeed = 0;
        this.nodAmplitude = 0;
    }

    // Configure periodic gaze-away behavior, or null to disable.
    public setGlanceBehavior(config: GlanceConfig | null): void {
        this.glanceConfig = config;
        if (!config) {
            this.glanceOffsetYaw = 0;
            this.glanceOffsetPitch = 0;
            this.glanceOffsetRoll = 0;
            this.isGlancingAway = false;
        } else {
            this.isGlancingAway = false;
            this.nextGlanceChangeTime = getTime() + this.randomRange(config.lookMinSec, config.lookMaxSec);
            this.glanceOffsetYaw = 0;
            this.glanceOffsetPitch = 0;
            this.glanceOffsetRoll = 0;
        }
    }

    // Enter sleep pose: head tucked, minimal movement. Idempotent.
    public setSleepPose(): void {
        if (this.isSleeping) return;
        this.isSleeping = true;
        this.glanceConfig = null;
        this.glanceOffsetYaw = 0;
        this.glanceOffsetPitch = 0;
        this.glanceOffsetRoll = 0;
        this.clearNod();
    }

    public async goto(pose: XYZRPYPose, bodyYaw: number, duration: number, interpolation: string): Promise<string> {
        const iface = this.getActiveInterface();
        if (!iface) throw new Error("RobotDriver: no active movement interface");
        return iface.goto(pose, bodyYaw, duration, interpolation);
    }

    public async playAudio(track: AudioTrackAsset): Promise<void> {
        const iface = this.getActiveInterface();
        if (!iface) throw new Error("RobotDriver: no active movement interface");
        return iface.playAudio(track);
    }


    private updateGlance(now: number): void {
        if (!this.glanceConfig || now < this.nextGlanceChangeTime) return;

        const rollRange = 10 * Math.PI / 180;
        const cfg = this.glanceConfig;

        if (this.isGlancingAway) {
            this.isGlancingAway = false;
            this.nextGlanceChangeTime = now + this.randomRange(cfg.lookMinSec, cfg.lookMaxSec);
            this.glanceOffsetYaw = 0;
            this.glanceOffsetPitch = 0;
            this.glanceOffsetRoll = this.randomRange(-rollRange * 0.3, rollRange * 0.3);
        } else {
            this.isGlancingAway = true;
            this.nextGlanceChangeTime = now + this.randomRange(cfg.glanceMinSec, cfg.glanceMaxSec);
            const yr = cfg.yawOffsetDeg * Math.PI / 180;
            const pr = cfg.pitchOffsetDeg * Math.PI / 180;
            this.glanceOffsetYaw = this.randomRange(-yr, yr);
            this.glanceOffsetPitch = this.randomRange(-pr * 0.8, pr * 0.3);
            this.glanceOffsetRoll = this.randomRange(-rollRange, rollRange);
        }
    }

    // ----------------------------------------------------------------
    // Helpers
    // ----------------------------------------------------------------
    /** Compute yaw/pitch angles from headRoot to a world position. */
    public anglesToTarget(pos: vec3): { yaw: number; pitch: number } {
        const dir = pos.sub(this.headRoot.getTransform().getWorldPosition());
        const hDist = Math.sqrt(dir.x * dir.x + dir.z * dir.z);
        if (hDist < 0.001) {
            return { yaw: this.headYaw, pitch: dir.y > 0 ? this.MAX_PITCH : this.MIN_PITCH };
        }
        return { yaw: Math.atan2(dir.x, dir.z), pitch: -Math.atan2(dir.y, hDist) };
    }

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
