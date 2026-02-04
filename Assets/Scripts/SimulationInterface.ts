import { XYZRPYPose, IMovementInterface } from "./MovementInterface";

@component
export class SimulationInterface extends BaseScriptComponent implements IMovementInterface {

    @input
    private bodySceneObject: SceneObject | null = null;
    @input
    private headSceneObject: SceneObject | null = null;

    // Store current body yaw for calculating relative head rotation
    private currentBodyYaw: number = 0;

    onAwake() {
    }

    /**
     * Set target pose immediately by applying rotations to scene objects
     * @param headPose Target head pose (only pitch and yaw are used for rotation)
     * @param bodyYaw Optional target body yaw in radians
     * @param antennas Optional antenna positions (ignored in simulation)
     */
    public async setTarget(headPose: XYZRPYPose, bodyYaw?: number, antennas?: [number, number]): Promise<void> {
        if (bodyYaw !== undefined) {
            this.currentBodyYaw = bodyYaw;
            if (this.bodySceneObject) {
                const bodyRotation = quat.fromEulerAngles(0, bodyYaw, 0);
                this.bodySceneObject.getTransform().setLocalRotation(bodyRotation);
            }
        }

        // Update head rotation
        if (this.headSceneObject) {
            const relativeHeadYaw = headPose.yaw - this.currentBodyYaw;
            const headRotation = quat.fromEulerAngles(headPose.pitch, relativeHeadYaw, 0);
            this.headSceneObject.getTransform().setLocalRotation(headRotation);
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
}
