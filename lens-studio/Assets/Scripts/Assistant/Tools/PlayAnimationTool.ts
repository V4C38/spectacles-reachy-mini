import { ToolDefinition } from "../LLMService";
import { RobotDriver } from "../../RobotDriver/RobotDriver";
import { POLLEN } from "../../RobotDriver/PollenAnimations";

const NAMES = Object.keys(POLLEN);

const MEANING: Record<string, string> = {
    laughing1: "laugh",
    laughing2: "short laugh",
    no1: "no",
    no_excited1: "excited no",
    proud1: "proud",
    success2: "success",
    contempt1: "sneer",
    fear1: "big flinch",
    neck_recoil: "flinch",
    scared1: "scared",
    inquiring3: "curious",
    rage1: "angry",
    furious1: "furious",
    reprimand1: "reprimand",
    go_away1: "go away",
    side_glance_flick: "glance",
    electric1: "shock",
    dying1: "collapse",
};

function animationList(): { name: string; means: string }[] {
    const out: { name: string; means: string }[] = [];
    for (let i = 0; i < NAMES.length; i++) {
        const name = NAMES[i];
        out.push({ name, means: MEANING[name] || name });
    }
    return out;
}

export function createGetAvailableAnimationsTool(): ToolDefinition {
    return {
        name: "get_available_animations",
        description: "List every animation Reachy can play, with what each name means. Call this before play_animation whenever you are not sure of the exact name.",
        parameters: {
            type: "object",
            properties: {},
            required: [],
        },
        handler: async (): Promise<string> => {
            return JSON.stringify({ animations: animationList() });
        },
    };
}

export interface PlayAnimationToolDeps {
    robotDriver: RobotDriver;
}

function durationSec(name: string): number {
    const keys = POLLEN[name];
    let total = 0;
    for (let i = 0; i < keys.length; i++) total += keys[i].duration;
    return Math.round(total * 100) / 100;
}

export function createPlayAnimationTool(deps: PlayAnimationToolDeps): ToolDefinition {
    return {
        name: "play_animation",
        description: "Play one named Reachy animation for an emotional reaction. Call get_available_animations first if you do not already know the exact name. Call play_animation at most once per reply. The clip plays while Reachy speaks.",
        parameters: {
            type: "object",
            properties: {
                name: {
                    type: "string",
                    enum: NAMES,
                    description: "Animation name.",
                },
            },
            required: ["name"],
        },
        handler: async (args: { name?: string }): Promise<string> => {
            const name = args.name ? String(args.name).trim() : "";
            const keys = POLLEN[name];
            if (!keys) {
                return JSON.stringify({ error: `Unknown animation '${name}'.` });
            }
            deps.robotDriver.playAnimation(keys);
            return JSON.stringify({ success: true, name, duration_sec: durationSec(name) });
        },
    };
}
