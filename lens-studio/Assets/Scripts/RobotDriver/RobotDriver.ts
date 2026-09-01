import { HardwareAdapter } from "./HardwareAdapter";
import { SimulationAdapter } from "./SimulationAdapter";
import { AnimationParams, PRESETS } from "./RobotAnimationConfig";

/** 3D pose: position (x, y, z) in meters, orientation (roll, pitch, yaw) in radians. */
export interface XYZRPYPose {
    x: number; y: number; z: number;
    roll: number; pitch: number; yaw: number;
}

/** Full commanded body pose: 6-DOF head + body yaw (+ optional antennas). */
export interface BodyPose {
    head: XYZRPYPose;   // Reachy base frame: x forward, y left, z up (m); rpy (rad)
    bodyYaw: number;    // rad
    antennas?: [number, number];  // omitted = keep last
}

/** Internal pose with required antennas. */
interface CompleteBodyPose {
    head: XYZRPYPose;
    bodyYaw: number;
    antennas: [number, number];
}

type PoseIntent = "gaze" | "pose";

/** Interface that both HardwareAdapter and SimulationAdapter implement. */
export interface RobotInterface {
    setTarget(headPose: XYZRPYPose, bodyYaw?: number, antennas?: [number, number]): Promise<void>;
    playAudio(audioTrack: AudioTrackAsset): Promise<void>;
}

/**
 * Single owner of robot pose:
 * a private tick interpolates current toward target, clamps, and emits `setTarget`.
 */
@component
export class RobotDriver extends BaseScriptComponent {

    @input
    private hardwareAdapter: HardwareAdapter | null = null;
    @input
    private simulationAdapter: SimulationAdapter | null = null;
    @input
    private headRoot: SceneObject | null = null;

    @input
    public headMoveSpeed: number = 0.05;
    @input
    public maxHeadDelta: number = 2.0;
    @input
    public rollAmplitude: number = 8.0;
    @input
    public yBobAmplitude: number = 0.005;
    /** Max vertical offset when headHeight = 1. Meters. */
    @input
    public headYBase: number = 0.025;
    @input
    public antennaAmplitude: number = 15.0;

    // Stewart platform: motor_arm=0.04m, rod=0.085m → pitch ≈ ±25°, Z ≈ ±0.03m
    private readonly MIN_PITCH = -25 * Math.PI / 180;
    private readonly MAX_PITCH = 25 * Math.PI / 180;
    private readonly MAX_HEAD_YAW = 65 * Math.PI / 180;
    private readonly MAX_BODY_YAW = 160 * Math.PI / 180;
    private readonly MAX_ROLL = 25 * Math.PI / 180;
    private readonly MAX_HEAD_YAW_ABSOLUTE = 180 * Math.PI / 180;
    private readonly ROLL_YAW_COUPLING = 0.12;
    private readonly MIN_HEAD_Z = -0.02;
    private readonly MAX_HEAD_Z = 0.03;

    // Daemon-matching workspace (must stay in sync with movement_handler.py)
    private readonly ELLIPSOID_ROLL_MAX_RAD = 18.0 * Math.PI / 180;
    private readonly ELLIPSOID_PITCH_MAX_RAD = 18.0 * Math.PI / 180;
    private readonly ELLIPSOID_Z_MAX = 0.018;
    private readonly ELLIPSOID_Z_PRECLAMP_MIN = 0.0;
    private readonly ELLIPSOID_Z_PRECLAMP_MAX = 0.025;
    private readonly XY_DISK_RADIUS = 0.018;

    // Plant velocity limits (must stay in sync with movement_handler.py)
    private readonly MAX_ANGULAR_VEL = 1.5; // rad/s
    private readonly MAX_POS_VEL = 0.05;    // m/s
    private readonly MAX_DT_FOR_VEL_CLAMP = 0.06;

    private targetPose: CompleteBodyPose = this.zeroPose();
    private currentPose: CompleteBodyPose = this.zeroPose();
    private activeIntent: PoseIntent = "gaze";

    private prevHeadYaw: number = 0;
    private headYBase_current: number = 0;
    private neutralPitch: number = 0;
    private params: AnimationParams = { ...PRESETS.idle };
    private gazeTarget: vec3 | null = null;

    private gazeVarTargetYaw: number = 0;
    private gazeVarTargetPitch: number = 0;
    private gazeVarCurrentYaw: number = 0;
    private gazeVarCurrentPitch: number = 0;
    private gazeVarNextChangeTime: number = 0;

    private isPaused: boolean = true;
    private simulationMode: boolean = false;

    onAwake() {
        this.createEvent("UpdateEvent").bind(() => this.tick());
    }

    public setParams(incoming: Partial<AnimationParams>): void {
        this.params = { ...this.params, ...incoming };
    }

    public getParams(): AnimationParams {
        return { ...this.params };
    }

    /** Set the pitch used when no gaze target (radians). Positive = look down. */
    public setNeutralPitch(pitch: number): void {
        this.neutralPitch = pitch;
    }

    /** Look at a world-space position. Pass null to look straight ahead. Applied on the next tick after resume. */
    public setGazeTarget(pos: vec3 | null): void {
        this.activeIntent = "gaze";
        this.gazeTarget = pos;
    }

    public getGazeTarget(): vec3 | null {
        return this.gazeTarget;
    }

    /**
     * Hold a complete 6-DOF head pose + body yaw. Applied on the next tick after resume if paused.
     */
    public setBodyPose(pose: BodyPose): void {
        this.activeIntent = "pose";
        const antennas: [number, number] = pose.antennas
            ? [
                this.finiteOr(pose.antennas[0], this.targetPose.antennas[0]),
                this.finiteOr(pose.antennas[1], this.targetPose.antennas[1]),
            ]
            : [this.targetPose.antennas[0], this.targetPose.antennas[1]];
        const clamped = this.clampBodyPose(
            this.sanitizeHead(pose.head),
            this.finiteOr(pose.bodyYaw, this.targetPose.bodyYaw),
        );
        this.targetPose = {
            head: { ...clamped.head },
            bodyYaw: clamped.bodyYaw,
            antennas: [antennas[0], antennas[1]],
        };
        this.headYBase_current = clamped.head.z;
    }

    /** Current interpolated pose after ellipsoid + xy-disk clamp. */
    public getBodyPose(): BodyPose {
        return {
            head: { ...this.currentPose.head },
            bodyYaw: this.currentPose.bodyYaw,
            antennas: [this.currentPose.antennas[0], this.currentPose.antennas[1]],
        };
    }

    public reset(): void {
        this.activeIntent = "gaze";
        this.targetPose = this.zeroPose();
        this.currentPose = this.zeroPose();
        this.headYBase_current = 0;
        this.prevHeadYaw = 0;
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
     * Snap current and target to the steady-state pose implied by the current params.
     */
    public snapToCurrentParams(): void {
        const z = this.headYBase * this.params.headHeight;
        const snapped: CompleteBodyPose = {
            head: { x: 0, y: 0, z, roll: 0, pitch: this.neutralPitch, yaw: 0 },
            bodyYaw: 0,
            antennas: [0, 0],
        };
        this.targetPose = this.copyPose(snapped);
        this.currentPose = this.copyPose(snapped);
        this.headYBase_current = z;
        this.prevHeadYaw = 0;
    }

    /** Freeze at the last emitted pose. Tick does not interpolate or send until resume(). */
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
        const head = this.currentPose.head;
        return { yaw: head.yaw, pitch: head.pitch, roll: head.roll };
    }

    public getBodyYaw(): number {
        return this.currentPose.bodyYaw;
    }

    public getHeadWorldPosition(): vec3 {
        if (!this.headRoot) {
            return new vec3(0, 0, 0);
        }
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

    public async playAudio(track: AudioTrackAsset): Promise<void> {
        const iface = this.getActiveInterface();
        if (!iface) throw new Error("RobotDriver: no active movement interface");
        return iface.playAudio(track);
    }

    private tick(): void {
        if (this.isPaused) return;
        if (!this.getActiveInterface()) return;

        if (this.activeIntent === "gaze") {
            this.deriveGazeTarget();
        }
        this.advanceCurrentTowardTarget();

        const clamped = this.clampBodyPose(this.currentPose.head, this.currentPose.bodyYaw);
        this.currentPose.head = clamped.head;
        this.currentPose.bodyYaw = clamped.bodyYaw;
        this.emitCurrent();
    }

    /** Gaze-derived target: x/y stay 0; yaw/pitch from look-at; z/roll/antennas from ambient motion. */
    private deriveGazeTarget(): void {
        const now = getTime();
        const DEG = Math.PI / 180;
        const p = this.params;
        const yawSmoothing = this.headMoveSpeed * p.gazeResponsiveness;
        const ySmoothing = yawSmoothing * 0.8;
        const effectiveRollAmp = this.rollAmplitude * p.liveliness * DEG;
        const effectiveYAmp = this.yBobAmplitude * p.liveliness;
        const effectiveAntAmp = this.antennaAmplitude * p.antennaActivity * DEG;
        const antSpeed = 0.5 + p.antennaActivity * 0.5;

        let desiredYaw: number;
        let desiredPitch: number;
        if (this.gazeTarget) {
            const angles = this.anglesToTarget(this.gazeTarget);
            if (isFinite(angles.yaw) && isFinite(angles.pitch)) {
                desiredYaw = angles.yaw;
                desiredPitch = angles.pitch;
            } else {
                desiredYaw = this.currentPose.head.yaw;
                desiredPitch = this.currentPose.head.pitch;
            }
        } else {
            desiredYaw = 0;
            desiredPitch = this.neutralPitch;
        }

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

        const targetBaseY = this.headYBase * p.headHeight;
        this.headYBase_current += (targetBaseY - this.headYBase_current) * ySmoothing;
        const desiredZ = this.headYBase_current + this.dualSine(now, 0.41, 0.29) * effectiveYAmp;
        const ambientRoll = Math.sin(now * 0.23) * Math.sin(now * 0.71) * effectiveRollAmp;

        this.targetPose = {
            head: {
                x: 0,
                y: 0,
                z: this.clamp(desiredZ, this.MIN_HEAD_Z, this.MAX_HEAD_Z),
                roll: this.clamp(ambientRoll, -this.MAX_ROLL, this.MAX_ROLL),
                pitch: this.clamp(desiredPitch, this.MIN_PITCH, this.MAX_PITCH),
                yaw: desiredYaw,
            },
            bodyYaw: desiredYaw,
            antennas: [
                this.dualSine(now * antSpeed, 1.3, 3.11) * effectiveAntAmp,
                this.dualSine(now * antSpeed, 1.7, 2.73) * effectiveAntAmp,
            ],
        };
    }

    private advanceCurrentTowardTarget(): void {
        const p = this.params;
        const DEG = Math.PI / 180;
        const yawSmoothing = this.headMoveSpeed * p.gazeResponsiveness;
        const pitchSmoothing = this.headMoveSpeed * p.gazeResponsiveness * 0.8;
        const maxYawDelta = this.maxHeadDelta * p.gazeResponsiveness * DEG;
        const maxPitchDelta = this.maxHeadDelta * 0.5 * p.gazeResponsiveness * DEG;
        const bodySmoothing = yawSmoothing * 0.7 * (0.3 + p.liveliness * 0.4);
        const rollSmoothing = yawSmoothing * 0.8;
        const antennaSmoothing = yawSmoothing * 1.5;
        const ySmoothing = yawSmoothing * 0.8;

        const cur = this.currentPose;
        const tgt = this.targetPose;
        const prevX = cur.head.x;
        const prevY = cur.head.y;
        const prevZ = cur.head.z;
        const prevRoll = cur.head.roll;
        const prevPitch = cur.head.pitch;
        const prevYaw = cur.head.yaw;
        const prevBodyYaw = cur.bodyYaw;
        const prevAntL = cur.antennas[0];
        const prevAntR = cur.antennas[1];

        cur.head.x += (tgt.head.x - cur.head.x) * ySmoothing;
        cur.head.y += (tgt.head.y - cur.head.y) * ySmoothing;
        cur.head.yaw += this.dampen((tgt.head.yaw - cur.head.yaw) * yawSmoothing, maxYawDelta);
        cur.head.pitch += this.dampen((tgt.head.pitch - cur.head.pitch) * pitchSmoothing, maxPitchDelta);
        cur.head.pitch = this.clamp(cur.head.pitch, this.MIN_PITCH, this.MAX_PITCH);

        if (this.activeIntent === "gaze") {
            const yawVel = cur.head.yaw - this.prevHeadYaw;
            const coupled = -yawVel * this.ROLL_YAW_COUPLING / Math.max(yawSmoothing, 0.001);
            tgt.head.roll = this.clamp(tgt.head.roll + coupled, -this.MAX_ROLL, this.MAX_ROLL);

            const relYaw = cur.head.yaw - cur.bodyYaw;
            const followStrength = Math.abs(relYaw) > this.MAX_HEAD_YAW * 0.5 ? bodySmoothing * 2 : bodySmoothing;
            if (Math.abs(relYaw) > this.MAX_HEAD_YAW) {
                const excess = Math.abs(relYaw) - this.MAX_HEAD_YAW;
                cur.bodyYaw += this.dampen(Math.sign(relYaw) * excess * bodySmoothing * 8, maxYawDelta);
            } else {
                cur.bodyYaw += relYaw * followStrength;
            }
        } else {
            cur.bodyYaw += this.dampen((tgt.bodyYaw - cur.bodyYaw) * bodySmoothing, maxYawDelta);
        }
        cur.bodyYaw = this.clamp(cur.bodyYaw, -this.MAX_BODY_YAW, this.MAX_BODY_YAW);
        const maxHeadYawRange = Math.min(this.MAX_BODY_YAW + this.MAX_HEAD_YAW, this.MAX_HEAD_YAW_ABSOLUTE);
        cur.head.yaw = this.clamp(cur.head.yaw, -maxHeadYawRange, maxHeadYawRange);

        cur.head.roll += (tgt.head.roll - cur.head.roll) * rollSmoothing;
        cur.head.z += (tgt.head.z - cur.head.z) * ySmoothing;
        cur.head.z = this.clamp(cur.head.z, this.MIN_HEAD_Z, this.MAX_HEAD_Z);
        cur.antennas[0] += (tgt.antennas[0] - cur.antennas[0]) * antennaSmoothing;
        cur.antennas[1] += (tgt.antennas[1] - cur.antennas[1]) * antennaSmoothing;

        const dt = Math.min(Math.max(getDeltaTime(), 0), this.MAX_DT_FOR_VEL_CLAMP);
        if (dt > 0) {
            const maxPos = this.MAX_POS_VEL * dt;
            const maxAng = this.MAX_ANGULAR_VEL * dt;
            cur.head.x = prevX + this.dampen(cur.head.x - prevX, maxPos);
            cur.head.y = prevY + this.dampen(cur.head.y - prevY, maxPos);
            cur.head.z = prevZ + this.dampen(cur.head.z - prevZ, maxPos);
            cur.head.roll = prevRoll + this.dampen(cur.head.roll - prevRoll, maxAng);
            cur.head.pitch = prevPitch + this.dampen(cur.head.pitch - prevPitch, maxAng);
            cur.head.yaw = prevYaw + this.dampen(cur.head.yaw - prevYaw, maxAng);
            cur.bodyYaw = prevBodyYaw + this.dampen(cur.bodyYaw - prevBodyYaw, maxAng);
            cur.antennas[0] = prevAntL + this.dampen(cur.antennas[0] - prevAntL, maxAng);
            cur.antennas[1] = prevAntR + this.dampen(cur.antennas[1] - prevAntR, maxAng);
        }

        this.prevHeadYaw = cur.head.yaw;
    }

    private emitCurrent(): void {
        const iface = this.getActiveInterface();
        if (!iface) return;
        const pose = this.currentPose;
        iface.setTarget(pose.head, pose.bodyYaw, pose.antennas).catch(() => {});

        if (!this.simulationMode && this.simulationAdapter) {
            this.simulationAdapter.setTarget(pose.head, pose.bodyYaw, pose.antennas).catch(() => {});
        }
    }

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

    public saveIp(ip: string): void {
        if (this.hardwareAdapter) this.hardwareAdapter.saveIp(ip);
    }

    public loadIp(): string | null {
        return this.hardwareAdapter ? this.hardwareAdapter.loadIp() : null;
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
            return { yaw: this.currentPose.head.yaw, pitch: dirInBase.y > 0 ? this.MAX_PITCH : this.MIN_PITCH };
        }
        return {
            yaw: Math.atan2(dirInBase.x, dirInBase.z),
            pitch: -Math.atan2(dirInBase.y, hDist),
        };
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

    private finiteOr(value: number, fallback: number): number {
        return isFinite(value) ? value : fallback;
    }

    private sanitizeHead(head: XYZRPYPose): XYZRPYPose {
        const last = this.currentPose.head;
        return {
            x: this.finiteOr(head.x, last.x),
            y: this.finiteOr(head.y, last.y),
            z: this.finiteOr(head.z, last.z),
            roll: this.finiteOr(head.roll, last.roll),
            pitch: this.finiteOr(head.pitch, last.pitch),
            yaw: this.finiteOr(head.yaw, last.yaw),
        };
    }

    private randomRange(min: number, max: number): number {
        return min + Math.random() * (max - min);
    }

    private zeroPose(): CompleteBodyPose {
        return {
            head: { x: 0, y: 0, z: 0, roll: 0, pitch: 0, yaw: 0 },
            bodyYaw: 0,
            antennas: [0, 0],
        };
    }

    private copyPose(pose: CompleteBodyPose): CompleteBodyPose {
        return {
            head: { ...pose.head },
            bodyYaw: pose.bodyYaw,
            antennas: [pose.antennas[0], pose.antennas[1]],
        };
    }

    /**
     * Project (roll, pitch, z) onto the Stewart tilt ellipsoid and (x, y) onto
     * an independent 18 mm disk. Yaw / body yaw / head–body delta stay independent.
     * Must match movement_handler.py.
     */
    private clampBodyPose(head: XYZRPYPose, bodyYaw: number): { head: XYZRPYPose; bodyYaw: number } {
        const xy = this.clampXyDisk(head.x, head.y);
        const tilt = this.clampStewartEllipsoid(head.roll, head.pitch, head.z);

        let yaw = this.clamp(head.yaw, -this.MAX_HEAD_YAW_ABSOLUTE, this.MAX_HEAD_YAW_ABSOLUTE);
        const bodyYawClamped = this.clamp(bodyYaw, -this.MAX_BODY_YAW, this.MAX_BODY_YAW);
        const delta = yaw - bodyYawClamped;
        if (delta > this.MAX_HEAD_YAW) {
            yaw = bodyYawClamped + this.MAX_HEAD_YAW;
        } else if (delta < -this.MAX_HEAD_YAW) {
            yaw = bodyYawClamped - this.MAX_HEAD_YAW;
        }

        return {
            head: { x: xy.x, y: xy.y, z: tilt.z, roll: tilt.roll, pitch: tilt.pitch, yaw },
            bodyYaw: bodyYawClamped,
        };
    }

    private clampStewartEllipsoid(roll: number, pitch: number, z: number): { roll: number; pitch: number; z: number } {
        const zClamped = this.clamp(z, this.ELLIPSOID_Z_PRECLAMP_MIN, this.ELLIPSOID_Z_PRECLAMP_MAX);
        const nr = this.ELLIPSOID_ROLL_MAX_RAD > 0 ? roll / this.ELLIPSOID_ROLL_MAX_RAD : 0;
        const np = this.ELLIPSOID_PITCH_MAX_RAD > 0 ? pitch / this.ELLIPSOID_PITCH_MAX_RAD : 0;
        const nz = this.ELLIPSOID_Z_MAX > 0 ? zClamped / this.ELLIPSOID_Z_MAX : 0;
        const distSq = nr * nr + np * np + nz * nz;
        if (distSq <= 1.0) {
            return { roll, pitch, z: zClamped };
        }
        const scale = 1.0 / Math.sqrt(distSq);
        return { roll: roll * scale, pitch: pitch * scale, z: zClamped * scale };
    }

    private clampXyDisk(x: number, y: number): { x: number; y: number } {
        const r = this.XY_DISK_RADIUS;
        if (r <= 0) return { x: 0, y: 0 };
        const distSq = (x / r) * (x / r) + (y / r) * (y / r);
        if (distSq <= 1.0) return { x, y };
        const scale = 1.0 / Math.sqrt(distSq);
        return { x: x * scale, y: y * scale };
    }
}
