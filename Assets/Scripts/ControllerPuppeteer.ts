import { DaemonInterface, XYZRPYPose } from "./DaemonInterface";

/**
 * Clean look-at controller for Reachy Mini.
 * Computes head and body angles to look at a target, with smooth interpolation.
 */

export class ControllerPuppeteer {
    // Tracking state
    private headYaw: number = 0;
    private headPitch: number = 0;
    private bodyYaw: number = 0;

    // Smoothing parameters for natural movement
    private readonly HEAD_YAW_SMOOTHING: number = 0.06;
    private readonly HEAD_PITCH_SMOOTHING: number = 0.04;
    private readonly BODY_SMOOTHING: number = 0.04;
    private readonly MAX_YAW_CHANGE_PER_FRAME: number = 3 * Math.PI / 180;
    private readonly MAX_PITCH_CHANGE_PER_FRAME: number = 1.5 * Math.PI / 180;

    // Mechanical limits
    private readonly MIN_PITCH: number = -30 * Math.PI / 180;
    private readonly MAX_PITCH: number = 20 * Math.PI / 180;
    private readonly MAX_HEAD_YAW: number = 35 * Math.PI / 180;
    private readonly MAX_BODY_YAW: number = 160 * Math.PI / 180;

    constructor(
        private daemon: DaemonInterface,
        private target: SceneObject,
        private origin: SceneObject
    ) {}


    public reset(): void {
        this.headYaw = 0;
        this.headPitch = 0;
        this.bodyYaw = 0;
    }

    public update(): void {
        const desiredAngles = this.computeDesiredAngles();

        // Smoothly interpolate head towards desired angles with dampening
        const yawDelta = this.dampenChange(
            (desiredAngles.yaw - this.headYaw) * this.HEAD_YAW_SMOOTHING,
            this.MAX_YAW_CHANGE_PER_FRAME
        );
        const pitchDelta = this.dampenChange(
            (desiredAngles.pitch - this.headPitch) * this.HEAD_PITCH_SMOOTHING,
            this.MAX_PITCH_CHANGE_PER_FRAME
        );

        this.headYaw += yawDelta;
        this.headPitch += pitchDelta;

        this.headPitch = this.clamp(this.headPitch, this.MIN_PITCH, this.MAX_PITCH);
        const relativeYaw = this.headYaw - this.bodyYaw;
        const followStrength = Math.abs(relativeYaw) > this.MAX_HEAD_YAW * 0.5
            ? this.BODY_SMOOTHING * 2
            : this.BODY_SMOOTHING;

        if (Math.abs(relativeYaw) > this.MAX_HEAD_YAW) {
            const excess = Math.abs(relativeYaw) - this.MAX_HEAD_YAW;
            const bodyDelta = this.dampenChange(
                Math.sign(relativeYaw) * excess * this.BODY_SMOOTHING * 8,
                this.MAX_YAW_CHANGE_PER_FRAME
            );
            this.bodyYaw += bodyDelta;
        } else {
            this.bodyYaw += relativeYaw * followStrength;
        }

        // Clamp body yaw to mechanical limits
        this.bodyYaw = this.clamp(this.bodyYaw, -this.MAX_BODY_YAW, this.MAX_BODY_YAW);
        const maxTotalYaw = this.MAX_BODY_YAW + this.MAX_HEAD_YAW;
        this.headYaw = this.clamp(this.headYaw, -maxTotalYaw, maxTotalYaw);

        this.sendTargetPose();
    }

    private computeDesiredAngles(): { yaw: number; pitch: number } {
        const originPos = this.origin.getTransform().getWorldPosition();
        const targetPos = this.target.getTransform().getWorldPosition();

        // Calculate direction from origin to target
        const direction = targetPos.sub(originPos);
        const horizontalDist = Math.sqrt(direction.x * direction.x + direction.z * direction.z);

        if (horizontalDist < 0.001) {
            return { yaw: this.headYaw, pitch: direction.y > 0 ? this.MAX_PITCH : this.MIN_PITCH };
        }

        const yaw = Math.atan2(direction.x, direction.z);
        const pitch = -Math.atan2(direction.y, horizontalDist);

        return { yaw, pitch };
    }

    private sendTargetPose(): void {
        const headPose: XYZRPYPose = {
            x: 0,
            y: 0,
            z: 0,
            roll: 0,
            pitch: this.headPitch,
            yaw: this.headYaw
        };

        this.daemon.setTarget(headPose, this.bodyYaw).catch(() => {});
    }

    private dampenChange(delta: number, maxDelta: number): number {
        return this.clamp(delta, -maxDelta, maxDelta);
    }

    private clamp(val: number, min: number, max: number): number {
        return Math.max(min, Math.min(max, val));
    }
}
