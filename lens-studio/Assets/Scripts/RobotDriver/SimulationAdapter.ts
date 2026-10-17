import { XYZRPYPose, RobotInterface } from "./RobotDriver";

@component
export class SimulationAdapter extends BaseScriptComponent implements RobotInterface {

    @input
    private bodySceneObject: SceneObject | null = null;
    @input
    private headSceneObject: SceneObject | null = null;
    @input
    private leftAntennaSceneObject: SceneObject | null = null;
    @input
    private rightAntennaSceneObject: SceneObject | null = null;
    @input
    private audioComponent: AudioComponent | null = null;

    @input
    private hologramMaterial: Material | null = null;

    /** Cached at awake: per-RenderMeshVisual materials to restore in applyDefaultMaterials(). */
    private defaultMaterialsCache: { visual: RenderMeshVisual; materials: Material[] }[] = [];

    private headRestPosition: vec3 | null = null;

    // Same filter as movement_handler.py: POSE_ALPHA 0.12, ANTENNA_ALPHA 0.08, LOOP_INTERVAL 0.033
    // (τ ≈ 0.26 s head / 0.4 s antennas). Then a servo stage (SERVO_TAU_SEC) so a fast reversal
    // doesn't outrun the metal (ADR #150).
    // ponytail: the real loop is 0.033 s plus the IK work per tick, so this rate runs slightly fast.
    // Recalibrate if the bridge's numbers change. TRANSPORT_DELAY_SEC is the 2026-10-16
    // probe on this Mac (send-to-motors 0.13 s plus the lens 20 Hz hold).
    private static readonly POSE_RATE = -Math.log(1 - 0.12) / 0.033;
    private static readonly ANTENNA_RATE = -Math.log(1 - 0.08) / 0.033;
    private static readonly MAX_ANGULAR_VEL = 1.5;
    private static readonly MAX_POS_VEL = 0.05;
    private static readonly MAX_DT_FOR_VEL_CLAMP = 0.06;

    /** Sim clock: Wi-Fi + the 20 Hz windows + daemon, when no ack is coming back. */
    private static readonly TRANSPORT_DELAY_SEC = 0.155;
    /** After set_target_result. Localhost send-to-motors; the hop is inside the ack. */
    private static readonly POST_ACK_HEAD_SEC = 0.13;
    /** First-order servo lag after the bridge clamp. Fit on the 2026-10-16 traces. The head only. */
    private static readonly SERVO_TAU_SEC = 0.09;
    /** Antennas skip the head servo stage. Send-to-motors 0.09 s plus the lens 20 Hz hold. */
    private static readonly ANTENNA_DELAY_SEC = 0.115;
    /** Antenna motors after the ack. The 0.025 s lens hold is inside the ack. */
    private static readonly POST_ACK_ANTENNA_SEC = 0.09;
    /** True once the bridge is acking poses. The plant then times from the ack, not from the command. */
    private ackClock: boolean = false;
    /** One plant step. A long lens frame is split so the clamp keeps the time the bridge kept (ADR #153). */
    private static readonly SUBSTEP_SEC = 1 / 60;
    // ponytail: a frame longer than 0.5 s steps coarser than 60 Hz. The clamp stays honest until a
    // step exceeds MAX_DT_FOR_VEL_CLAMP (a stall past ~1.8 s). Raise MAX_SUBSTEPS if hitches grow past that.
    private static readonly MAX_SUBSTEPS = 30;
    // ponytail: 32 slots covers about 0.5 s at 60 fps; grow the ring if the delay is raised.
    private static readonly RING = 32;
    private static readonly SLOT = 10;

    // Head shell vs the URDF, parent-local cm (scene x right, y up, z forward).
    // The mesh sat 0.55 cm forward and 0.30 cm low of the SDK head shell.
    private static readonly SHELL_Y_CM = 0.30;
    private static readonly SHELL_Z_CM = -0.55;
    // URDF head frame relative to the shell-shifted HeadRoot. Rotation orbits this point.
    private readonly pivotCm: vec3 = new vec3(0, 0.05, -0.63);
    private readonly axisRight: vec3 = new vec3(1, 0, 0);
    private readonly axisUp: vec3 = new vec3(0, 1, 0);
    private readonly axisFwd: vec3 = new vec3(0, 0, 1);
    // URDF antenna axes in HeadRoot local (x = robot left, y up, z forward). ADR #151.
    // Hardware order is [right, left]; a hardware angle is the negated URDF angle.
    // leftAntennaSceneObject is the robot's right antenna (scene x negative).
    private readonly antAxisRight: vec3 = new vec3(0.497, -0.105, 0.861);
    private readonly antAxisLeft: vec3 = new vec3(-0.497, -0.105, 0.861);
    private leftAntRest: quat | null = null;
    private rightAntRest: quat | null = null;

    private targetPose: XYZRPYPose = { x: 0, y: 0, z: 0, roll: 0, pitch: 0, yaw: 0 };
    private targetBodyYaw: number = 0;
    private targetAntennas: [number, number] = [0, 0];
    /** Last commanded body yaw / antennas, used when a call omits them. */
    private heldBodyYaw: number = 0;
    private heldAntennas: [number, number] = [0, 0];
    /** t, x, y, z, roll, pitch, yaw, bodyYaw, antL, antR. Written in place. */
    private ring: Float64Array = new Float64Array(SimulationAdapter.RING * SimulationAdapter.SLOT);
    private ringWrite: number = 0;
    private ringCount: number = 0;
    private displayedPose: XYZRPYPose = { x: 0, y: 0, z: 0, roll: 0, pitch: 0, yaw: 0 };
    private displayedBodyYaw: number = 0;
    private displayedAntennas: [number, number] = [0, 0];
    /** What the scene shows: the clamped pose eased by SERVO_TAU_SEC. */
    private shownPose: XYZRPYPose = { x: 0, y: 0, z: 0, roll: 0, pitch: 0, yaw: 0 };
    private shownBodyYaw: number = 0;
    private shownAntennas: [number, number] = [0, 0];

    onAwake() {
        this.cacheDefaultMaterials();
        this.createEvent("UpdateEvent").bind(() => {
            this.smoothingTick();
        });
    }

    private cacheDefaultMaterials(): void {
        const containers = [
            this.bodySceneObject,
            this.headSceneObject,
            this.leftAntennaSceneObject,
            this.rightAntennaSceneObject,
        ].filter((o): o is SceneObject => o !== null);
        for (const container of containers) {
            const childCount = container.getChildrenCount();
            for (let c = 0; c < childCount; c++) {
                const visual = container.getChild(c).getComponent("Component.RenderMeshVisual") as RenderMeshVisual;
                if (!visual) continue;
                const meshSlotCount = visual.getMaterialsCount();
                const materials: Material[] = [];
                if (meshSlotCount > 0) {
                    materials.push(visual.mainMaterial);
                    for (let i = 1; i < meshSlotCount; i++) {
                        materials.push(visual.materials[i]);
                    }
                }
                if (materials.length > 0) {
                    this.defaultMaterialsCache.push({ visual, materials });
                }
            }
        }
    }

    /**
     * Store the commanded pose. The sample sits in a ring. The filter reads it
     * after the command delay, or after the shorter post-ack delay once
     * set_target_result is arriving.
     */
    public async setTarget(headPose: XYZRPYPose, bodyYaw?: number, antennas?: [number, number]): Promise<void> {
        this.setTargetNow(headPose, bodyYaw, antennas);
    }

    /** Command clock. Ignored while the bridge is acking poses. */
    public setTargetNow(headPose: XYZRPYPose, bodyYaw?: number, antennas?: [number, number]): void {
        if (this.ackClock) return;
        this.writeRing(getTime(), headPose, bodyYaw, antennas);
    }

    /** The bridge stored this pose. Later samples are timed from the ack. */
    public noteAck(headPose: XYZRPYPose, bodyYaw: number, antennas: [number, number]): void {
        if (!this.ackClock) {
            this.ackClock = true;
            this.ringWrite = 0;
            this.ringCount = 0;
        }
        this.writeRing(getTime(), headPose, bodyYaw, antennas);
    }

    /** No recent ack. The command clock owns the ring again. */
    public releaseAckClock(): void {
        if (!this.ackClock) return;
        this.ackClock = false;
        this.ringWrite = 0;
        this.ringCount = 0;
    }

    private writeRing(at: number, headPose: XYZRPYPose, bodyYaw?: number, antennas?: [number, number]): void {
        if (bodyYaw !== undefined) this.heldBodyYaw = bodyYaw;
        if (antennas) {
            this.heldAntennas[0] = antennas[0];
            this.heldAntennas[1] = antennas[1];
        }
        const s = this.ringWrite * SimulationAdapter.SLOT;
        const r = this.ring;
        r[s] = at;
        r[s + 1] = headPose.x; r[s + 2] = headPose.y; r[s + 3] = headPose.z;
        r[s + 4] = headPose.roll; r[s + 5] = headPose.pitch; r[s + 6] = headPose.yaw;
        r[s + 7] = this.heldBodyYaw;
        r[s + 8] = this.heldAntennas[0]; r[s + 9] = this.heldAntennas[1];
        this.ringWrite = (this.ringWrite + 1) % SimulationAdapter.RING;
        if (this.ringCount < SimulationAdapter.RING) this.ringCount++;
    }

    /** Newest sample at or before `cutoff`, else the oldest. -1 if empty. */
    private delayedSlot(cutoff: number): number {
        const n = this.ringCount;
        if (n === 0) return -1;
        const ring = SimulationAdapter.RING;
        const stride = SimulationAdapter.SLOT;
        for (let k = 1; k <= n; k++) {
            const idx = (this.ringWrite - k + ring) % ring;
            if (this.ring[idx * stride] <= cutoff) return idx;
        }
        return n < ring ? 0 : this.ringWrite;
    }

    /** The command the plant sees at time `at`: head delay and antenna delay differ. */
    private sampleDelayedTarget(at: number): void {
        const headDelay = this.ackClock ? SimulationAdapter.POST_ACK_HEAD_SEC : SimulationAdapter.TRANSPORT_DELAY_SEC;
        const antDelay = this.ackClock ? SimulationAdapter.POST_ACK_ANTENNA_SEC : SimulationAdapter.ANTENNA_DELAY_SEC;
        const idx = this.delayedSlot(at - headDelay);
        if (idx < 0) return;
        const r = this.ring;
        const s = idx * SimulationAdapter.SLOT;
        const t = this.targetPose;
        t.x = r[s + 1]; t.y = r[s + 2]; t.z = r[s + 3];
        t.roll = r[s + 4]; t.pitch = r[s + 5]; t.yaw = r[s + 6];
        this.targetBodyYaw = r[s + 7];
        const aidx = this.delayedSlot(at - antDelay);
        const as = aidx * SimulationAdapter.SLOT;
        this.targetAntennas[0] = r[as + 8];
        this.targetAntennas[1] = r[as + 9];
    }

    private smoothingTick(): void {
        const dt = getDeltaTime();
        if (dt <= 0) return;
        // One step per frame caps travel at 60 ms, so a hitch leaves the hologram behind the bridge.
        const n = Math.min(
            SimulationAdapter.MAX_SUBSTEPS,
            Math.ceil(dt / SimulationAdapter.SUBSTEP_SEC),
        );
        const h = dt / n;
        const alphaPose = 1 - Math.exp(-SimulationAdapter.POSE_RATE * h);
        const alphaAnt = 1 - Math.exp(-SimulationAdapter.ANTENNA_RATE * h);
        const dtClamped = Math.min(h, SimulationAdapter.MAX_DT_FOR_VEL_CLAMP);
        const maxDAng = SimulationAdapter.MAX_ANGULAR_VEL * dtClamped;
        const maxDPos = SimulationAdapter.MAX_POS_VEL * dtClamped;
        const clamp = (delta: number, maxAbs: number): number =>
            Math.max(-maxAbs, Math.min(maxAbs, delta));
        const start = getTime() - dt;
        for (let i = 1; i <= n; i++) {
            this.sampleDelayedTarget(start + i * h);
            this.displayedPose.x += clamp(alphaPose * (this.targetPose.x - this.displayedPose.x), maxDPos);
            this.displayedPose.y += clamp(alphaPose * (this.targetPose.y - this.displayedPose.y), maxDPos);
            this.displayedPose.z += clamp(alphaPose * (this.targetPose.z - this.displayedPose.z), maxDPos);
            this.displayedPose.roll += clamp(alphaPose * (this.targetPose.roll - this.displayedPose.roll), maxDAng);
            this.displayedPose.pitch += clamp(alphaPose * (this.targetPose.pitch - this.displayedPose.pitch), maxDAng);
            this.displayedPose.yaw += clamp(alphaPose * (this.targetPose.yaw - this.displayedPose.yaw), maxDAng);
            this.displayedBodyYaw += clamp(alphaPose * (this.targetBodyYaw - this.displayedBodyYaw), maxDAng);
            // Antennas are not velocity-clamped: movement_handler.py sends _current_antennas raw.
            this.displayedAntennas[0] += alphaAnt * (this.targetAntennas[0] - this.displayedAntennas[0]);
            this.displayedAntennas[1] += alphaAnt * (this.targetAntennas[1] - this.displayedAntennas[1]);
            this.easeShown(h);
        }
        this.applyToScene(this.shownPose, this.shownBodyYaw, this.shownAntennas);
    }

    /** Servo stage: the scene lags the clamped pose by SERVO_TAU_SEC. */
    private easeShown(dt: number): void {
        const a = 1 - Math.exp(-dt / SimulationAdapter.SERVO_TAU_SEC);
        const ease = (cur: number, goal: number): number => cur + a * (goal - cur);
        const s = this.shownPose;
        const d = this.displayedPose;
        s.x = ease(s.x, d.x); s.y = ease(s.y, d.y); s.z = ease(s.z, d.z);
        s.roll = ease(s.roll, d.roll); s.pitch = ease(s.pitch, d.pitch); s.yaw = ease(s.yaw, d.yaw);
        this.shownBodyYaw = ease(this.shownBodyYaw, this.displayedBodyYaw);
        // Antenna motors track the bridge EMA. The head servo stage makes them late (ADR #152).
        this.shownAntennas[0] = this.displayedAntennas[0];
        this.shownAntennas[1] = this.displayedAntennas[1];
    }

    private applyToScene(pose: XYZRPYPose, bodyYaw: number, antennas: [number, number]): void {
        if (this.bodySceneObject) {
            const bodyRotation = quat.fromEulerAngles(0, bodyYaw, 0);
            this.bodySceneObject.getTransform().setLocalRotation(bodyRotation);
        }

        // Reachy Mini head frame: x=forward, y=left, z=up  (meters)
        // Lens Studio scene:      x=right,   y=up,   z=forward (centimeters)
        // +y (robot left) maps to +x in the head's local scene frame so the
        // twin matches the metal (ADR #64).
        // Rotation is Rz(yaw)·Ry(pitch)·Rx(roll), the same product create_head_pose builds.
        // The head orbits the URDF head frame (pivotCm), not the HeadRoot origin.
        if (this.headSceneObject) {
            const headTf = this.headSceneObject.getTransform();
            if (!this.headRestPosition) {
                this.headRestPosition = headTf.getLocalPosition();
            }
            const M2CM = 100;
            const headRotation = quat.angleAxis(pose.yaw, this.axisUp)
                .multiply(quat.angleAxis(pose.pitch, this.axisRight))
                .multiply(quat.angleAxis(pose.roll, this.axisFwd));
            const turned = headRotation.multiplyVec3(this.pivotCm);
            headTf.setLocalPosition(new vec3(
                this.headRestPosition.x + pose.y * M2CM + (this.pivotCm.x - turned.x),
                this.headRestPosition.y + SimulationAdapter.SHELL_Y_CM + pose.z * M2CM + (this.pivotCm.y - turned.y),
                this.headRestPosition.z + SimulationAdapter.SHELL_Z_CM + pose.x * M2CM + (this.pivotCm.z - turned.z)
            ));
            headTf.setLocalRotation(headRotation);
        }

        if (this.leftAntennaSceneObject && this.rightAntennaSceneObject) {
            const leftTf = this.leftAntennaSceneObject.getTransform();
            const rightTf = this.rightAntennaSceneObject.getTransform();
            let leftRest = this.leftAntRest;
            let rightRest = this.rightAntRest;
            if (!leftRest || !rightRest) {
                leftRest = leftTf.getLocalRotation();
                rightRest = rightTf.getLocalRotation();
                this.leftAntRest = leftRest;
                this.rightAntRest = rightRest;
            }
            // Hardware angle a is -URDF about the joint axis (ADR #151).
            leftTf.setLocalRotation(quat.angleAxis(-antennas[0], this.antAxisRight).multiply(leftRest));
            rightTf.setLocalRotation(quat.angleAxis(-antennas[1], this.antAxisLeft).multiply(rightRest));
        }
    }

    /**
     * Play an AudioTrackAsset through the AudioComponent.
     * Promise resolves when playback completes.
     */
    public async playAudio(audioTrack: AudioTrackAsset): Promise<void> {
        if (!this.audioComponent) {
            throw new Error("SimulationAdapter: AudioComponent not assigned");
        }

        this.audioComponent.audioTrack = audioTrack;
        this.audioComponent.play(1);

        const durationSec = this.audioComponent.duration;
        print(`SimulationAdapter: Playing audio (${durationSec.toFixed(2)}s)`);

        return new Promise<void>((resolve) => {
            const delayEvent = this.createEvent("DelayedCallbackEvent") as DelayedCallbackEvent;
            delayEvent.bind(() => {
                resolve();
            });
            delayEvent.reset(durationSec);
        });
    }

    public applyHologramMaterial(): void {
        if (!this.hologramMaterial) return;
        const containers = [
            this.bodySceneObject,
            this.headSceneObject,
            this.leftAntennaSceneObject,
            this.rightAntennaSceneObject,
        ].filter((o): o is SceneObject => o !== null);
        const single = [this.hologramMaterial];
        for (const container of containers) {
            this.applyMaterialsToSubobjects(container, single);
        }
    }

    public applyDefaultMaterials(): void {
        for (const { visual, materials } of this.defaultMaterialsCache) {
            if (materials.length === 0) continue;
            visual.mainMaterial = materials[0];
            for (let i = 1; i < materials.length; i++) {
                visual.materials[i] = materials[i];
            }
        }
    }

    private applyMaterialsToSubobjects(container: SceneObject, materials: Material[]): void {
        if (materials.length === 0) return;
        const childCount = container.getChildrenCount();
        for (let c = 0; c < childCount; c++) {
            const visual = container.getChild(c).getComponent("Component.RenderMeshVisual") as RenderMeshVisual;
            if (!visual) continue;
            const meshSlotCount = visual.getMaterialsCount();
            const count = Math.min(materials.length, meshSlotCount);
            if (count === 0) continue;
            visual.mainMaterial = materials[0];
            for (let i = 1; i < count; i++) {
                visual.materials[i] = materials[i];
            }
        }
    }
}
