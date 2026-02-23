import { ToolDefinition } from "../LLMService";
import { RobotDriver } from "../../RobotDriver/RobotDriver";

export interface LookAtToolDeps {
    robotDriver: RobotDriver;
    assistantMode: {
        lookAtOverrideTarget: vec3 | null;
        lookAtOverrideEndTime: number;
    };
    roundCoord: (v: number) => number;
    showTemporaryLine: (start: vec3, end: vec3, duration: number) => void;
    lineRendererPrefab: ObjectPrefab | null;
}

export function createLookAtTool(deps: LookAtToolDeps): ToolDefinition {
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
                const x = deps.roundCoord(args.x!);
                const y = deps.roundCoord(args.y!);
                const z = deps.roundCoord(args.z!);
                target = new vec3(x, y, z);
                deps.assistantMode.lookAtOverrideTarget = target;
                deps.assistantMode.lookAtOverrideEndTime = getTime() + dur;

                if (args.draw_line === true && deps.lineRendererPrefab) {
                    const headPos = deps.robotDriver.getHeadWorldPosition();
                    deps.showTemporaryLine(headPos, target, dur);
                }
                return JSON.stringify({
                    success: true,
                    looked_at: { x, y, z },
                    duration: dur,
                    line_drawn: args.draw_line === true
                });
            }

            // Direction path
            const dir = String(args.direction).toLowerCase().trim();
            const headPos = deps.robotDriver.getHeadWorldPosition();
            const baseRotation = deps.robotDriver.getBaseRotation();

            let forward: vec3;
            let right: vec3;
            if (baseRotation) {
                forward = baseRotation.multiplyVec3(new vec3(0, 0, 1));
                right = baseRotation.multiplyVec3(new vec3(1, 0, 0));
            } else {
                forward = new vec3(0, 0, 1);
                right = new vec3(1, 0, 0);
            }

            const bodyYaw = deps.robotDriver.getBodyYaw();
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

            deps.assistantMode.lookAtOverrideTarget = target;
            deps.assistantMode.lookAtOverrideEndTime = getTime() + dur;

            return JSON.stringify({
                success: true,
                direction: dir,
                looked_at: { x: deps.roundCoord(target.x), y: deps.roundCoord(target.y), z: deps.roundCoord(target.z) },
                duration: dur
            });
        }
    };
}
