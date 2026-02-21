import { ToolDefinition } from "../LLMService";
import { RobotDriver } from "../../RobotDriver/RobotDriver";

export interface GetStateToolDeps {
    robotDriver: RobotDriver;
    assistantMode: {
        getViewerCameraWorldPosition(): vec3 | null;
        getViewerCameraWorldRotation(): quat | null;
    } | null;
    roundCoord: (v: number) => number;
}

export function createGetStateTool(deps: GetStateToolDeps): ToolDefinition {
    return {
        name: "get_state",
        description: "Get the robot's current world position and orientation, and the AR headset (user) camera position and rotation. Use robot state for internal context; use user_camera to answer questions about the user's point of view (e.g. 'the mug is to your left', 'in front of you'). When talking to the user, describe locations relative to them: 'to your left', 'in front of you', 'behind you'—never raw coordinates. For 'look left/right/up/down' prefer look_at with the direction parameter.",
        parameters: {
            type: "object",
            properties: {},
            required: []
        },
        handler: async (): Promise<string> => {
            const headPos = deps.robotDriver.getHeadWorldPosition();
            const headAngles = deps.robotDriver.getHeadAngles();
            const bodyYaw = deps.robotDriver.getBodyYaw();
            const baseRotation = deps.robotDriver.getBaseRotation();
            
            // Convert base quaternion to euler angles for easier interpretation
            let baseEuler = null;
            if (baseRotation) {
                baseEuler = baseRotation.toEulerAngles();
            }
            
            const out: Record<string, unknown> = {
                position: { x: deps.roundCoord(headPos.x), y: deps.roundCoord(headPos.y), z: deps.roundCoord(headPos.z) },
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
            if (deps.assistantMode) {
                const camPos = deps.assistantMode.getViewerCameraWorldPosition();
                const camRot = deps.assistantMode.getViewerCameraWorldRotation();
                if (camPos && camRot) {
                    const camEuler = camRot.toEulerAngles();
                    out.user_camera = {
                        position: { x: deps.roundCoord(camPos.x), y: deps.roundCoord(camPos.y), z: deps.roundCoord(camPos.z) },
                        rotation: { x: camEuler.x, y: camEuler.y, z: camEuler.z }
                    };
                }
            }
            
            return JSON.stringify(out);
        }
    };
}
