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

    private headRestPosition: vec3 | null = null;

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
    }

    // Set target pose immediately by applying transforms to scene objects
    public async setTarget(headPose: XYZRPYPose, bodyYaw?: number, antennas?: [number, number]): Promise<void> {

        // Track current pose for goto interpolation
        this.currentPose = { ...headPose };
        if (bodyYaw !== undefined) this.currentBodyYaw = bodyYaw;

        // Update body rotation
        if (bodyYaw !== undefined && this.bodySceneObject) {
            const bodyRotation = quat.fromEulerAngles(0, bodyYaw, 0);
            this.bodySceneObject.getTransform().setLocalRotation(bodyRotation);
        }

        // Update head position + rotation
        // Reachy Mini head frame: x=forward, y=left, z=up  (meters)
        // Lens Studio scene:      x=right,   y=up,   z=forward (centimeters)
        // Mapping: robot z (up) -> scene y, robot y (left) -> scene -x, robot x (fwd) -> scene z
        // Scale: meters -> centimeters (×100)
        if (this.headSceneObject) {
            // Capture rest position once so we can offset from it
            if (!this.headRestPosition) {
                this.headRestPosition = this.headSceneObject.getTransform().getLocalPosition();
            }
            const M2CM = 100;
            this.headSceneObject.getTransform().setLocalPosition(new vec3(
                this.headRestPosition.x - headPose.y * M2CM,
                this.headRestPosition.y + headPose.z * M2CM,
                this.headRestPosition.z + headPose.x * M2CM
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
}
