import { XYZRPYPose, IMovementInterface } from "./MovementInterface";

@component
export class SimulationInterface extends BaseScriptComponent implements IMovementInterface {

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

    private headRestPosition: vec3 | null = null;

    onAwake() {
    }

    /**
     * Set target pose immediately by applying transforms to scene objects
     * @param headPose Target head pose (x,y,z translation in meters + pitch, yaw, roll rotation)
     * @param bodyYaw Optional target body yaw in radians
     * @param antennas Optional antenna positions [left, right] in radians
     */
    public async setTarget(headPose: XYZRPYPose, bodyYaw?: number, antennas?: [number, number]): Promise<void> {

        // Update body rotation
        if (bodyYaw !== undefined && this.bodySceneObject) {
            const bodyRotation = quat.fromEulerAngles(0, bodyYaw, 0);
            this.bodySceneObject.getTransform().setLocalRotation(bodyRotation);
        }

        // Update head position + rotation
        if (this.headSceneObject) {
            // Capture rest position once so we can offset from it
            if (!this.headRestPosition) {
                this.headRestPosition = this.headSceneObject.getTransform().getLocalPosition();
            }
            this.headSceneObject.getTransform().setLocalPosition(new vec3(
                this.headRestPosition.x + headPose.x,
                this.headRestPosition.y + headPose.y,
                this.headRestPosition.z + headPose.z
            ));
            const headRotation = quat.fromEulerAngles(headPose.pitch, headPose.yaw, headPose.roll);
            this.headSceneObject.getTransform().setLocalRotation(headRotation);
        }

        // Update antenna rotations (relative to head orientation, not world)
        if (this.leftAntennaSceneObject && this.rightAntennaSceneObject && antennas) {
            const headWorldRot = this.headSceneObject
                ? this.headSceneObject.getTransform().getWorldRotation()
                : quat.quatIdentity();

            this.leftAntennaSceneObject.getTransform().setWorldRotation(
                headWorldRot.multiply(quat.fromEulerAngles(antennas[0], 0, 0))
            );
            this.rightAntennaSceneObject.getTransform().setWorldRotation(
                headWorldRot.multiply(quat.fromEulerAngles(antennas[1], 0, 0))
            );
        }
    }

    /**
     * Move to target pose (simplified: just calls setTarget immediately)
     * @param headPose Target head pose
     * @param bodyYaw Optional target body yaw in radians
     * @param duration Duration of movement (ignored in simplified simulation)
     * @param interpolation Interpolation mode (ignored in simplified simulation)
     * @returns A dummy UUID since simulation doesn't need move tracking
     */
    public async goto(headPose: XYZRPYPose, bodyYaw?: number, duration: number = 0.5, interpolation: string = "minjerk"): Promise<string> {
        await this.setTarget(headPose, bodyYaw);
        // Return a dummy UUID for compatibility
        return "simulation-" + Date.now().toString();
    }

    /**
     * Play an AudioTrackAsset through the AudioComponent.
     * Promise resolves when playback completes.
     */
    public async playAudio(audioTrack: AudioTrackAsset): Promise<void> {
        if (!this.audioComponent) {
            throw new Error("SimulationInterface: AudioComponent not assigned");
        }

        this.audioComponent.audioTrack = audioTrack;
        this.audioComponent.play(1);

        const durationSec = this.audioComponent.duration;
        print(`SimulationInterface: Playing audio (${durationSec.toFixed(2)}s)`);

        // Wait for playback to complete
        return new Promise<void>((resolve) => {
            const delayEvent = this.createEvent("DelayedCallbackEvent") as DelayedCallbackEvent;
            delayEvent.bind(() => {
                resolve();
            });
            delayEvent.reset(durationSec);
        });
    }
}
