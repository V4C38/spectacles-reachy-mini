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

    // Animation audio tracks (same names as backend animations)
    @input
    private audioGreeting: AudioTrackAsset | null = null;
    @input
    private audioGoodbye: AudioTrackAsset | null = null;
    @input
    private audioHappy: AudioTrackAsset | null = null;
    @input
    private audioNod: AudioTrackAsset | null = null;
    @input
    private audioWave: AudioTrackAsset | null = null;
    @input
    private audioSway: AudioTrackAsset | null = null;
    @input
    private audioPeekaboo: AudioTrackAsset | null = null;
    @input
    private audioSad: AudioTrackAsset | null = null;
    @input
    private audioExcited: AudioTrackAsset | null = null;
    @input
    private audioThinking: AudioTrackAsset | null = null;
    @input
    private audioDance: AudioTrackAsset | null = null;

    private headRestPosition: vec3 | null = null;

    // --- Antenna base angles (scene has antennas pre-angled in Y) ---
    private static readonly ANTENNA_LEFT_BASE_Y_DEG = 30;
    private static readonly ANTENNA_RIGHT_BASE_Y_DEG = -30;

    // --- Smoothing (matches Python-side LERP behaviour) ---
    // SMOOTHING_SPEED ≈ 4.0 gives alpha ≈ 0.12 per tick at 30 fps,
    // matching the MovementHandler POSE_ALPHA = 0.12 at 30 Hz.
    private static readonly SMOOTHING_SPEED = 4.0;

    // Target -- set by setTarget(), can jump
    private targetPose: XYZRPYPose = { x: 0, y: 0, z: 0, roll: 0, pitch: 0, yaw: 0 };
    private targetBodyYaw: number = 0;
    private targetAntennas: [number, number] = [0, 0];

    // Displayed -- lerped toward target each frame; what the scene objects show
    private displayedPose: XYZRPYPose = { x: 0, y: 0, z: 0, roll: 0, pitch: 0, yaw: 0 };
    private displayedBodyYaw: number = 0;
    private displayedAntennas: [number, number] = [0, 0];

    // --- Goto interpolation state ---
    private gotoStartPose: XYZRPYPose | null = null;
    private gotoEndPose: XYZRPYPose | null = null;
    private gotoStartBodyYaw: number = 0;
    private gotoEndBodyYaw: number = 0;
    private gotoStartTime: number = 0;
    private gotoDuration: number = 0;
    private gotoInterpolation: string = "minjerk";
    private gotoUpdateEvent: SceneEvent | null = null;
    private gotoResolve: (() => void) | null = null;

    // --- Current pose (tracked for goto start capture) ---
    private currentPose: XYZRPYPose = { x: 0, y: 0, z: 0, roll: 0, pitch: 0, yaw: 0 };
    private currentBodyYaw: number = 0;

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

    // Store target pose. The smoothing tick lerps toward it each frame.
    public async setTarget(headPose: XYZRPYPose, bodyYaw?: number, antennas?: [number, number]): Promise<void> {
        this.targetPose = { ...headPose };
        if (bodyYaw !== undefined) this.targetBodyYaw = bodyYaw;
        if (antennas) this.targetAntennas = [antennas[0], antennas[1]];

        // Keep current pose in sync for goto start-capture
        this.currentPose = { ...headPose };
        if (bodyYaw !== undefined) this.currentBodyYaw = bodyYaw;
    }

    // --- Smoothing loop (runs every frame) ---
    private smoothingTick(): void {
        const dt = getDeltaTime();
        if (dt <= 0) return;

        // Frame-rate-independent alpha: at 30fps this ≈ 0.12
        const alpha = 1 - Math.exp(-SimulationAdapter.SMOOTHING_SPEED * dt);

        this.displayedPose.x     += alpha * (this.targetPose.x     - this.displayedPose.x);
        this.displayedPose.y     += alpha * (this.targetPose.y     - this.displayedPose.y);
        this.displayedPose.z     += alpha * (this.targetPose.z     - this.displayedPose.z);
        this.displayedPose.roll  += alpha * (this.targetPose.roll  - this.displayedPose.roll);
        this.displayedPose.pitch += alpha * (this.targetPose.pitch - this.displayedPose.pitch);
        this.displayedPose.yaw   += alpha * (this.targetPose.yaw   - this.displayedPose.yaw);

        this.displayedBodyYaw += alpha * (this.targetBodyYaw - this.displayedBodyYaw);
        this.displayedAntennas[0] += alpha * (this.targetAntennas[0] - this.displayedAntennas[0]);
        this.displayedAntennas[1] += alpha * (this.targetAntennas[1] - this.displayedAntennas[1]);

        this.applyToScene(this.displayedPose, this.displayedBodyYaw, this.displayedAntennas);
    }

    // --- Apply pose to scene objects ---
    private applyToScene(pose: XYZRPYPose, bodyYaw: number, antennas: [number, number]): void {
        if (this.bodySceneObject) {
            const bodyRotation = quat.fromEulerAngles(0, bodyYaw, 0);
            this.bodySceneObject.getTransform().setLocalRotation(bodyRotation);
        }

        // Reachy Mini head frame: x=forward, y=left, z=up  (meters)
        // Lens Studio scene:      x=right,   y=up,   z=forward (centimeters)
        if (this.headSceneObject) {
            if (!this.headRestPosition) {
                this.headRestPosition = this.headSceneObject.getTransform().getLocalPosition();
            }
            const M2CM = 100;
            this.headSceneObject.getTransform().setLocalPosition(new vec3(
                this.headRestPosition.x - pose.y * M2CM,
                this.headRestPosition.y + pose.z * M2CM,
                this.headRestPosition.z + pose.x * M2CM
            ));
            const headRotation = quat.fromEulerAngles(pose.pitch, pose.yaw, pose.roll);
            this.headSceneObject.getTransform().setLocalRotation(headRotation);
        }

        if (this.leftAntennaSceneObject && this.rightAntennaSceneObject) {
            const headWorldRot = this.headSceneObject
                ? this.headSceneObject.getTransform().getWorldRotation()
                : quat.quatIdentity();

            // Antennas are pre-angled Y +30° (left) / -30° (right) in the scene; apply base then pitch.
            const leftBaseY = quat.fromEulerAngles(0, SimulationAdapter.ANTENNA_LEFT_BASE_Y_DEG, 0);
            const rightBaseY = quat.fromEulerAngles(0, SimulationAdapter.ANTENNA_RIGHT_BASE_Y_DEG, 0);
            const leftPitch = quat.fromEulerAngles(antennas[0], 0, 0);
            const rightPitch = quat.fromEulerAngles(antennas[1], 0, 0);

            this.leftAntennaSceneObject.getTransform().setWorldRotation(
                headWorldRot.multiply(leftBaseY.multiply(leftPitch))
            );
            this.rightAntennaSceneObject.getTransform().setWorldRotation(
                headWorldRot.multiply(rightBaseY.multiply(rightPitch))
            );
        }
    }

    // Move to target pose with smooth interpolation over the given duration.
    public async goto(headPose: XYZRPYPose, bodyYaw?: number, duration: number = 0.5, interpolation: string = "minjerk"): Promise<string> {
        // Cancel any in-progress goto
        this.cancelGoto();

        const uuid = "simulation-" + Date.now().toString();

        // If duration is negligible, snap immediately
        if (duration <= 0.01) {
            await this.setTarget(headPose, bodyYaw);
            return uuid;
        }

        // Capture start state
        this.gotoStartPose = { ...this.currentPose };
        this.gotoEndPose = { ...headPose };
        this.gotoStartBodyYaw = this.currentBodyYaw;
        this.gotoEndBodyYaw = bodyYaw ?? this.currentBodyYaw;
        this.gotoStartTime = getTime();
        this.gotoDuration = duration;
        this.gotoInterpolation = interpolation;

        // Return a promise that resolves when interpolation completes
        return new Promise<string>((resolve) => {
            this.gotoResolve = () => resolve(uuid);

            this.gotoUpdateEvent = this.createEvent("UpdateEvent");
            this.gotoUpdateEvent.bind(() => {
                this.tickGoto();
            });
        });
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

        // Wait for playback to complete
        return new Promise<void>((resolve) => {
            const delayEvent = this.createEvent("DelayedCallbackEvent") as DelayedCallbackEvent;
            delayEvent.bind(() => {
                resolve();
            });
            delayEvent.reset(durationSec);
        });
    }

    // ----------------------------------------------------------------
    // Goto interpolation internals
    // ----------------------------------------------------------------
    private tickGoto(): void {
        if (!this.gotoStartPose || !this.gotoEndPose) return;

        const elapsed = getTime() - this.gotoStartTime;
        const t = Math.min(elapsed / this.gotoDuration, 1.0);
        const s = this.ease(t, this.gotoInterpolation);

        const pose: XYZRPYPose = {
            x:     this.lerp(this.gotoStartPose.x,     this.gotoEndPose.x,     s),
            y:     this.lerp(this.gotoStartPose.y,     this.gotoEndPose.y,     s),
            z:     this.lerp(this.gotoStartPose.z,     this.gotoEndPose.z,     s),
            roll:  this.lerp(this.gotoStartPose.roll,  this.gotoEndPose.roll,  s),
            pitch: this.lerp(this.gotoStartPose.pitch, this.gotoEndPose.pitch, s),
            yaw:   this.lerp(this.gotoStartPose.yaw,   this.gotoEndPose.yaw,   s),
        };
        const bodyYaw = this.lerp(this.gotoStartBodyYaw, this.gotoEndBodyYaw, s);

        this.setTarget(pose, bodyYaw);

        if (t >= 1.0) {
            this.finishGoto();
        }
    }

    private finishGoto(): void {
        const resolve = this.gotoResolve;
        this.cancelGoto();
        if (resolve) resolve();
    }

    private cancelGoto(): void {
        if (this.gotoUpdateEvent) {
            this.removeEvent(this.gotoUpdateEvent);
            this.gotoUpdateEvent = null;
        }
        this.gotoStartPose = null;
        this.gotoEndPose = null;
        this.gotoResolve = null;
    }

    // ----------------------------------------------------------------
    // Helpers
    // ----------------------------------------------------------------

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

    // Apply easing curve based on interpolation mode. t is in [0,1].
    private ease(t: number, mode: string): number {
        switch (mode) {
            case "minjerk":
                // Minimum-jerk trajectory: 10t³ - 15t⁴ + 6t⁵
                return t * t * t * (10 + t * (-15 + t * 6));
            case "ease":
                // Ease-in-out (cubic)
                return t < 0.5
                    ? 4 * t * t * t
                    : 1 - Math.pow(-2 * t + 2, 3) / 2;
            case "cartoon":
                // Overshoot then settle
                const c = 1.70158;
                const c3 = c + 1;
                return 1 + c3 * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2);
            case "linear":
            default:
                return t;
        }
    }

    private lerp(a: number, b: number, t: number): number {
        return a + (b - a) * t;
    }

    public getAudioTrackForAnimation(name: string): AudioTrackAsset | null {
        const key = name.trim().toLowerCase();
        switch (key) {
            case "greeting": return this.audioGreeting;
            case "goodbye": return this.audioGoodbye;
            case "happy": return this.audioHappy;
            case "nod": return this.audioNod;
            case "wave": return this.audioWave;
            case "sway": return this.audioSway;
            case "peekaboo": return this.audioPeekaboo;
            case "sad": return this.audioSad;
            case "excited": return this.audioExcited;
            case "thinking": return this.audioThinking;
            case "dance": return this.audioDance;
            default: return null;
        }
    }

}
