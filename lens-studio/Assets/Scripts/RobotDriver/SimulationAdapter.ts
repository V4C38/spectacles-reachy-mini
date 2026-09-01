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

    private static readonly ANTENNA_LEFT_BASE_Y_DEG = 30;
    private static readonly ANTENNA_RIGHT_BASE_Y_DEG = -30;

    // Lag the hologram to match the Python plant (POSE_ALPHA=0.12) plus WS/SDK.
    // 2.0 → τ ≈ 0.5 s, vs 4.0 which only matched the LERP and still led the motors.
    private static readonly SMOOTHING_SPEED = 2.0;
    private static readonly SMOOTHING_SPEED_ANTENNA = 1.25;
    private static readonly MAX_ANGULAR_VEL = 1.5;
    private static readonly MAX_POS_VEL = 0.05;
    private static readonly MAX_DT_FOR_VEL_CLAMP = 0.06;

    private targetPose: XYZRPYPose = { x: 0, y: 0, z: 0, roll: 0, pitch: 0, yaw: 0 };
    private targetBodyYaw: number = 0;
    private targetAntennas: [number, number] = [0, 0];
    private displayedPose: XYZRPYPose = { x: 0, y: 0, z: 0, roll: 0, pitch: 0, yaw: 0 };
    private displayedBodyYaw: number = 0;
    private displayedAntennas: [number, number] = [0, 0];

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

    /** Store the commanded pose. The smoothing tick matches the Python plant. */
    public async setTarget(headPose: XYZRPYPose, bodyYaw?: number, antennas?: [number, number]): Promise<void> {
        this.targetPose = { ...headPose };
        if (bodyYaw !== undefined) this.targetBodyYaw = bodyYaw;
        if (antennas) this.targetAntennas = [antennas[0], antennas[1]];
    }

    private smoothingTick(): void {
        const dt = getDeltaTime();
        if (dt <= 0) return;

        const alphaPose = 1 - Math.exp(-SimulationAdapter.SMOOTHING_SPEED * dt);
        const alphaAnt = 1 - Math.exp(-SimulationAdapter.SMOOTHING_SPEED_ANTENNA * dt);

        const dtClamped = Math.min(dt, SimulationAdapter.MAX_DT_FOR_VEL_CLAMP);
        const maxDAng = SimulationAdapter.MAX_ANGULAR_VEL * dtClamped;
        const maxDPos = SimulationAdapter.MAX_POS_VEL * dtClamped;

        const clamp = (delta: number, maxAbs: number): number =>
            Math.max(-maxAbs, Math.min(maxAbs, delta));

        this.displayedPose.x += clamp(alphaPose * (this.targetPose.x - this.displayedPose.x), maxDPos);
        this.displayedPose.y += clamp(alphaPose * (this.targetPose.y - this.displayedPose.y), maxDPos);
        this.displayedPose.z += clamp(alphaPose * (this.targetPose.z - this.displayedPose.z), maxDPos);
        this.displayedPose.roll += clamp(alphaPose * (this.targetPose.roll - this.displayedPose.roll), maxDAng);
        this.displayedPose.pitch += clamp(alphaPose * (this.targetPose.pitch - this.displayedPose.pitch), maxDAng);
        this.displayedPose.yaw += clamp(alphaPose * (this.targetPose.yaw - this.displayedPose.yaw), maxDAng);

        this.displayedBodyYaw += clamp(alphaPose * (this.targetBodyYaw - this.displayedBodyYaw), maxDAng);
        this.displayedAntennas[0] += clamp(alphaAnt * (this.targetAntennas[0] - this.displayedAntennas[0]), maxDAng);
        this.displayedAntennas[1] += clamp(alphaAnt * (this.targetAntennas[1] - this.displayedAntennas[1]), maxDAng);

        this.applyToScene(this.displayedPose, this.displayedBodyYaw, this.displayedAntennas);
    }

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
