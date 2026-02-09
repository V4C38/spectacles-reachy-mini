import { OpenAI } from "RemoteServiceGateway.lspkg/HostedExternal/OpenAI";

export interface LLMResponse {
    text: string;
    audioTrack: AudioTrackAsset;
}

export interface ToolDefinition {
    name: string;
    description: string;
    parameters: Record<string, any>;
    handler: (args: any) => Promise<string>;
}

type LLMBackend = "openai" | "gemini";

interface ChatMessage {
    role: "system" | "user" | "assistant" | "tool";
    content?: string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;
    tool_calls?: any[];
    tool_call_id?: string;
    name?: string;
}


// ----------------------------------------------------------------
// LLMService
// This class is used to handle the LLM interactions and tool calls with OpenAI
// ----------------------------------------------------------------
@component
export class LLMService extends BaseScriptComponent {

    @input
    public model: string = "gpt-4.1-nano";
    @input
    public ttsModel: string = "tts-1";
    @input
    public ttsVoice: string = "alloy";

    public temperature: number = 0.7;
    public maxTokens: number = 512;

    // --- State ---
    private tools: ToolDefinition[] = [];
    private messages: ChatMessage[] = [];

    // Logger
    @input
    private textDebugInfo: Text | null = null;

    private logDebug(message: string): void {
        if (this.textDebugInfo) {
            this.textDebugInfo.text = message;
        }
    }

    @input
    private systemPrompt: string = `You are Reachy, a compact desktop robot (11 inches, 3.3 lbs) with a head, two animated antennas, and a flexible neck. You have no arms or legs—you express yourself through head turns, antenna movements, and speech. You use your cameras to see and your microphone to hear.

    You are a friendly and helpful robot assistant. Always respond briefly (e.g. 1–2 sentences). You have access to tools for finding and pointing at objects, looking in relative directions, and playing animations (motion + sound in sync).

    When the user asks you to perform an action that has an animation, call play_animation as part of your response so the motion and audio play together. Use play_animation for: wave (wave), say hello / greet / hi (greeting), say goodbye / bye (goodbye), nod / yes (nod), look happy / cheer up (happy), look sad (sad), get excited (excited), think / hmm (thinking), sway (sway), peekaboo (peekaboo), dance (dance).

    Prefer fewer tool calls: combine work when possible (e.g. one scan_objects call for all requested objects, then look_at_location as needed). Avoid calling the same tool multiple times when one call can fulfill the request.

    Spatial awareness rules:
    - When the user asks to find or locate an object (e.g. "where is my phone", "can you help me find my glasses", "find my keys"): (1) call scan_objects with that object, (2) when it returns results, call look_at_location with the object's coordinates and draw_line true to point at it, (3) then reply briefly with a confirmation like "Yes, I found it! It's right there!" or "There it is!" — do not give a long explanation.
    - When the user only asks what objects you see or what is around (generic list), use scan_objects but do NOT draw a line — do not call look_at_location with draw_line true.
    - When the user asks you to LOOK in a relative direction (left, right, up, down, behind): call look_direction with the appropriate direction name. Do NOT compute coordinates yourself.
    - You are a physical robot with a head that can turn. Use get_state when you need to know where you are or which way you are facing.
    - Never recite coordinates (x, y, z) unless the user explicitly asks for COORDINATES. Always describe location in relative terms: "to my left", "in front of you", "behind you", etc. You may add approximate distance in centimeters when helpful, e.g. "about 50cm to my left." All distances are in centimeters.`;

    // --- Agentic loop safety ---
    private readonly MAX_TOOL_ITERATIONS = 5;

    onAwake() {
    }


    //------------------------------------------------  
    // Send Message
    //------------------------------------------------
    public async sendMessage(text: string): Promise<LLMResponse> {
        // Add user message to history
        this.messages.push({ role: "user", content: text });
        print(`LLMService: User says: "${text}"`);

        // Run agentic loop
        const responseText = await this.runAgenticLoop();

        // Add assistant response to history
        this.messages.push({ role: "assistant", content: responseText });
        print(`LLMService: Assistant says: "${responseText}"`);
        this.logDebug(`Agent - ${responseText}`);

        // Generate TTS audio
        const audioTrack = await this.generateTTS(responseText);

        return { text: responseText, audioTrack };
    }

    public clearHistory(): void {
        this.messages = [];
        print("LLMService: Conversation history cleared");
    }

    // Personality
    public setSystemPrompt(prompt: string): void {
        this.systemPrompt = prompt;
    }

    //------------------------------------------------  
    // Agentic Loop
    // Run chat completions in a loop, executing tool calls until we get a final text response.
    //------------------------------------------------
    private async runAgenticLoop(): Promise<string> {
        for (let iteration = 0; iteration < this.MAX_TOOL_ITERATIONS; iteration++) {
            const result = await this.callChatCompletions();

            if (result.type === "text") {
                return result.text;
            }

            if (result.type === "tool_calls") {
                // Execute each tool call and add results to message history
                for (const toolCall of result.toolCalls) {
                    const toolResult = await this.executeToolCall(toolCall);
                    this.messages.push({
                        role: "tool",
                        content: toolResult,
                        tool_call_id: toolCall.id,
                        name: toolCall.name
                    });

                    // If tool returned an image, inject it as a user message for vision models
                    try {
                        const parsed = JSON.parse(toolResult);
                        const imageBase64 = parsed && parsed.image_base64;
                        if (imageBase64) {
                            const cameraPosition = parsed.camera_position;
                            const lookDirection = parsed.look_direction;
                            const aimedAt = parsed.aimed_at;
                            let text = `Image from ${toolCall.name}. Camera at ${JSON.stringify(cameraPosition || {})}, looking ${JSON.stringify(lookDirection || {})}`;
                            if (aimedAt) {
                                text += `, aimed at ${JSON.stringify(aimedAt)}`;
                            }
                            text += ". Analyze it and respond to the user.";
                            this.messages.push({
                                role: "user",
                                content: [
                                    { type: "text", text },
                                    { type: "image_url", image_url: { url: `data:image/jpeg;base64,${imageBase64}` } }
                                ]
                            });
                        }
                    } catch (_) {
                        // Not JSON or no image_base64, skip injection
                    }
                }
                continue;
            }

            throw new Error(`LLMService: Unexpected result type from chat completions`);
        }

        throw new Error(`LLMService: Max tool iterations (${this.MAX_TOOL_ITERATIONS}) exceeded`);
    }


    private async callChatCompletions(): Promise<
        { type: "text"; text: string } | { type: "tool_calls"; toolCalls: { id: string; name: string; arguments: string }[] }
    > {
        return this.callOpenAICompletions();
    }


    //------------------------------------------------  
    // Tools
    //------------------------------------------------
    /** Remove all registered tools. Call before re-registering to reflect current state (e.g. simulation mode). */
    public clearTools(): void {
        this.tools = [];
        print("LLMService: Cleared all tools");
    }

    public registerTool(tool: ToolDefinition): void {
        const existingIndex = this.tools.findIndex(t => t.name === tool.name);
        if (existingIndex >= 0) {
            this.tools[existingIndex] = tool;
        } else {
            this.tools.push(tool);
        }
        print(`LLMService: Registered tool "${tool.name}"`);
    }

    private async executeToolCall(toolCall: { id: string; name: string; arguments: string }): Promise<string> {
        const tool = this.tools.find(t => t.name === toolCall.name);
        if (!tool) {
            print(`LLMService: Unknown tool "${toolCall.name}"`);
            return JSON.stringify({ error: `Unknown tool: ${toolCall.name}` });
        }

        print(`LLMService: Executing tool "${toolCall.name}" with args: ${toolCall.arguments}`);
        this.logDebug(`Agent - called tool ${toolCall.name}: ${toolCall.arguments}`);
        try {
            const args = JSON.parse(toolCall.arguments);
            const result = await tool.handler(args);
            print(`LLMService: Tool "${toolCall.name}" returned: ${result}`);
            this.logDebug(`Agent - tool response ${toolCall.name}: ${result}`);
            return result;
        } catch (error) {
            print(`LLMService: Tool "${toolCall.name}" failed: ${error}`);
            this.logDebug(`Agent - Error: Tool ${toolCall.name} failed: ${error}`);
            return JSON.stringify({ error: `Tool execution failed: ${error}` });
        }
    }

    //------------------------------------------------  
    // Text-to-Speech (OpenAI)
    //------------------------------------------------
    private async generateTTS(text: string): Promise<AudioTrackAsset> {
        const audioTrack = await OpenAI.speech({
            model: this.ttsModel,
            input: text,
            voice: this.ttsVoice,
        });
        return audioTrack;
    }

    // ----------------------------------------------------------------
    // Chat Completions (OpenAI)
    // ----------------------------------------------------------------
    private async callOpenAICompletions(): Promise<
        { type: "text"; text: string } | { type: "tool_calls"; toolCalls: { id: string; name: string; arguments: string }[] }
    > {
        // Build messages array with system prompt
        const openAIMessages: any[] = [
            { role: "system", content: this.systemPrompt },
            ...this.messages
        ];

        // Build request
        const request: any = {
            model: this.model,
            messages: openAIMessages,
            temperature: this.temperature,
            max_tokens: this.maxTokens,
        };

        // Add tools if registered
        if (this.tools.length > 0) {
            request.tools = this.tools.map(t => ({
                type: "function",
                function: {
                    name: t.name,
                    description: t.description,
                    parameters: t.parameters,
                }
            }));
        }

        const response = await OpenAI.chatCompletions(request);
        const choice = response.choices[0];

        // Check for tool calls
        if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
            // Add assistant message with tool calls to history
            this.messages.push({
                role: "assistant",
                tool_calls: choice.message.tool_calls,
            });

            const toolCalls = choice.message.tool_calls.map((tc: any) => ({
                id: tc.id,
                name: tc.function.name,
                arguments: tc.function.arguments,
            }));

            return { type: "tool_calls", toolCalls };
        }

        // Final text response
        const text = choice.message.content || "";
        return { type: "text", text };
    }
}
