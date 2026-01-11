import {RoundButton} from "SpectaclesUIKit.lspkg/Scripts/Components/Button/RoundButton"
import animate, {CancelFunction} from "SpectaclesInteractionKit.lspkg/Utils/animate"
import {XYZRPYPose} from "./DaemonInterface"

enum RobotState {
    Uninitialized = "Uninitialized",
    Idle = "Idle",
    LookAtTarget = "LookAtTarget"
}

@component
export class ReachyMiniController extends BaseScriptComponent {
    @input("Component.ScriptComponent")
    @hint("Reference to the DaemonInterface component (singleton)")
    private daemonInterface!: ScriptComponent;

    @input
    @hint("RoundButton component from Spectacles UI Kit (should be set to toggleable mode)")
    private roundButton!: RoundButton;

    @input
    @hint("SceneObject entity to show/hide based on button toggle state")
    private controlledEntity!: SceneObject;

    @input
    @hint("Offset from button origin for controlled entity position (in local space)")
    private entityOffset: vec3 = new vec3(0, 15, 0);

    private currentAnimation: CancelFunction | null = null;
    private currentState: RobotState = RobotState.Uninitialized;
    private attentive2MoveUuid: string | null = null;
    private readonly ATTENTIVE2_DATASET_NAME: string = "pollen-robotics/reachy-mini-emotions-library";
    private readonly ATTENTIVE2_MOVE_NAME: string = "attentive2";
    private isAttentive2Looping: boolean = false;
    private lookAtUpdateEvent: SceneEvent | null = null;
    private idleUpdateEvent: SceneEvent | null = null;
    private lastMoveCheckTime: number = 0;
    private moveCheckInterval: number = 0.1; // Check every 100ms
    private moveStartTime: number = 0;
    
    // Look-at tracking state
    private headYaw: number = 0; // Head yaw in radians
    private headPitch: number = 0; // Head pitch in radians
    private headRoll: number = 0; // Head roll/tilt in radians (for character)
    private bodyYaw: number = 0; // Body yaw in radians (follows head with inertia)
    private leftAntenna: number = 0; // Left antenna angle in radians
    private rightAntenna: number = 0; // Right antenna angle in radians
    private trackingStartTime: number = 0; // For temporally consistent randomness
    private motionIntensity: number = 0; // Smoothed measure of overall motion (0-1)
    private lastHeadYaw: number = 0; // For computing velocity
    private lastHeadPitch: number = 0; // For computing velocity
    
    // Smoothing parameters for natural movement
    private readonly HEAD_YAW_SMOOTHING: number = 0.06; // How fast head yaw moves towards target
    private readonly HEAD_PITCH_SMOOTHING: number = 0.04; // Slower pitch movement
    private readonly BODY_SMOOTHING: number = 0.04; // How fast body follows head (increased for tighter follow)
    private readonly ANTENNA_SMOOTHING: number = 0.025; // Slower antenna smoothing to prevent jitter
    private readonly MOTION_INTENSITY_SMOOTHING: number = 0.05; // How fast motion intensity adapts
    private readonly MAX_YAW_CHANGE_PER_FRAME: number = 3 * Math.PI / 180; // Max 3 degrees per frame for yaw
    private readonly MAX_PITCH_CHANGE_PER_FRAME: number = 1.5 * Math.PI / 180; // Max 1.5 degrees per frame for pitch
    private readonly MAX_ANTENNA_CHANGE_PER_FRAME: number = 2 * Math.PI / 180; // Max 2 degrees per frame for antennas
    
    // Mechanical limits from kinematics (in radians)
    private readonly MIN_PITCH: number = -30 * Math.PI / 180; // -30 degrees (looking down)
    private readonly MAX_PITCH: number = 20 * Math.PI / 180; // +20 degrees (looking up)
    private readonly MAX_HEAD_YAW: number = 35 * Math.PI / 180; // ±35 degrees relative to body (reduced for tighter follow)
    private readonly MAX_BODY_YAW: number = 160 * Math.PI / 180; // ±160 degrees absolute
    private readonly MAX_ANTENNA: number = 45 * Math.PI / 180; // ±45 degrees for antennas
    private readonly MAX_ROLL: number = 10 * Math.PI / 180; // ±10 degrees for head tilt (increased)
    
    // Character/randomness parameters (temporally consistent noise using sin waves)
    private readonly PITCH_WOBBLE_AMPLITUDE: number = 6 * Math.PI / 180; // ±6 degrees (more pronounced)
    private readonly YAW_WOBBLE_AMPLITUDE: number = 5 * Math.PI / 180; // ±5 degrees (more pronounced)
    private readonly ROLL_WOBBLE_AMPLITUDE: number = 8 * Math.PI / 180; // ±8 degrees for head tilt (more pronounced)
    private readonly ANTENNA_BASE_AMPLITUDE: number = 8 * Math.PI / 180; // Base antenna movement when idle
    private readonly ANTENNA_MOTION_AMPLITUDE: number = 20 * Math.PI / 180; // Extra antenna movement when in motion
    private readonly WOBBLE_SPEED: number = 0.4; // Base frequency for wobble (slower for smoother feel)

    onAwake() {
        print(`ReachyMiniController: onAwake called, daemonInterface=${!!this.daemonInterface}`);
        
        // LookAt entity state / button events
        if (this.roundButton) {
            // onValueChange fires with 1 when on, 0 when off
            this.roundButton.onValueChange.add((value: number) => {
                const isToggledOn = value === 1;
                print(`ReachyMiniController: Button value changed to ${value}`);
                this.setState(isToggledOn ? RobotState.LookAtTarget : RobotState.Idle);
            });

            // Set initial state
            print(`ReachyMiniController: Setting initial state to Idle`);
            this.setState(RobotState.Idle);
        } else {
            print(`ReachyMiniController: WARNING - roundButton not set!`);
        }
    }

    private setState(newState: RobotState): void {
        if (this.currentState === newState) {
            print(`ReachyMiniController: setState(${newState}) - already in this state, skipping`);
            return;
        }
        print(`ReachyMiniController: setState(${newState}) from ${this.currentState}`);
        this.currentState = newState;

        // Handle state transition
        if (newState === RobotState.LookAtTarget) {
            this.stopAttentive2Loop();
            this.handleStateLookAtTarget();
        } else if (newState === RobotState.Idle) {
            this.stopLookAtTracking();
            this.handleStateIdle();
        }
    }

    private async handleStateLookAtTarget(): Promise<void> {
        await this.animateLookAtEntity(true);
        this.startLookAtTracking();
    }

    private async handleStateIdle(): Promise<void> {
        await this.animateLookAtEntity(false);
        this.startAttentive2Loop();
    }


    // -----------------------------------------------------------------------------------------
    // API
    // -----------------------------------------------------------------------------------------

    /**
     * Start the attentive2 emotion loop
     */
    private async startAttentive2Loop(): Promise<void> {
        print(`ReachyMiniController: startAttentive2Loop called, daemonInterface=${!!this.daemonInterface}, isLooping=${this.isAttentive2Looping}`);
        
        if (!this.daemonInterface) {
            print(`ReachyMiniController: ERROR - daemonInterface is null!`);
            return;
        }
        
        if (this.isAttentive2Looping) {
            print(`ReachyMiniController: Already looping, skipping`);
            return;
        }

        this.isAttentive2Looping = true;
        this.lastMoveCheckTime = getTime();
        
        // First, move to neutral/zero position before starting the idle animation
        await this.gotoNeutralPosition();
        
        // Set up update loop to check for move completion
        if (!this.idleUpdateEvent) {
            this.idleUpdateEvent = this.createEvent("UpdateEvent");
            this.idleUpdateEvent.bind(() => {
                if (this.currentState === RobotState.Idle && this.isAttentive2Looping) {
                    this.checkMoveCompletion();
                }
            });
        }
        
        // Start the animation loop
        this.playAttentive2Loop();
    }
    
    /**
     * Move robot to neutral/zero position before idle animation
     */
    private async gotoNeutralPosition(): Promise<void> {
        const daemon = this.daemonInterface as any;
        
        if (!daemon.goto) {
            print(`ReachyMiniController: WARNING - goto method not found on daemon`);
            return;
        }
        
        const neutralPose: XYZRPYPose = {
            x: 0, y: 0, z: 0,
            roll: 0, pitch: 0, yaw: 0
        };
        
        try {
            print(`ReachyMiniController: Moving to neutral position (1.5s)`);
            await daemon.goto(neutralPose, 0, 1.5, "minjerk");
            print(`ReachyMiniController: Reached neutral position`);
        } catch (error) {
            print(`ReachyMiniController: Error moving to neutral: ${error}`);
        }
    }

    /**
     * Play attentive2 and restart when it completes (loop)
     */
    private async playAttentive2Loop(): Promise<void> {
        print(`ReachyMiniController: playAttentive2Loop called, daemonInterface=${!!this.daemonInterface}, isLooping=${this.isAttentive2Looping}`);
        
        if (!this.daemonInterface) {
            print(`ReachyMiniController: playAttentive2Loop - no daemonInterface`);
            return;
        }
        
        if (!this.isAttentive2Looping) {
            print(`ReachyMiniController: playAttentive2Loop - not looping anymore`);
            return;
        }

        const daemon = this.daemonInterface as any;

        try {
            // Play the move
            if (daemon.playRecordedMove) {
                print(`ReachyMiniController: Calling playRecordedMove for ${this.ATTENTIVE2_MOVE_NAME}`);
                this.attentive2MoveUuid = await daemon.playRecordedMove(this.ATTENTIVE2_DATASET_NAME, this.ATTENTIVE2_MOVE_NAME);
                print(`ReachyMiniController: playRecordedMove returned UUID: ${this.attentive2MoveUuid}`);
                this.lastMoveCheckTime = getTime();
                this.moveStartTime = getTime();
            } else {
                print(`ReachyMiniController: ERROR - playRecordedMove method not found! Available methods: ${Object.keys(daemon).join(', ')}`);
            }
        } catch (error) {
            print(`ReachyMiniController: EXCEPTION in playRecordedMove: ${error}`);
            // Don't stop looping on error - try again after timeout
            this.moveStartTime = getTime();
        }
    }

    /**
     * Check move completion in update loop and restart if needed
     */
    private async checkMoveCompletion(): Promise<void> {
        if (!this.isAttentive2Looping || !this.attentive2MoveUuid || !this.daemonInterface) {
            return;
        }

        const currentTime = getTime();
        if (currentTime - this.lastMoveCheckTime < this.moveCheckInterval) {
            return; // Throttle checks
        }
        this.lastMoveCheckTime = currentTime;

        const daemon = this.daemonInterface as any;
        
        // Check if move is still running
        try {
            if (daemon.getRunningMoves) {
                const runningMoves = await daemon.getRunningMoves();
                const isStillRunning = runningMoves && runningMoves.some((move: any) => move.uuid === this.attentive2MoveUuid);
                
                if (!isStillRunning && this.isAttentive2Looping) {
                    // Move completed, restart it
                    await this.playAttentive2Loop();
                }
            } else {
                // Fallback: restart after estimated duration (assuming ~5 seconds for emotion)
                // Use a simple time-based check from move start
                if (currentTime - this.moveStartTime >= 5.0) {
                    if (this.isAttentive2Looping) {
                        await this.playAttentive2Loop();
                    }
                }
            }
        } catch (error) {
            // On error, try restarting after estimated duration
            if (currentTime - this.moveStartTime >= 5.0) {
                if (this.isAttentive2Looping) {
                    await this.playAttentive2Loop();
                }
            }
        }
    }

    /**
     * Stop the attentive_2 loop
     */
    private stopAttentive2Loop(): void {
        this.isAttentive2Looping = false;
        if (this.attentive2MoveUuid && this.daemonInterface) {
            const daemon = this.daemonInterface as any;
            if (daemon.stopMove) {
                daemon.stopMove(this.attentive2MoveUuid).catch((error: any) => {
                    print(`ReachyMiniController: Error stopping ${this.ATTENTIVE2_MOVE_NAME}: ${error}`);
                });
            }
        }
        this.attentive2MoveUuid = null;
        
        // Clean up update event if no longer needed
        if (this.idleUpdateEvent && this.currentState !== RobotState.Idle) {
            this.removeEvent(this.idleUpdateEvent);
            this.idleUpdateEvent = null;
        }
    }

    /**
     * Start look-at tracking update loop
     */
    private startLookAtTracking(): void {
        if (this.lookAtUpdateEvent) {
            return; // Already tracking
        }

        // Reset tracking state to neutral when starting
        this.headYaw = 0;
        this.headPitch = 0;
        this.headRoll = 0;
        this.bodyYaw = 0;
        this.leftAntenna = 0;
        this.rightAntenna = 0;
        this.trackingStartTime = getTime();
        this.motionIntensity = 0;
        this.lastHeadYaw = 0;
        this.lastHeadPitch = 0;

        this.lookAtUpdateEvent = this.createEvent("UpdateEvent");
        this.lookAtUpdateEvent.bind(() => {
            if (this.currentState === RobotState.LookAtTarget) {
                this.updateLookAtTarget();
            }
        });
    }

    /**
     * Stop look-at tracking update loop
     */
    private stopLookAtTracking(): void {
        if (this.lookAtUpdateEvent) {
            this.removeEvent(this.lookAtUpdateEvent);
            this.lookAtUpdateEvent = null;
        }
    }

    /**
     * Update look-at target (called every frame)
     * Computes desired angles, smoothly interpolates head, body follows with inertia
     * Adds character through temporally consistent wobble and antenna movement
     */
    private updateLookAtTarget(): void {
        if (!this.daemonInterface || !this.roundButton || !this.controlledEntity) {
            return;
        }

        const daemon = this.daemonInterface as any;
        if (!daemon.setTarget) {
            return;
        }

        // Time for temporally consistent randomness
        const t = getTime() - this.trackingStartTime;

        // Compute desired yaw and pitch to look at target
        const desiredAngles = this.computeDesiredAngles();
        
        // Smoothly interpolate head towards desired angles with dampening for drastic changes
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
        
        // Compute motion intensity from velocity (how fast head is moving)
        const headVelocity = Math.sqrt(
            Math.pow(this.headYaw - this.lastHeadYaw, 2) +
            Math.pow(this.headPitch - this.lastHeadPitch, 2)
        );
        // Normalize velocity to 0-1 range (max ~5 degrees per frame = full intensity)
        const targetIntensity = this.clamp(headVelocity / (5 * Math.PI / 180), 0, 1);
        this.motionIntensity += (targetIntensity - this.motionIntensity) * this.MOTION_INTENSITY_SMOOTHING;
        
        // Store for next frame velocity calculation
        this.lastHeadYaw = this.headYaw;
        this.lastHeadPitch = this.headPitch;
        
        // Compute wobble for character - always added on top of all movements
        const pitchWobble = this.computeWobble(t, this.PITCH_WOBBLE_AMPLITUDE, 1.0, 0);
        const yawWobble = this.computeWobble(t, this.YAW_WOBBLE_AMPLITUDE, 0.7, 1.5);
        const rollWobble = this.computeWobble(t, this.ROLL_WOBBLE_AMPLITUDE, 0.35, 3.0);
        
        // Update roll for head tilt character
        this.headRoll = rollWobble;
        
        // Clamp head pitch to mechanical limits
        this.headPitch = this.clamp(this.headPitch, this.MIN_PITCH, this.MAX_PITCH);
        
        // Body follows head - starts moving earlier for tighter coordination
        const relativeYaw = this.headYaw - this.bodyYaw;
        
        // Body always follows head with some lag, but accelerates when difference is large
        const followStrength = Math.abs(relativeYaw) > this.MAX_HEAD_YAW * 0.5
            ? this.BODY_SMOOTHING * 2  // Faster when getting far
            : this.BODY_SMOOTHING;     // Normal drift
        
        // If relative yaw exceeds max, body must catch up urgently
        if (Math.abs(relativeYaw) > this.MAX_HEAD_YAW) {
            const excess = Math.abs(relativeYaw) - this.MAX_HEAD_YAW;
            const bodyDelta = this.dampenChange(
                Math.sign(relativeYaw) * excess * this.BODY_SMOOTHING * 8,
                this.MAX_YAW_CHANGE_PER_FRAME
            );
            this.bodyYaw += bodyDelta;
        } else {
            // Progressive follow - body always moves towards head
            this.bodyYaw += relativeYaw * followStrength;
        }
        
        // Clamp body yaw to mechanical limits
        this.bodyYaw = this.clamp(this.bodyYaw, -this.MAX_BODY_YAW, this.MAX_BODY_YAW);
        
        // Clamp total head yaw
        const maxTotalYaw = this.MAX_BODY_YAW + this.MAX_HEAD_YAW;
        this.headYaw = this.clamp(this.headYaw, -maxTotalYaw, maxTotalYaw);
        
        // Compute antenna positions - adapt to motion intensity
        // More motion = more antenna activity
        const antennaAmplitude = this.ANTENNA_BASE_AMPLITUDE + 
            this.motionIntensity * this.ANTENNA_MOTION_AMPLITUDE;
        
        // Smooth wobble for antennas with motion-adaptive amplitude
        const leftAntennaWobble = this.computeWobble(t, antennaAmplitude, 0.8, 0.5);
        const rightAntennaWobble = this.computeWobble(t, antennaAmplitude, 0.6, 2.5);
        
        // Add correlation with head yaw (antennas react to looking direction)
        const desiredLeftAntenna = leftAntennaWobble + this.headYaw * 0.2;
        const desiredRightAntenna = rightAntennaWobble - this.headYaw * 0.2;
        
        // Smooth antenna movement with dampening to prevent jitter
        const leftDelta = this.dampenChange(
            (desiredLeftAntenna - this.leftAntenna) * this.ANTENNA_SMOOTHING,
            this.MAX_ANTENNA_CHANGE_PER_FRAME
        );
        const rightDelta = this.dampenChange(
            (desiredRightAntenna - this.rightAntenna) * this.ANTENNA_SMOOTHING,
            this.MAX_ANTENNA_CHANGE_PER_FRAME
        );
        
        this.leftAntenna += leftDelta;
        this.rightAntenna += rightDelta;
        
        // Clamp antennas
        this.leftAntenna = this.clamp(this.leftAntenna, -this.MAX_ANTENNA, this.MAX_ANTENNA);
        this.rightAntenna = this.clamp(this.rightAntenna, -this.MAX_ANTENNA, this.MAX_ANTENNA);

        // Send to robot via setTarget with wobble always applied on top
        this.sendTargetPose(daemon, pitchWobble, yawWobble);
    }
    
    /**
     * Compute temporally consistent wobble using layered sin waves
     */
    private computeWobble(t: number, amplitude: number, speedMultiplier: number, phaseOffset: number): number {
        const speed = this.WOBBLE_SPEED * speedMultiplier;
        // Layer multiple frequencies for organic feel
        return amplitude * (
            0.5 * Math.sin(speed * t + phaseOffset) +
            0.3 * Math.sin(speed * 1.7 * t + phaseOffset * 0.7) +
            0.2 * Math.sin(speed * 2.3 * t + phaseOffset * 1.3)
        );
    }
    
    /**
     * Dampen a change to prevent sudden jumps
     */
    private dampenChange(delta: number, maxDelta: number): number {
        return this.clamp(delta, -maxDelta, maxDelta);
    }

    /**
     * Compute desired yaw and pitch angles to look at target from root position
     */
    private computeDesiredAngles(): { yaw: number; pitch: number } {
        // Get world positions
        const rootTransform = this.roundButton.getSceneObject().getTransform();
        const rootWorldPos = rootTransform.getWorldPosition();
        const rootWorldRot = rootTransform.getWorldRotation();
        const rootOffsetWorld = rootWorldRot.multiplyVec3(this.entityOffset);
        const centerPos = rootWorldPos.add(rootOffsetWorld);

        const targetTransform = this.controlledEntity.getTransform();
        const targetPos = targetTransform.getWorldPosition();

        // Calculate direction from center to target
        const direction = targetPos.sub(centerPos);
        const horizontalDist = Math.sqrt(direction.x * direction.x + direction.z * direction.z);

        if (horizontalDist < 0.001) {
            // Target directly above/below, maintain current yaw
            return { yaw: this.headYaw, pitch: direction.y > 0 ? this.MAX_PITCH : this.MIN_PITCH };
        }

        // Yaw: horizontal angle (atan2 of x/z gives angle from forward direction)
        const yaw = Math.atan2(direction.x, direction.z);
        
        // Pitch: vertical angle (negative because looking down = negative pitch)
        const pitch = -Math.atan2(direction.y, horizontalDist);

        return { yaw, pitch };
    }

    /**
     * Send current head/body pose to robot (fire-and-forget)
     */
    private sendTargetPose(daemon: any, pitchWobble: number = 0, yawWobble: number = 0): void {
        // Apply wobble to add character
        const finalPitch = this.clamp(
            this.headPitch + pitchWobble,
            this.MIN_PITCH,
            this.MAX_PITCH
        );
        const finalYaw = this.headYaw + yawWobble;
        const finalRoll = this.clamp(this.headRoll, -this.MAX_ROLL, this.MAX_ROLL);
        
        // Head yaw is the total yaw (includes body rotation + relative rotation)
        // The robot's IK expects head pose in world frame
        const headPose: XYZRPYPose = {
            x: 0,
            y: 0,
            z: 0,
            roll: finalRoll,
            pitch: finalPitch,
            yaw: finalYaw
        };
        
        // Antennas: [right, left] in radians
        const antennas: [number, number] = [this.rightAntenna, this.leftAntenna];

        // Fire-and-forget: don't await, just catch errors silently
        daemon.setTarget(headPose, this.bodyYaw, antennas).catch(() => {
            // Silently ignore errors to avoid log spam at 60fps
        });
    }

    // -----------------------------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------------------------

    /** Clamp a value between min and max */
    private clamp(val: number, min: number, max: number): number {
        return Math.max(min, Math.min(max, val));
    }

    /** Linearly interpolate between two vec3 values */
    private lerpVec3(start: vec3, end: vec3, t: number): vec3 {
        return new vec3(
            start.x + (end.x - start.x) * t,
            start.y + (end.y - start.y) * t,
            start.z + (end.z - start.z) * t
        );
    }

    /** Cancel and cleanup an animation if running */
    private cancelCurrentAnimation(): void {
        if (this.currentAnimation !== null) {
            this.currentAnimation();
            this.currentAnimation = null;
        }
    }

    /** Animate the look-at entity in/out with scale and position */
    private async animateLookAtEntity(show: boolean): Promise<void> {
        if (!this.controlledEntity) {
            return;
        }

        this.cancelCurrentAnimation();

        const transform = this.controlledEntity.getTransform();
        const startScale = show ? new vec3(0, 0, 0) : transform.getLocalScale();
        const targetScale = show ? new vec3(0.3, 0.3, 0.3) : new vec3(0, 0, 0);
        const startPos = transform.getLocalPosition();
        const targetPos = this.entityOffset;

        if (show) {
            this.controlledEntity.enabled = true;
        }

        await new Promise<void>((resolve) => {
            this.currentAnimation = animate({
                duration: 1.0,
                easing: "ease-in-out-quad",
                update: (t: number) => {
                    transform.setLocalScale(this.lerpVec3(startScale, targetScale, t));
                    transform.setLocalPosition(this.lerpVec3(startPos, targetPos, t));
                },
                ended: () => {
                    if (!show) this.controlledEntity.enabled = false;
                    resolve();
                },
                cancelled: () => {
                    if (!show) this.controlledEntity.enabled = false;
                    resolve();
                }
            });
        }).finally(() => {
            this.currentAnimation = null;
        });
    }
}
