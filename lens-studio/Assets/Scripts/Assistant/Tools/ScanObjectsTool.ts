import { ToolDefinition } from "../LLMService";
import { AssistantState } from "../AssistantMode";
import { MLObjectDetector } from "../../Utils/MLObjectDetector";

export interface ScanObjectsToolDeps {
    assistantMode: { setState(s: AssistantState): void; getState(): AssistantState };
    mlDetector: MLObjectDetector;
    objectMarkerPrefab: ObjectPrefab;
    roundCoord: (v: number) => number;
    logDebug: (msg: string) => void;
}

export function createScanObjectsTool(deps: ScanObjectsToolDeps): { tool: ToolDefinition; getIsScanning: () => boolean } {
    let isScanning = false;

    async function triggerScan(prompt: string): Promise<void> {
        if (isScanning) return;
        if (!prompt || prompt.trim().length === 0) {
            throw new Error("AssistantTools: prompt is required");
        }

        isScanning = true;

        try {
            await deps.mlDetector.requestObjectDetection(prompt, deps.objectMarkerPrefab);
        } catch (error) {
            print(`AssistantTools: Scan failed: ${error}`);
            throw error;
        } finally {
            isScanning = false;
        }
    }

    const tool: ToolDefinition = {
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
            deps.assistantMode.setState(AssistantState.Searching);
            try {
                await triggerScan(args.prompt);
                const raw = deps.mlDetector.getTrackedObjectSummaries();
                const objects = raw.map((o) => ({
                    name: o.name,
                    x: deps.roundCoord(o.x),
                    y: deps.roundCoord(o.y),
                    z: deps.roundCoord(o.z)
                }));
                return JSON.stringify({ count: objects.length, objects });
            } catch (error) {
                deps.logDebug(`Agent - Error: Scan failed: ${error}`);
                return JSON.stringify({ error: `Scan failed: ${error}` });
            } finally {
                if (deps.assistantMode.getState() === AssistantState.Searching) {
                    deps.assistantMode.setState(AssistantState.Listening);
                }
            }
        }
    };

    return { tool, getIsScanning: () => isScanning };
}
