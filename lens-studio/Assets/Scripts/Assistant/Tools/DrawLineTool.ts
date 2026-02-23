import { ToolDefinition } from "../LLMService";
import { RobotDriver } from "../../RobotDriver/RobotDriver";

export interface DrawLineToolDeps {
    robotDriver: RobotDriver | null;
    lineRendererPrefab: ObjectPrefab;
    roundCoord: (v: number) => number;
    showTemporaryLine: (start: vec3, end: vec3, duration: number) => void;
}

export function createDrawLineTool(deps: DrawLineToolDeps): ToolDefinition {
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
                const hasStart = args.start_x !== undefined && args.start_y !== undefined && args.start_z !== undefined;
                const start = hasStart
                    ? new vec3(deps.roundCoord(args.start_x!), deps.roundCoord(args.start_y!), deps.roundCoord(args.start_z!))
                    : (deps.robotDriver ? deps.robotDriver.getHeadWorldPosition() : new vec3(0, 0, 0));
                if (!hasStart && !deps.robotDriver) {
                    return JSON.stringify({ error: "draw_line: omit start only when robotDriver is available" });
                }
                const end = new vec3(deps.roundCoord(args.end_x), deps.roundCoord(args.end_y), deps.roundCoord(args.end_z));
                const duration = args.duration ?? 10;
                deps.showTemporaryLine(start, end, duration);
                return JSON.stringify({
                    success: true,
                    from: { x: deps.roundCoord(start.x), y: deps.roundCoord(start.y), z: deps.roundCoord(start.z) },
                    to: { x: end.x, y: end.y, z: end.z },
                    duration: duration
                });
            } catch (error) {
                return JSON.stringify({ error: `Failed to draw line: ${error}` });
            }
        }
    };
}
