import { ToolDefinition, LLMService } from "./LLMService";
import { AssistantMode, AssistantState } from "../AssistantMode";
import { MLObjectDetector } from "./MLObjectDetector";
import { RobotDriver } from "../RobotDriver";
import { createCurvedLine } from "./ObjectLinkRenderer";

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
    public lineMaterial: Material | null = null;

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

        let registeredCount = 0;

        // Register scan_objects tool if dependencies are available
        if (this.mlDetector && this.objectMarkerPrefab && this.assistantMode) {
            llmService.registerTool(this.createScanObjectsTool());
            registeredCount++;
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

        // Register draw_line tool (requires line material to be usable)
        llmService.registerTool(this.createDrawLineTool());
        registeredCount++;

        print(`AssistantTools: Registered ${registeredCount} tools`);
    }

    // ================================================================
    // Tool Definitions
    // ================================================================

    private createScanObjectsTool(): ToolDefinition {
        return {
            name: "scan_objects",
            description: "Scan the user's surroundings for objects matching a description. Use this when the user asks about objects around them or wants to find something. After receiving results, call look_at_location to gaze at the most relevant object (a line is drawn automatically).",
            parameters: {
                type: "object",
                properties: {
                    prompt: {
                        type: "string",
                        description: "What kind of objects to look for (e.g. 'all objects', 'cups and bottles', 'electronics')"
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

    private createLookAtLocationTool(): ToolDefinition {
        return {
            name: "look_at_location",
            description: "Make Reachy look at a world-space position for a given duration. A visible line is drawn from the robot's head to the target automatically (set draw_line to false to suppress). The robot will hold its gaze on the point for the specified duration before resuming normal behavior.",
            parameters: {
                type: "object",
                properties: {
                    x: { type: "number", description: "World X coordinate to look at" },
                    y: { type: "number", description: "World Y coordinate to look at" },
                    z: { type: "number", description: "World Z coordinate to look at" },
                    duration: { type: "number", description: "How long to look at the location in seconds (default: 3)" },
                    draw_line: { type: "boolean", description: "Whether to draw a visible line from the robot to the target (default: true)" }
                },
                required: ["x", "y", "z"]
            },
            handler: async (args: { x: number; y: number; z: number; duration?: number; draw_line?: boolean }): Promise<string> => {
                const dur = args.duration ?? 3;
                const shouldDrawLine = args.draw_line !== false;
                const target = new vec3(args.x, args.y, args.z);

                this.assistantMode.lookAtOverrideTarget = target;
                this.assistantMode.lookAtOverrideEndTime = getTime() + dur;

                // Automatically draw a line from robot head to target
                if (shouldDrawLine && this.robotDriver && this.lineMaterial) {
                    const headPos = this.robotDriver.getHeadWorldPosition();
                    this.showTemporaryLine(headPos, target, dur);
                }

                await new Promise<void>((resolve) => {
                    const delayEvent = this.createEvent("DelayedCallbackEvent") as DelayedCallbackEvent;
                    delayEvent.bind(() => resolve());
                    delayEvent.reset(dur);
                });

                return JSON.stringify({ success: true, looked_at: { x: args.x, y: args.y, z: args.z }, duration: dur, line_drawn: shouldDrawLine });
            }
        };
    }

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
                        description: "How long to hold the gaze in seconds (default: 3)"
                    }
                },
                required: ["direction"]
            },
            handler: async (args: { direction: string; amount_degrees?: number; duration?: number }): Promise<string> => {
                if (!this.robotDriver || !this.assistantMode) {
                    return JSON.stringify({ error: "RobotDriver or AssistantMode not initialized" });
                }

                const dir = args.direction.toLowerCase().trim();
                const dur = args.duration ?? 3;
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

                await new Promise<void>((resolve) => {
                    const delayEvent = this.createEvent("DelayedCallbackEvent") as DelayedCallbackEvent;
                    delayEvent.bind(() => resolve());
                    delayEvent.reset(dur);
                });

                return JSON.stringify({
                    success: true,
                    direction: dir,
                    looked_at: { x: target.x, y: target.y, z: target.z },
                    duration: dur
                });
            }
        };
    }

    private createDrawLineTool(): ToolDefinition {
        return {
            name: "draw_line",
            description: "Draw a temporary curved line between two 3D positions in world space. The line will appear with an animation, remain visible for the specified duration, then disappear. Useful for pointing at objects or showing spatial relationships.",
            parameters: {
                type: "object",
                properties: {
                    start_x: { type: "number", description: "Start position X coordinate in world space" },
                    start_y: { type: "number", description: "Start position Y coordinate in world space" },
                    start_z: { type: "number", description: "Start position Z coordinate in world space" },
                    end_x: { type: "number", description: "End position X coordinate in world space" },
                    end_y: { type: "number", description: "End position Y coordinate in world space" },
                    end_z: { type: "number", description: "End position Z coordinate in world space" },
                    duration: { type: "number", description: "How long to display the line in seconds (default: 3)" }
                },
                required: ["start_x", "start_y", "start_z", "end_x", "end_y", "end_z"]
            },
            handler: async (args: { 
                start_x: number; 
                start_y: number; 
                start_z: number; 
                end_x: number; 
                end_y: number; 
                end_z: number; 
                duration?: number;
            }): Promise<string> => {
                try {
                    if (!this.lineMaterial) {
                        return JSON.stringify({ error: "Line material not configured" });
                    }
                    
                    const start = new vec3(args.start_x, args.start_y, args.start_z);
                    const end = new vec3(args.end_x, args.end_y, args.end_z);
                    const duration = args.duration ?? 3;
                    
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

    /**
     * Show a temporary curved line between two world positions.
     * The line fades in, stays for the given duration, then fades out and is destroyed.
     */
    private showTemporaryLine(start: vec3, end: vec3, duration: number): void {
        if (!this.lineMaterial) return;

        const handle = createCurvedLine(start, end, this.lineMaterial);

        // Schedule fade-out and cleanup
        const delayEvent = this.createEvent("DelayedCallbackEvent") as DelayedCallbackEvent;
        delayEvent.bind(() => {
            handle.disappear();
            const destroyEvent = this.createEvent("DelayedCallbackEvent") as DelayedCallbackEvent;
            destroyEvent.bind(() => handle.destroy());
            destroyEvent.reset(0.3);
        });
        delayEvent.reset(duration);
    }

    // ================================================================
    // Helper Methods
    // ================================================================

}
