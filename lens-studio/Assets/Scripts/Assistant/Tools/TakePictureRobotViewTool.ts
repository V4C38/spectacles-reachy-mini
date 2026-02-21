import { ToolDefinition } from "../LLMService";
import { RobotDriver } from "../../RobotDriver/RobotDriver";
import { HardwareAdapter } from "../../RobotDriver/HardwareAdapter";

export interface TakePictureRobotViewToolDeps {
    robotDriver: RobotDriver;
    hardwareAdapter: HardwareAdapter;
    assistantMode: {
        lookAtOverrideTarget: vec3 | null;
        lookAtOverrideEndTime: number;
    };
    roundCoord: (v: number) => number;
    createDelayedCallback: (callback: () => void, delaySec: number) => void;
}

export function createTakePictureRobotViewTool(deps: TakePictureRobotViewToolDeps): ToolDefinition {
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
            const hasAim = args.aim_at_x !== undefined && args.aim_at_y !== undefined && args.aim_at_z !== undefined;
            let aimedAt: { x: number; y: number; z: number } | undefined;
            if (hasAim) {
                const ax = deps.roundCoord(args.aim_at_x!);
                const ay = deps.roundCoord(args.aim_at_y!);
                const az = deps.roundCoord(args.aim_at_z!);
                const target = new vec3(ax, ay, az);
                deps.assistantMode.lookAtOverrideTarget = target;
                deps.assistantMode.lookAtOverrideEndTime = getTime() + 1.0;
                aimedAt = { x: ax, y: ay, z: az };
                await new Promise<void>((resolve) => {
                    deps.createDelayedCallback(() => resolve(), 0.9);
                });
            }
            try {
                const imageBase64 = await deps.hardwareAdapter.getRobotCameraFrame();
                const headPos = deps.robotDriver.getHeadWorldPosition();
                const headAngles = deps.robotDriver.getHeadAngles();
                const result: Record<string, any> = {
                    success: true,
                    image_base64: imageBase64,
                    mime: "image/jpeg",
                    source: "robot_camera",
                    camera_position: { x: deps.roundCoord(headPos.x), y: deps.roundCoord(headPos.y), z: deps.roundCoord(headPos.z) },
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
