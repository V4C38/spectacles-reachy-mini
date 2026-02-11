import { Switch } from "SpectaclesUIKit.lspkg/Scripts/Components/Switch/Switch";

import { ToolDefinition, LLMService } from "./LLMService";
import { AssistantMode, AssistantState } from "../AssistantMode";
import { HardwareAdapter } from "../HardwareAdapter";
import { MLObjectDetector } from "./MLObjectDetector";
import { RobotDriver } from "../RobotDriver";
import { getObjectLinkRenderer } from "./ObjectLinkRenderer";

/**
 * Component that provides LLM tools for the AssistantMode.
 * Add this component to a scene object and configure the required inputs.
 * Tools will only be registered if their dependencies are available.
 */
@component
export class AssistantTools extends BaseScriptComponent {

    // --- Required References ---
    @input
    public assistantMode: AssistantMode | null = null;
    @input
    public mlDetector: MLObjectDetector | null = null;
    @input
    public robotDriver: RobotDriver | null = null;
    @input
    public objectMarkerPrefab: ObjectPrefab | null = null;
    @input
    public lineRendererPrefab: ObjectPrefab | null = null;
    @input
    private hardwareAdapter: HardwareAdapter | null = null;

    @input
    private switchObjectDetectionTool: Switch | null = null;

    // --- State ---
    private isScanning: boolean = false;

    @input
    private textDebugInfo: Text | null = null;

    private logDebug(message: string): void {
        if (this.textDebugInfo) {
            this.textDebugInfo.text = message;
        }
    }

    /**
     * Registers all available tools with the provided LLM service.
     * Only tools whose dependencies are available will be registered.
     */
    public registerTools(llmService: LLMService): void {
        if (!llmService) {
            print("AssistantTools: LLMService not provided, skipping tool registration");
            return;
        }

        llmService.clearTools();
        let registeredCount = 0;

        // Register scan_objects tool if dependencies are available
        if (this.mlDetector && this.objectMarkerPrefab && this.assistantMode) {

            if (this.switchObjectDetectionTool && this.switchObjectDetectionTool.isOn) {
                llmService.registerTool(this.createScanObjectsTool());
                registeredCount++;
            }
            else {
                print("AssistantTools: Skipping scan_objects tool (object detection tool is off)");
            }
        } else {
            print("AssistantTools: Skipping scan_objects tool (missing dependencies)");
        }

        // Register look_at_location tool if dependencies are available
        if (this.robotDriver && this.assistantMode) {
            llmService.registerTool(this.createLookAtLocationTool());
            registeredCount++;
        } else {
            print("AssistantTools: Skipping look_at_location tool (missing dependencies)");
        }

        // Register get_state tool if dependencies are available
        if (this.robotDriver) {
            llmService.registerTool(this.createGetStateTool());
            registeredCount++;
        } else {
            print("AssistantTools: Skipping get_state tool (missing dependencies)");
        }

        // Register look_direction tool if dependencies are available
        if (this.robotDriver && this.assistantMode) {
            llmService.registerTool(this.createLookDirectionTool());
            registeredCount++;
        } else {
            print("AssistantTools: Skipping look_direction tool (missing dependencies)");
        }

        // Register play_animation and get_available_animations whenever robot is available (hardware or simulation)
        if (this.robotDriver) {
            llmService.registerTool(this.createPlayAnimationTool());
            llmService.registerTool(this.createGetAvailableAnimationsTool());
            registeredCount += 2;
        } else {
            print("AssistantTools: Skipping play_animation and get_available_animations (missing robotDriver)");
        }

        // Register draw_line tool (requires line renderer prefab)
        if (this.lineRendererPrefab) {
            llmService.registerTool(this.createDrawLineTool());
            registeredCount++;
        }
        else {
            print("AssistantTools: Skipping draw_line tool (missing lineRendererPrefab or draw line tool is off)");
        }

        // Register take_picture_robotview only when not in simulation mode (robot has real camera)
        if (this.robotDriver && this.hardwareAdapter && this.assistantMode && !this.robotDriver.getIsSimulationMode()) {
            llmService.registerTool(this.createTakePictureRobotViewTool());
            registeredCount++;
        } else if (this.robotDriver && this.robotDriver.getIsSimulationMode()) {
            print("AssistantTools: Skipping take_picture_robotview (simulation mode is on)");
        } else {
            print("AssistantTools: Skipping take_picture_robotview (missing robotDriver, hardwareAdapter, or assistantMode)");
        }

        print(`AssistantTools: Registered ${registeredCount} tools`);
    }

    // ================================================================
    // Tool Definitions
    // ================================================================


    /* ----------------------------------------------------------------
     * Scan the user's surroundings for objects matching a description.
     * ----------------------------------------------------------------
    */
    private createScanObjectsTool(): ToolDefinition {
        return {
            name: "scan_objects",
            description: "Scan the user's surroundings for objects matching a description. When the user asks to find or locate something (e.g. 'find my phone', 'help me find my glasses'), use ONE scan_objects call; when it returns, call look_at_location with the object's coordinates and draw_line true to point at it, then reply briefly (e.g. 'Yes, I found it! It\'s right there!'). For multiple objects, use one prompt listing all (e.g. 'phone and glasses'). If the user only asked what objects are visible (generic list), do not draw a line.",
            parameters: {
                type: "object",
                properties: {
                    prompt: {
                        type: "string",
                        description: "What to look for: one or more object types in a single phrase (e.g. 'phone', 'phone and glasses', 'cups and bottles'). For multiple requested objects, include all in one prompt."
                    }
                },
                required: ["prompt"]
            },
            handler: async (args: { prompt: string }): Promise<string> => {
                this.assistantMode.setState(AssistantState.Searching);
                try {
                    await this.triggerScan(args.prompt);
                    const objects = this.mlDetector.getTrackedObjectSummaries();
                    return JSON.stringify({ count: objects.length, objects: objects });
                } catch (error) {
                    this.logDebug(`Agent - Error: Scan failed: ${error}`);
                    return JSON.stringify({ error: `Scan failed: ${error}` });
                } finally {
                    if (this.assistantMode.getState() === AssistantState.Searching) {
                        this.assistantMode.setState(AssistantState.Listening);
                    }
                }
            }
        };
    }


    private async triggerScan(prompt: string): Promise<void> {
        if (this.isScanning) return;
        if (!prompt || prompt.trim().length === 0) {
            throw new Error("AssistantTools: prompt is required");
        }

        this.isScanning = true;

        try {
            await this.mlDetector.requestObjectDetection(prompt, this.objectMarkerPrefab);
        } catch (error) {
            print(`AssistantTools: Scan failed: ${error}`);
            throw error;
        } finally {
            this.isScanning = false;
        }
    }

    public clearAllMarkers(): void {
        if (this.mlDetector) this.mlDetector.clearAllDetections();
    }

    public getIsScanning(): boolean {
        return this.isScanning;
    }

    public getTrackedObjectCount(): number {
        return this.mlDetector ? this.mlDetector.getTrackedObjectNames().length : 0;
    }


    /* ----------------------------------------------------------------
     * Look at a specific location in the world.
     * ----------------------------------------------------------------
    */
    private createLookAtLocationTool(): ToolDefinition {
        return {
            name: "look_at_location",
            description: "Make Reachy look at a world-space position for a given duration. By default no line is drawn; set draw_line to true when helping the user find or locate an object (e.g. after scan_objects) so you point at it with a visible line. The robot will hold its gaze for the specified duration before resuming normal behavior.",
            parameters: {
                type: "object",
                properties: {
                    x: { type: "number", description: "World X coordinate to look at" },
                    y: { type: "number", description: "World Y coordinate to look at" },
                    z: { type: "number", description: "World Z coordinate to look at" },
                    duration: { type: "number", description: "How long to look at the location in seconds (default: 4)" },
                    draw_line: { type: "boolean", description: "Whether to draw a visible line from the robot to the target (default: false)" }
                },
                required: ["x", "y", "z"]
            },
            handler: async (args: { x: number; y: number; z: number; duration?: number; draw_line?: boolean }): Promise<string> => {
                const dur = args.duration ?? 4;
                const shouldDrawLine = args.draw_line === true;
                const target = new vec3(args.x, args.y, args.z);

                this.assistantMode.lookAtOverrideTarget = target;
                this.assistantMode.lookAtOverrideEndTime = getTime() + dur;

                // Automatically draw a line from robot head to target
                if (shouldDrawLine && this.robotDriver && this.lineRendererPrefab) {
                    const headPos = this.robotDriver.getHeadWorldPosition();
                    this.showTemporaryLine(headPos, target, dur);
                }

                return JSON.stringify({ success: true, looked_at: { x: args.x, y: args.y, z: args.z }, duration: dur, line_drawn: shouldDrawLine });
            }
        };
    }


    /* ----------------------------------------------------------------
     * Get the robot's current world position and orientation.
     * ----------------------------------------------------------------
    */
    private createGetStateTool(): ToolDefinition {
        return {
            name: "get_state",
            description: "Get the robot's current world position and orientation. Returns the head world position, current head angles (yaw, pitch, roll in radians), body yaw, and base rotation. Use this to understand your spatial context. For relative direction commands (look left, right, etc.) prefer using look_direction instead.",
            parameters: {
                type: "object",
                properties: {},
                required: []
            },
            handler: async (): Promise<string> => {
                if (!this.robotDriver) {
                    return JSON.stringify({ error: "RobotDriver not initialized" });
                }
                
                const headPos = this.robotDriver.getHeadWorldPosition();
                const headAngles = this.robotDriver.getHeadAngles();
                const bodyYaw = this.robotDriver.getBodyYaw();
                const baseRotation = this.robotDriver.getBaseRotation();
                
                // Convert base quaternion to euler angles for easier interpretation
                let baseEuler = null;
                if (baseRotation) {
                    baseEuler = baseRotation.toEulerAngles();
                }
                
                return JSON.stringify({
                    position: { x: headPos.x, y: headPos.y, z: headPos.z },
                    head: {
                        yaw: headAngles.yaw,
                        pitch: headAngles.pitch,
                        roll: headAngles.roll
                    },
                    body: {
                        yaw: bodyYaw
                    },
                    base: baseEuler ? {
                        x: baseEuler.x,
                        y: baseEuler.y,
                        z: baseEuler.z
                    } : null
                });
            }
        };
    }


    /* ----------------------------------------------------------------
     * Look in a direction relative to the robot's current orientation.
     * ----------------------------------------------------------------
    */
    private createLookDirectionTool(): ToolDefinition {
        return {
            name: "look_direction",
            description: "Make Reachy look in a direction relative to its current orientation. Use this when the user says things like 'look left', 'look up', 'look behind you', etc. The math is handled internally — just provide the direction name.",
            parameters: {
                type: "object",
                properties: {
                    direction: {
                        type: "string",
                        description: "The relative direction to look: 'left', 'right', 'up', 'down', or 'behind'"
                    },
                    amount_degrees: {
                        type: "number",
                        description: "How far to turn in degrees (default: 45 for horizontal, 20 for vertical)"
                    },
                    duration: {
                        type: "number",
                        description: "How long to hold the gaze in seconds (default: 4)"
                    }
                },
                required: ["direction"]
            },
            handler: async (args: { direction: string; amount_degrees?: number; duration?: number }): Promise<string> => {
                if (!this.robotDriver || !this.assistantMode) {
                    return JSON.stringify({ error: "RobotDriver or AssistantMode not initialized" });
                }

                const dir = args.direction.toLowerCase().trim();
                const dur = args.duration ?? 4;
                const headPos = this.robotDriver.getHeadWorldPosition();
                const baseRotation = this.robotDriver.getBaseRotation();

                // Derive the robot's forward and right vectors from base rotation
                // Default forward is (0, 0, 1) in local space
                let forward: vec3;
                let right: vec3;
                const up = new vec3(0, 1, 0);

                if (baseRotation) {
                    forward = baseRotation.multiplyVec3(new vec3(0, 0, 1));
                    right = baseRotation.multiplyVec3(new vec3(1, 0, 0));
                } else {
                    forward = new vec3(0, 0, 1);
                    right = new vec3(1, 0, 0);
                }

                // Also factor in the current body yaw rotation
                const bodyYaw = this.robotDriver.getBodyYaw();
                const cosY = Math.cos(bodyYaw);
                const sinY = Math.sin(bodyYaw);
                const rotatedForward = new vec3(
                    forward.x * cosY + forward.z * sinY,
                    forward.y,
                    -forward.x * sinY + forward.z * cosY
                );
                const rotatedRight = new vec3(
                    right.x * cosY + right.z * sinY,
                    right.y,
                    -right.x * sinY + right.z * cosY
                );

                const LOOK_DISTANCE = 200;
                let target: vec3;

                switch (dir) {
                    case "left": {
                        const amountRad = (args.amount_degrees ?? 45) * Math.PI / 180;
                        const cosA = Math.cos(amountRad);
                        const sinA = Math.sin(amountRad);
                        // Rotate forward vector left (negative right) by amount
                        const lookDir = new vec3(
                            rotatedForward.x * cosA - rotatedRight.x * sinA,
                            rotatedForward.y,
                            rotatedForward.z * cosA - rotatedRight.z * sinA
                        );
                        target = headPos.add(lookDir.normalize().uniformScale(LOOK_DISTANCE));
                        break;
                    }
                    case "right": {
                        const amountRad = (args.amount_degrees ?? 45) * Math.PI / 180;
                        const cosA = Math.cos(amountRad);
                        const sinA = Math.sin(amountRad);
                        // Rotate forward vector right (positive right) by amount
                        const lookDir = new vec3(
                            rotatedForward.x * cosA + rotatedRight.x * sinA,
                            rotatedForward.y,
                            rotatedForward.z * cosA + rotatedRight.z * sinA
                        );
                        target = headPos.add(lookDir.normalize().uniformScale(LOOK_DISTANCE));
                        break;
                    }
                    case "up": {
                        const amountRad = (args.amount_degrees ?? 20) * Math.PI / 180;
                        const cosA = Math.cos(amountRad);
                        const sinA = Math.sin(amountRad);
                        // Tilt forward vector upward
                        const lookDir = new vec3(
                            rotatedForward.x * cosA,
                            rotatedForward.y * cosA + sinA,
                            rotatedForward.z * cosA
                        );
                        target = headPos.add(lookDir.normalize().uniformScale(LOOK_DISTANCE));
                        break;
                    }
                    case "down": {
                        const amountRad = (args.amount_degrees ?? 20) * Math.PI / 180;
                        const cosA = Math.cos(amountRad);
                        const sinA = Math.sin(amountRad);
                        // Tilt forward vector downward
                        const lookDir = new vec3(
                            rotatedForward.x * cosA,
                            rotatedForward.y * cosA - sinA,
                            rotatedForward.z * cosA
                        );
                        target = headPos.add(lookDir.normalize().uniformScale(LOOK_DISTANCE));
                        break;
                    }
                    case "behind": {
                        // Look opposite to forward direction
                        const lookDir = rotatedForward.uniformScale(-1);
                        target = headPos.add(lookDir.normalize().uniformScale(LOOK_DISTANCE));
                        break;
                    }
                    default:
                        return JSON.stringify({ error: `Unknown direction: '${dir}'. Use 'left', 'right', 'up', 'down', or 'behind'.` });
                }

                this.assistantMode.lookAtOverrideTarget = target;
                this.assistantMode.lookAtOverrideEndTime = getTime() + dur;

                return JSON.stringify({
                    success: true,
                    direction: dir,
                    looked_at: { x: target.x, y: target.y, z: target.z },
                    duration: dur
                });
            }
        };
    }

    /* ----------------------------------------------------------------
     * Play a named animation on Reachy Mini (fire-and-forget).
     * ----------------------------------------------------------------
    */
    private createPlayAnimationTool(): ToolDefinition {
        return {
            name: "play_animation",
            description: "Play a named animation on Reachy Mini (fire-and-forget). Motion and audio play in sync; the animation runs in the background so you can respond with speech at the same time. Use this whenever it fits the conversation—when the user says hello (greeting), goodbye (goodbye), asks you to wave, nod, look happy/sad/excited, think, sway, peekaboo, or dance. Main options: greeting, goodbye, happy, nod, wave, sway, peekaboo, sad, excited, thinking, dance. Call get_available_animations only when the user explicitly asks what animations are available.",
            parameters: {
                type: "object",
                properties: {
                    animationName: {
                        type: "string",
                        description: "Name of the animation to play (e.g. greeting, goodbye, happy, nod, wave, sway, peekaboo, sad, excited, thinking, dance)"
                    }
                },
                required: ["animationName"]
            },
            handler: async (args: { animationName: string }): Promise<string> => {
                if (!this.robotDriver) {
                    return JSON.stringify({ error: "RobotDriver not initialized" });
                }
                const name = (args.animationName || "").trim();
                if (!name) {
                    return JSON.stringify({ error: "animationName is required" });
                }
                this.robotDriver.playAnimation(name).catch((error) => {
                    print(`AssistantTools: play_animation failed: ${error}`);
                    this.logDebug(`Agent - Error: play_animation failed: ${error}`);
                });
                return JSON.stringify({ success: true, animation: name });
            }
        };
    }

    /* ----------------------------------------------------------------
     * Get the list of animation names that Reachy Mini can play.
     * ----------------------------------------------------------------
    */
    private createGetAvailableAnimationsTool(): ToolDefinition {
        return {
            name: "get_available_animations",
            description: "Get the list of animation names that Reachy Mini can play. Call this when the user asks what animations are available or whether the robot can play a specific animation.",
            parameters: {
                type: "object",
                properties: {},
                required: []
            },
            handler: async (): Promise<string> => {
                if (!this.robotDriver) {
                    return JSON.stringify({ error: "RobotDriver not initialized", names: [] });
                }
                try {
                    const names = await this.robotDriver.getAvailableAnimations();
                    return JSON.stringify({ names });
                } catch (error) {
                    const msg = error instanceof Error ? error.message : String(error);
                    return JSON.stringify({ error: msg, names: [] });
                }
            }
        };
    }


    /* ----------------------------------------------------------------
     * Draw a temporary curved line.
     * ----------------------------------------------------------------
    */
    private createDrawLineTool(): ToolDefinition {
        return {
            name: "draw_line",
            description: "Draw a temporary curved line. Start defaults to the robot's head position; omit start to draw from the robot. End is required. Duration in seconds (default: 10). Useful for pointing at objects or showing spatial relationships.",
            parameters: {
                type: "object",
                properties: {
                    start_x: { type: "number", description: "Start position X in world space (omit to use robot head)" },
                    start_y: { type: "number", description: "Start position Y in world space (omit to use robot head)" },
                    start_z: { type: "number", description: "Start position Z in world space (omit to use robot head)" },
                    end_x: { type: "number", description: "End position X coordinate in world space" },
                    end_y: { type: "number", description: "End position Y coordinate in world space" },
                    end_z: { type: "number", description: "End position Z coordinate in world space" },
                    duration: { type: "number", description: "How long to display the line in seconds (default: 10)" }
                },
                required: ["end_x", "end_y", "end_z"]
            },
            handler: async (args: {
                start_x?: number;
                start_y?: number;
                start_z?: number;
                end_x: number;
                end_y: number;
                end_z: number;
                duration?: number;
            }): Promise<string> => {
                try {
                    if (!this.lineRendererPrefab) {
                        return JSON.stringify({ error: "Line renderer prefab not configured" });
                    }
                    const hasStart = args.start_x !== undefined && args.start_y !== undefined && args.start_z !== undefined;
                    const start = hasStart
                        ? new vec3(args.start_x!, args.start_y!, args.start_z!)
                        : (this.robotDriver ? this.robotDriver.getHeadWorldPosition() : new vec3(0, 0, 0));
                    if (!hasStart && !this.robotDriver) {
                        return JSON.stringify({ error: "draw_line: omit start only when robotDriver is available" });
                    }
                    const end = new vec3(args.end_x, args.end_y, args.end_z);
                    const duration = args.duration ?? 10;
                    this.showTemporaryLine(start, end, duration);
                    return JSON.stringify({
                        success: true,
                        from: { x: start.x, y: start.y, z: start.z },
                        to: { x: end.x, y: end.y, z: end.z },
                        duration: duration
                    });
                } catch (error) {
                    return JSON.stringify({ error: `Failed to draw line: ${error}` });
                }
            }
        };
    }

    /* ----------------------------------------------------------------
     * Take picture from robot's onboard camera.
     * ----------------------------------------------------------------
    */
    private createTakePictureRobotViewTool(): ToolDefinition {
        return {
            name: "take_picture_robotview",
            description: "Capture an image from Reachy Mini's onboard camera (the robot's perspective). Use when the user wants to see what the robot sees or to aim the robot's head at a location before taking a picture. Optionally provide aim_at_x, aim_at_y, aim_at_z (world coordinates) to point the robot's head at a location first; the capture happens after a short settle delay. Returns camera position, look direction, and aimed_at (if used) so you know where the shot was taken from and what it was looking at.",
            parameters: {
                type: "object",
                properties: {
                    aim_at_x: { type: "number", description: "World X to look at before capture (optional)" },
                    aim_at_y: { type: "number", description: "World Y to look at before capture (optional)" },
                    aim_at_z: { type: "number", description: "World Z to look at before capture (optional)" },
                },
                required: [],
            },
            handler: async (args: { aim_at_x?: number; aim_at_y?: number; aim_at_z?: number }): Promise<string> => {
                if (!this.hardwareAdapter || !this.robotDriver || !this.assistantMode) {
                    return JSON.stringify({ success: false, error: "Robot or hardware adapter not configured" });
                }
                const hasAim = args.aim_at_x !== undefined && args.aim_at_y !== undefined && args.aim_at_z !== undefined;
                let aimedAt: { x: number; y: number; z: number } | undefined;
                if (hasAim) {
                    const target = new vec3(args.aim_at_x!, args.aim_at_y!, args.aim_at_z!);
                    this.assistantMode.lookAtOverrideTarget = target;
                    this.assistantMode.lookAtOverrideEndTime = getTime() + 1.0;
                    aimedAt = { x: target.x, y: target.y, z: target.z };
                    await new Promise<void>((resolve) => {
                        const ev = this.createEvent("DelayedCallbackEvent") as DelayedCallbackEvent;
                        ev.bind(() => resolve());
                        ev.reset(0.9);
                    });
                }
                try {
                    const imageBase64 = await this.hardwareAdapter.getRobotCameraFrame();
                    const headPos = this.robotDriver.getHeadWorldPosition();
                    const headAngles = this.robotDriver.getHeadAngles();
                    const result: Record<string, any> = {
                        success: true,
                        image_base64: imageBase64,
                        mime: "image/jpeg",
                        source: "robot_camera",
                        camera_position: { x: headPos.x, y: headPos.y, z: headPos.z },
                        look_direction: { yaw: headAngles.yaw, pitch: headAngles.pitch },
                    };
                    if (aimedAt) result.aimed_at = aimedAt;
                    return JSON.stringify(result);
                } catch (error) {
                    const msg = error instanceof Error ? error.message : String(error);
                    return JSON.stringify({ success: false, error: msg });
                }
            },
        };
    }

    /* ----------------------------------------------------------------
     * Show a temporary curved line between two world positions (world-space).
     * Spawns the line, shows it, then after duration destroys it.
     * ----------------------------------------------------------------
    */
    private showTemporaryLine(start: vec3, end: vec3, duration: number): void {
        if (!this.lineRendererPrefab) return;

        const lineObj = this.lineRendererPrefab.instantiate(null);
        lineObj.getTransform().setWorldPosition(start);

        const renderer = getObjectLinkRenderer(lineObj);
        if (!renderer) {
            print("AssistantTools: Line prefab has no ObjectLinkRenderer, destroying");
            lineObj.destroy();
            return;
        }

        renderer.setLineAndAppear(start, end);

        const delayEvent = this.createEvent("DelayedCallbackEvent") as DelayedCallbackEvent;
        delayEvent.bind(() => {
            renderer.destroy();
        });
        delayEvent.reset(duration);
    }
}
