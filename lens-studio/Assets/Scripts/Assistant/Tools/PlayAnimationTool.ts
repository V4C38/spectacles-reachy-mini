import { ToolDefinition } from "../LLMService";
import { RobotDriver } from "../../RobotDriver/RobotDriver";

export interface PlayAnimationToolDeps {
    robotDriver: RobotDriver;
    assistantMode: { pendingAnimationName: string | null } | null;
    logDebug: (msg: string) => void;
}

export function createPlayAnimationTool(deps: PlayAnimationToolDeps): ToolDefinition {
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
            const name = (args.animationName || "").trim();
            if (!name) {
                return JSON.stringify({ error: "animationName is required" });
            }
            // Defer animation start: store on AssistantMode so it fires
            // alongside TTS playback (audio-suppressed to avoid SFX clash).
            if (deps.assistantMode) {
                deps.assistantMode.pendingAnimationName = name;
            } else {
                // Fallback: play immediately with audio if no AssistantMode
                deps.robotDriver.playAnimation(name).catch((error) => {
                    print(`AssistantTools: play_animation failed: ${error}`);
                    deps.logDebug(`Agent - Error: play_animation failed: ${error}`);
                });
            }
            return JSON.stringify({ success: true, animation: name });
        }
    };
}

export function createGetAvailableAnimationsTool(robotDriver: RobotDriver): ToolDefinition {
    return {
        name: "get_available_animations",
        description: "Get the list of animation names that Reachy Mini can play. Call this when the user asks what animations are available or whether the robot can play a specific animation.",
        parameters: {
            type: "object",
            properties: {},
            required: []
        },
        handler: async (): Promise<string> => {
            try {
                const names = await robotDriver.getAvailableAnimations();
                return JSON.stringify({ names });
            } catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                return JSON.stringify({ error: msg, names: [] });
            }
        }
    };
}
