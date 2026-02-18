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

    /** Round coordinate to two decimal places (1 unit = 1 cm). Use in tool I/O for consistent formatting. */
    private roundCoord(v: number): number {
        return Math.round(v * 100) / 100;
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

        // Register look_at tool if dependencies are available (replaces look_at_location + look_direction)
        if (this.robotDriver && this.assistantMode) {
            llmService.registerTool(this.createLookAtTool());
            registeredCount++;
        } else {
            print("AssistantTools: Skipping look_at tool (missing dependencies)");
        }

        // Register get_state tool if dependencies are available
        if (this.robotDriver) {
            llmService.registerTool(this.createGetStateTool());
            registeredCount++;
        } else {
            print("AssistantTools: Skipping get_state tool (missing dependencies)");
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
            description: "Scan the user's surroundings for objects matching a description. When the user asks to find or locate something, use ONE scan_objects call; when it returns, call look_at with the object's coordinates (x, y, z; two decimal places, 1 unit = 1 cm) and draw_line true to point at it. When replying to the user, never mention coordinates. Use relative, natural language only: e.g. 'It\'s right in front of you', 'Slightly to your left', 'Right there!', 'Behind you'. For multiple objects, use one prompt listing all (e.g. 'phone and glasses'). If the user only asked what objects are visible (generic list), do not draw a line.",
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
                    const raw = this.mlDetector.getTrackedObjectSummaries();
                    const objects = raw.map((o) => ({
                        name: o.name,
                        x: this.roundCoord(o.x),
                        y: this.roundCoord(o.y),
                        z: this.roundCoord(o.z)
                    }));
                    return JSON.stringify({ count: objects.length, objects });
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
     * Look at a location (world x,y,z) or a direction (left, right, up, down, behind).
     * ----------------------------------------------------------------
    */
    private createLookAtTool(): ToolDefinition {
        return {
            name: "look_at",
            description: "Make Reachy look at a world-space position (x, y, z; two decimal places, 1 unit = 1 cm) OR in a relative direction ('left', 'right', 'up', 'down', 'behind'). Provide either (x, y, z) or direction—not both. Prefer direction when the user says 'look left', 'look up', etc. For world position (e.g. after scan_objects), set draw_line true to point at the object. When speaking to the user, never say coordinates; use relative language only ('in front of you', 'to your left', 'right there'). Duration in seconds (default: 4).",
            parameters: {
                type: "object",
                properties: {
                    x: { type: "number", description: "World X in cm (two decimal places; use with y, z; omit when using direction)" },
                    y: { type: "number", description: "World Y in cm (two decimal places; use with x, z; omit when using direction)" },
                    z: { type: "number", description: "World Z in cm (two decimal places; use with x, y; omit when using direction)" },
                    direction: {
                        type: "string",
                        description: "Relative direction: 'left', 'right', 'up', 'down', or 'behind'. Omit when using x, y, z."
                    },
                    amount_degrees: {
                        type: "number",
                        description: "How far to turn in degrees when using direction (default: 45 horizontal, 20 vertical)"
                    },
                    duration: { type: "number", description: "How long to hold the gaze in seconds (default: 4)" },
                    draw_line: { type: "boolean", description: "When looking at x,y,z: draw a line from robot to target (default: false)" }
                },
                required: []
            },
            handler: async (args: {
                x?: number; y?: number; z?: number;
                direction?: string; amount_degrees?: number;
                duration?: number; draw_line?: boolean;
            }): Promise<string> => {
                if (!this.robotDriver || !this.assistantMode) {
                    return JSON.stringify({ error: "RobotDriver or AssistantMode not initialized" });
                }

                const hasLocation = args.x !== undefined && args.y !== undefined && args.z !== undefined;
                const hasDirection = args.direction !== undefined && String(args.direction).trim().length > 0;

                if (hasLocation && hasDirection) {
                    return JSON.stringify({ error: "Provide either (x, y, z) or direction, not both." });
                }
                if (!hasLocation && !hasDirection) {
                    return JSON.stringify({ error: "Provide either (x, y, z) or direction." });
                }

                const dur = args.duration ?? 4;
                let target: vec3;

                if (hasLocation) {
                    const x = this.roundCoord(args.x!);
                    const y = this.roundCoord(args.y!);
                    const z = this.roundCoord(args.z!);
                    target = new vec3(x, y, z);
                    this.assistantMode.lookAtOverrideTarget = target;
                    this.assistantMode.lookAtOverrideEndTime = getTime() + dur;

                    if (args.draw_line === true && this.lineRendererPrefab) {
                        const headPos = this.robotDriver.getHeadWorldPosition();
                        this.showTemporaryLine(headPos, target, dur);
                    }
                    return JSON.stringify({
                        success: true,
                        looked_at: { x, y, z },
                        duration: dur,
                        line_drawn: args.draw_line === true
                    });
                }

                // Direction path (reuse look_direction logic)
                const dir = String(args.direction).toLowerCase().trim();
                const headPos = this.robotDriver.getHeadWorldPosition();
                const baseRotation = this.robotDriver.getBaseRotation();

                let forward: vec3;
                let right: vec3;
                if (baseRotation) {
                    forward = baseRotation.multiplyVec3(new vec3(0, 0, 1));
                    right = baseRotation.multiplyVec3(new vec3(1, 0, 0));
                } else {
                    forward = new vec3(0, 0, 1);
                    right = new vec3(1, 0, 0);
                }

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

                switch (dir) {
                    case "left": {
                        const amountRad = (args.amount_degrees ?? 45) * Math.PI / 180;
                        const cosA = Math.cos(amountRad);
                        const sinA = Math.sin(amountRad);
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
                        const lookDir = new vec3(
                            rotatedForward.x * cosA,
                            rotatedForward.y * cosA - sinA,
                            rotatedForward.z * cosA
                        );
                        target = headPos.add(lookDir.normalize().uniformScale(LOOK_DISTANCE));
                        break;
                    }
                    case "behind": {
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
                    looked_at: { x: this.roundCoord(target.x), y: this.roundCoord(target.y), z: this.roundCoord(target.z) },
                    duration: dur
                });
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
            description: "Get the robot's current world position and orientation, and the AR headset (user) camera position and rotation. Use robot state for internal context; use user_camera to answer questions about the user's point of view (e.g. 'the mug is to your left', 'in front of you'). When talking to the user, describe locations relative to them: 'to your left', 'in front of you', 'behind you'—never raw coordinates. For 'look left/right/up/down' prefer look_at with the direction parameter.",
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
                
                const out: Record<string, unknown> = {
                    position: { x: this.roundCoord(headPos.x), y: this.roundCoord(headPos.y), z: this.roundCoord(headPos.z) },
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
                };
                
                // AR headset (user) camera: position and rotation for answering POV questions ("to your left", etc.)
                if (this.assistantMode) {
                    const camPos = this.assistantMode.getViewerCameraWorldPosition();
                    const camRot = this.assistantMode.getViewerCameraWorldRotation();
                    if (camPos && camRot) {
                        const camEuler = camRot.toEulerAngles();
                        out.user_camera = {
                            position: { x: this.roundCoord(camPos.x), y: this.roundCoord(camPos.y), z: this.roundCoord(camPos.z) },
                            rotation: { x: camEuler.x, y: camEuler.y, z: camEuler.z }
                        };
                    }
                }
                
                return JSON.stringify(out);
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
                // Defer animation start: store on AssistantMode so it fires
                // alongside TTS playback (audio-suppressed to avoid SFX clash).
                if (this.assistantMode) {
                    this.assistantMode.pendingAnimationName = name;
                } else {
                    // Fallback: play immediately with audio if no AssistantMode
                    this.robotDriver.playAnimation(name).catch((error) => {
                        print(`AssistantTools: play_animation failed: ${error}`);
                        this.logDebug(`Agent - Error: play_animation failed: ${error}`);
                    });
                }
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
            description: "Draw a temporary curved line. Start defaults to the robot's head; omit start to draw from the robot. End is required. Coordinates in cm; two decimal places (1 unit = 1 cm). Duration in seconds (default: 10). Do not tell the user raw coordinates; use relative language ('right there', 'in front of you').",
            parameters: {
                type: "object",
                properties: {
                    start_x: { type: "number", description: "Start X in cm, two decimal places (omit to use robot head)" },
                    start_y: { type: "number", description: "Start Y in cm, two decimal places (omit to use robot head)" },
                    start_z: { type: "number", description: "Start Z in cm, two decimal places (omit to use robot head)" },
                    end_x: { type: "number", description: "End X in cm, two decimal places" },
                    end_y: { type: "number", description: "End Y in cm, two decimal places" },
                    end_z: { type: "number", description: "End Z in cm, two decimal places" },
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
                        ? new vec3(this.roundCoord(args.start_x!), this.roundCoord(args.start_y!), this.roundCoord(args.start_z!))
                        : (this.robotDriver ? this.robotDriver.getHeadWorldPosition() : new vec3(0, 0, 0));
                    if (!hasStart && !this.robotDriver) {
                        return JSON.stringify({ error: "draw_line: omit start only when robotDriver is available" });
                    }
                    const end = new vec3(this.roundCoord(args.end_x), this.roundCoord(args.end_y), this.roundCoord(args.end_z));
                    const duration = args.duration ?? 10;
                    this.showTemporaryLine(start, end, duration);
                    return JSON.stringify({
                        success: true,
                        from: { x: this.roundCoord(start.x), y: this.roundCoord(start.y), z: this.roundCoord(start.z) },
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
            description: "Capture an image from Reachy Mini's onboard camera (the robot's perspective). Use when the user wants to see what the robot sees. Optionally provide aim_at_x, aim_at_y, aim_at_z (world position in cm; two decimal places) to point the head at a location first; capture happens after a short delay. When describing the shot to the user, use relative language ('what's in front of you', 'to your left'), never coordinates.",
            parameters: {
                type: "object",
                properties: {
                    aim_at_x: { type: "number", description: "World X in cm, two decimal places, to look at before capture (optional)" },
                    aim_at_y: { type: "number", description: "World Y in cm, two decimal places, to look at before capture (optional)" },
                    aim_at_z: { type: "number", description: "World Z in cm, two decimal places, to look at before capture (optional)" },
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
                    const ax = this.roundCoord(args.aim_at_x!);
                    const ay = this.roundCoord(args.aim_at_y!);
                    const az = this.roundCoord(args.aim_at_z!);
                    const target = new vec3(ax, ay, az);
                    this.assistantMode.lookAtOverrideTarget = target;
                    this.assistantMode.lookAtOverrideEndTime = getTime() + 1.0;
                    aimedAt = { x: ax, y: ay, z: az };
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
                        camera_position: { x: this.roundCoord(headPos.x), y: this.roundCoord(headPos.y), z: this.roundCoord(headPos.z) },
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
