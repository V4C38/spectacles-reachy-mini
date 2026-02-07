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
    content?: string;
    tool_calls?: any[];
    tool_call_id?: string;
    name?: string;
}

@component
export class LLMInterface extends BaseScriptComponent {

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

    @input
    private systemPrompt: string = "You are Reachy, a friendly and helpful robot assistant. Keep responses concise and conversational — aim for 1-3 sentences. You have access to tools for scanning the environment and interacting with objects.";

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
        print(`LLMInterface: User says: "${text}"`);

        // Run agentic loop
        const responseText = await this.runAgenticLoop();

        // Add assistant response to history
        this.messages.push({ role: "assistant", content: responseText });
        print(`LLMInterface: Assistant says: "${responseText}"`);

        // Generate TTS audio
        const audioTrack = await this.generateTTS(responseText);

        return { text: responseText, audioTrack };
    }

    public clearHistory(): void {
        this.messages = [];
        print("LLMInterface: Conversation history cleared");
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
                }
                continue;
            }

            throw new Error(`LLMInterface: Unexpected result type from chat completions`);
        }

        throw new Error(`LLMInterface: Max tool iterations (${this.MAX_TOOL_ITERATIONS}) exceeded`);
    }


    private async callChatCompletions(): Promise<
        { type: "text"; text: string } | { type: "tool_calls"; toolCalls: { id: string; name: string; arguments: string }[] }
    > {
        return this.callOpenAICompletions();
    }


    //------------------------------------------------  
    // Tools
    //------------------------------------------------
    public registerTool(tool: ToolDefinition): void {
        const existingIndex = this.tools.findIndex(t => t.name === tool.name);
        if (existingIndex >= 0) {
            this.tools[existingIndex] = tool;
        } else {
            this.tools.push(tool);
        }
        print(`LLMInterface: Registered tool "${tool.name}"`);
    }

    private async executeToolCall(toolCall: { id: string; name: string; arguments: string }): Promise<string> {
        const tool = this.tools.find(t => t.name === toolCall.name);
        if (!tool) {
            print(`LLMInterface: Unknown tool "${toolCall.name}"`);
            return JSON.stringify({ error: `Unknown tool: ${toolCall.name}` });
        }

        print(`LLMInterface: Executing tool "${toolCall.name}" with args: ${toolCall.arguments}`);
        try {
            const args = JSON.parse(toolCall.arguments);
            const result = await tool.handler(args);
            print(`LLMInterface: Tool "${toolCall.name}" returned: ${result}`);
            return result;
        } catch (error) {
            print(`LLMInterface: Tool "${toolCall.name}" failed: ${error}`);
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
