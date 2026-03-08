import type {
  AIProvider,
  AIRequestConfig,
  AIResponse,
  StreamResult,
  Message,
  ProviderRouting,
  Lazy,
  JsonTool,
  ToolChoice,
} from "./types.ts";

function resolve<T>(value: Lazy<T>): T {
  return typeof value === "function" ? (value as () => T)() : value;
}

export class AIBuilder {
  private provider: AIProvider;
  private config: Partial<{
    model: Lazy<string>;
    temperature: Lazy<number>;
    maxTokens: Lazy<number>;
    topP: Lazy<number>;
    frequencyPenalty: Lazy<number>;
    presencePenalty: Lazy<number>;
    stop: Lazy<string[]>;
    seed: Lazy<number>;
    provider: Lazy<ProviderRouting>;
    tools: Lazy<JsonTool[]>;
    toolChoice: Lazy<ToolChoice>;
  }> = {};
  private _messages: (Message | Lazy<Message[]>)[] = [];

  constructor(provider: AIProvider, defaultModel?: string) {
    this.provider = provider;
    if (defaultModel) this.config.model = defaultModel;
  }

  model(value: Lazy<string>): this {
    this.config.model = value;
    return this;
  }

  temperature(value: Lazy<number>): this {
    this.config.temperature = value;
    return this;
  }

  maxTokens(value: Lazy<number>): this {
    this.config.maxTokens = value;
    return this;
  }

  topP(value: Lazy<number>): this {
    this.config.topP = value;
    return this;
  }

  stop(value: Lazy<string[]>): this {
    this.config.stop = value;
    return this;
  }

  seed(value: Lazy<number>): this {
    this.config.seed = value;
    return this;
  }

  providerRouting(value: Lazy<ProviderRouting>): this {
    this.config.provider = value;
    return this;
  }

  tools(value: Lazy<JsonTool[]>): this {
    this.config.tools = value;
    return this;
  }

  toolChoice(value: Lazy<ToolChoice>): this {
    this.config.toolChoice = value;
    return this;
  }

  system(content: Lazy<string>): this {
    if (typeof content === "function") {
      this._messages.push(() => [{ role: "system" as const, content: (content as () => string)() }]);
    } else {
      this._messages.push({ role: "system", content });
    }
    return this;
  }

  prompt(content: Lazy<string>): this {
    if (typeof content === "function") {
      this._messages.push(() => [{ role: "user" as const, content: (content as () => string)() }]);
    } else {
      this._messages.push({ role: "user", content });
    }
    return this;
  }

  user(content: Lazy<string>): this {
    return this.prompt(content);
  }

  assistant(content: Lazy<string>): this {
    if (typeof content === "function") {
      this._messages.push(() => [{ role: "assistant" as const, content: (content as () => string)() }]);
    } else {
      this._messages.push({ role: "assistant", content });
    }
    return this;
  }

  messages(msgs: Lazy<Message[]>): this {
    this._messages.push(msgs);
    return this;
  }

  async query(): Promise<AIResponse> {
    return this.provider.complete(this.buildConfig());
  }

  stream(): StreamResult {
    return this.provider.stream(this.buildConfig());
  }

  async streamToCompletion(): Promise<AIResponse> {
    const result = this.stream();
    let fullContent = "";

    for await (const delta of result.textStream) {
      fullContent += delta;
    }

    const toolCalls = await result.toolCalls;
    const model = this.config.model ? resolve(this.config.model) : "";

    return {
      id: "",
      model,
      content: fullContent || null,
      finishReason: toolCalls.length > 0 ? "tool_calls" : "stop",
      ...(toolCalls.length > 0 && { toolCalls }),
    };
  }

  private buildConfig(): AIRequestConfig {
    const model = this.config.model ? resolve(this.config.model) : undefined;
    if (!model) {
      throw new Error("Model must be specified. Use .model() to set it.");
    }

    const messages: Message[] = [];
    for (const entry of this._messages) {
      if (typeof entry === "function") {
        messages.push(...(entry as () => Message[])());
      } else if (Array.isArray(entry)) {
        messages.push(...entry);
      } else {
        messages.push(entry);
      }
    }

    const temperature = this.config.temperature !== undefined ? resolve(this.config.temperature) : undefined;
    const maxTokens = this.config.maxTokens !== undefined ? resolve(this.config.maxTokens) : undefined;
    const topP = this.config.topP !== undefined ? resolve(this.config.topP) : undefined;
    const frequencyPenalty = this.config.frequencyPenalty !== undefined ? resolve(this.config.frequencyPenalty) : undefined;
    const presencePenalty = this.config.presencePenalty !== undefined ? resolve(this.config.presencePenalty) : undefined;
    const stop = this.config.stop !== undefined ? resolve(this.config.stop) : undefined;
    const seed = this.config.seed !== undefined ? resolve(this.config.seed) : undefined;
    const provider = this.config.provider !== undefined ? resolve(this.config.provider) : undefined;
    const tools = this.config.tools !== undefined ? resolve(this.config.tools) : undefined;
    const toolChoice = this.config.toolChoice !== undefined ? resolve(this.config.toolChoice) : undefined;

    return { model, messages, temperature, maxTokens, topP, frequencyPenalty, presencePenalty, stop, seed, provider, tools, toolChoice };
  }
}

export class AI {
  private provider: AIProvider;
  private defaultModel?: string;

  constructor(provider: AIProvider, defaultModel?: string) {
    this.provider = provider;
    this.defaultModel = defaultModel;
  }

  model(modelId: string): AIBuilder {
    return new AIBuilder(this.provider, modelId);
  }

  chat(): AIBuilder {
    if (!this.defaultModel) throw new Error("No default model set. Use .model() instead.");
    return new AIBuilder(this.provider, this.defaultModel);
  }

  conversation(options?: { model?: string; system?: string }): AIConversation {
    const modelId = options?.model ?? this.defaultModel;
    if (!modelId) throw new Error("No model specified. Provide model in options or set default model.");
    return new AIConversation(this.provider, modelId, options?.system);
  }
}

export class AIConversation {
  private provider: AIProvider;
  private modelId: string;
  private systemPrompt?: string;
  private history: Message[] = [];
  private routing?: ProviderRouting;
  private jsonTools?: JsonTool[];

  constructor(provider: AIProvider, modelId: string, systemPrompt?: string) {
    this.provider = provider;
    this.modelId = modelId;
    this.systemPrompt = systemPrompt;
  }

  async send(message: string): Promise<AIResponse> {
    this.history.push({ role: "user", content: message });

    const builder = new AIBuilder(this.provider, this.modelId);
    if (this.systemPrompt) builder.system(this.systemPrompt);
    if (this.routing) builder.providerRouting(this.routing);
    if (this.jsonTools) builder.tools(this.jsonTools);
    builder.messages(this.history);

    const response = await builder.query();
    if (response.content) {
      this.history.push({ role: "assistant", content: response.content });
    }
    return response;
  }

  stream(message: string): StreamResult {
    this.history.push({ role: "user", content: message });

    const builder = new AIBuilder(this.provider, this.modelId);
    if (this.systemPrompt) builder.system(this.systemPrompt);
    if (this.routing) builder.providerRouting(this.routing);
    if (this.jsonTools) builder.tools(this.jsonTools);
    builder.messages(this.history);

    const result = builder.stream();

    // Wrap the text stream to capture content for conversation history
    const self = this;
    let fullContent = "";
    const wrappedTextStream: AsyncIterableIterator<string> = {
      [Symbol.asyncIterator]() { return this; },
      async next() {
        const { done, value } = await result.textStream.next();
        if (done) {
          if (fullContent) {
            self.history.push({ role: "assistant", content: fullContent });
          }
          return { done: true, value: undefined };
        }
        fullContent += value;
        return { done: false, value };
      },
      async return(v?: unknown) {
        if (fullContent) {
          self.history.push({ role: "assistant", content: fullContent });
        }
        return result.textStream.return?.(v) ?? { done: true, value: undefined };
      },
    };

    return {
      textStream: wrappedTextStream,
      toolCalls: result.toolCalls,
      cancel: () => result.cancel(),
    };
  }

  getHistory(): Message[] {
    return [...this.history];
  }

  setHistory(messages: Message[]): this {
    this.history = [...messages];
    return this;
  }

  clear(): this {
    this.history = [];
    return this;
  }

  setSystem(prompt: string): this {
    this.systemPrompt = prompt;
    return this;
  }

  setProviderRouting(routing: ProviderRouting): this {
    this.routing = routing;
    return this;
  }

  /** Set JSON tools to forward to the provider (for native tool calling) */
  setJsonTools(tools: JsonTool[]): this {
    this.jsonTools = tools.length > 0 ? tools : undefined;
    return this;
  }

  /** Clear JSON tools */
  clearJsonTools(): this {
    this.jsonTools = undefined;
    return this;
  }

  /** Create a new conversation with the same provider/model but a fresh history */
  fork(systemPrompt: string): AIConversation {
    const forked = new AIConversation(this.provider, this.modelId, systemPrompt);
    if (this.routing) forked.setProviderRouting(this.routing);
    return forked;
  }
}
