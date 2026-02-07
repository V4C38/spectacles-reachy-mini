import { XYZRPYPose, IMovementInterface } from "./MovementInterface";

/**
 * Clean look-at controller for Reachy Mini.
 * Computes head and body angles to look at a target, with smooth interpolation.
 * Also drives subtle antenna movement, head tilt, and vertical bobbing.
 */

export class ControllerPuppeteer {
    // Tracking state
    private headYaw: number = 0;
    private headPitch: number = 0;
    private headRoll: number = 0;
    private headY: number = 0;
    private bodyYaw: number = 0;
    private prevHeadYaw: number = 0;
    private antennaLeft: number = 0;
    private antennaRight: number = 0;

    // Smoothing
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
    private readonly MAX_ROLL: number = 15 * Math.PI / 180;

    // Roll, Y-bob, antenna tuning
    private readonly ROLL_SMOOTHING: number = 0.04;
    private readonly ROLL_YAW_COUPLING: number = 0.12;
    private readonly ROLL_AMBIENT_AMP: number = 8 * Math.PI / 180;
    private readonly Y_SMOOTHING: number = 0.04;
    private readonly Y_AMP: number = 0.012;  // 12mm vertical bob
    private readonly ANTENNA_SMOOTHING: number = 0.08;
    private readonly ANTENNA_AMP: number = 12 * Math.PI / 180;

    constructor(
        private movementInterface: IMovementInterface,
        private target: SceneObject,
        private origin: SceneObject
    ) {}

    public reset(): void {
        this.headYaw = 0;
        this.headPitch = 0;
        this.headRoll = 0;
        this.headY = 0;
        this.bodyYaw = 0;
        this.prevHeadYaw = 0;
        this.antennaLeft = 0;
        this.antennaRight = 0;
    }

    public update(): void {
        const desiredAngles = this.computeDesiredAngles();

        // Smooth head toward target
        this.headYaw += this.dampen(
            (desiredAngles.yaw - this.headYaw) * this.HEAD_YAW_SMOOTHING,
            this.MAX_YAW_CHANGE_PER_FRAME
        );
        this.headPitch += this.dampen(
            (desiredAngles.pitch - this.headPitch) * this.HEAD_PITCH_SMOOTHING,
            this.MAX_PITCH_CHANGE_PER_FRAME
        );
        this.headPitch = this.clamp(this.headPitch, this.MIN_PITCH, this.MAX_PITCH);

        // Body follows head
        const relativeYaw = this.headYaw - this.bodyYaw;
        const followStrength = Math.abs(relativeYaw) > this.MAX_HEAD_YAW * 0.5
            ? this.BODY_SMOOTHING * 2 : this.BODY_SMOOTHING;
        if (Math.abs(relativeYaw) > this.MAX_HEAD_YAW) {
            const excess = Math.abs(relativeYaw) - this.MAX_HEAD_YAW;
            this.bodyYaw += this.dampen(Math.sign(relativeYaw) * excess * this.BODY_SMOOTHING * 8, this.MAX_YAW_CHANGE_PER_FRAME);
        } else {
            this.bodyYaw += relativeYaw * followStrength;
        }
        this.bodyYaw = this.clamp(this.bodyYaw, -this.MAX_BODY_YAW, this.MAX_BODY_YAW);
        this.headYaw = this.clamp(this.headYaw, -(this.MAX_BODY_YAW + this.MAX_HEAD_YAW), this.MAX_BODY_YAW + this.MAX_HEAD_YAW);

        const now = getTime();

        // Roll: yaw-velocity coupling + organic ambient sway (product of two sines)
        const yawVel = this.headYaw - this.prevHeadYaw;
        this.prevHeadYaw = this.headYaw;
        const ambientRoll = Math.sin(now * 0.23) * Math.sin(now * 0.71) * this.ROLL_AMBIENT_AMP;
        const desiredRoll = -yawVel * this.ROLL_YAW_COUPLING / this.HEAD_YAW_SMOOTHING + ambientRoll;
        this.headRoll += (this.clamp(desiredRoll, -this.MAX_ROLL, this.MAX_ROLL) - this.headRoll) * this.ROLL_SMOOTHING;

        // Vertical bob
        const desiredY = this.dualSine(now, 0.41, 0.29) * this.Y_AMP;
        this.headY += (desiredY - this.headY) * this.Y_SMOOTHING;

        // Antennas
        const desiredL = this.dualSine(now, 1.3, 3.11) * this.ANTENNA_AMP;
        const desiredR = this.dualSine(now, 1.7, 2.73) * this.ANTENNA_AMP;
        this.antennaLeft += (desiredL - this.antennaLeft) * this.ANTENNA_SMOOTHING;
        this.antennaRight += (desiredR - this.antennaRight) * this.ANTENNA_SMOOTHING;

        this.sendTargetPose();
    }

    private computeDesiredAngles(): { yaw: number; pitch: number } {
        const originPos = this.origin.getTransform().getWorldPosition();
        const targetPos = this.target.getTransform().getWorldPosition();
        const direction = targetPos.sub(originPos);
        const horizontalDist = Math.sqrt(direction.x * direction.x + direction.z * direction.z);
        if (horizontalDist < 0.001) {
            return { yaw: this.headYaw, pitch: direction.y > 0 ? this.MAX_PITCH : this.MIN_PITCH };
        }
        return {
            yaw: Math.atan2(direction.x, direction.z),
            pitch: -Math.atan2(direction.y, horizontalDist)
        };
    }

    private sendTargetPose(): void {
        this.movementInterface.setTarget(
            { x: 0, y: this.headY, z: 0, roll: this.headRoll, pitch: this.headPitch, yaw: this.headYaw },
            this.bodyYaw,
            [this.antennaLeft, this.antennaRight]
        ).catch(() => {});
    }

    /** Two layered sines producing an organic pattern in roughly [-1, 1] range */
    private dualSine(t: number, freqA: number, freqB: number): number {
        return Math.sin(t * freqA) * 0.6 + Math.sin(t * freqB) * 0.4;
    }

    private dampen(delta: number, maxDelta: number): number {
        return this.clamp(delta, -maxDelta, maxDelta);
    }

    private clamp(val: number, min: number, max: number): number {
        return Math.max(min, Math.min(max, val));
    }
}
