export interface InternalMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: ContentBlock[];
}

export type ContentBlock =
  | TextBlock
  | ImageBlock
  | ToolUseBlock
  | ToolResultBlock;

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ImageBlock {
  type: 'image';
  // source 支持 base64 与 url 两形态:url 形态承载客户端的 http(s) 图片 URL,
  // 不在网关侧下载(Anthropic source.type:'url' 与 OpenAI Responses input_image
  // 的 http URL 均由上游原生支持)。跨族时由 src/utils/image-block.ts 在两端协议
  // 间互转(base64 ↔ data: URI)。
  source:
    | { type: 'base64'; media_type: string; data: string }
    | { type: 'url'; url: string };
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string | ContentBlock[];
}

export interface InternalRequest {
  model: string;
  messages: InternalMessage[];
  parameters: {
    maxTokens?: number;
    temperature?: number;
    topP?: number;
    stop?: string[];
    tools?: Tool[];
    stream?: boolean;
    // Reasoning config (OpenAI Responses API): {summary:'auto'} enables streaming
    // reasoning summary. Absent for non-reasoning models / other providers.
    reasoning?: { summary?: 'auto' | 'concise' | 'detailed'; effort?: string };
  };
  passthrough?: Record<string, unknown>;
}

export interface Tool {
  name: string;
  description?: string;
  input_schema: unknown;
}

export interface InternalResponse {
  id: string;
  model: string;
  content: ContentBlock[];
  stopReason?: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use';
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    // Anthropic prompt-cache breakdown (absent for OpenAI/DashScope, whose
    // prompt_tokens already includes cached). promptTokens is the NON-cached
    // input for Anthropic; totalTokens already folds cache in.
    cacheRead?: number;
    cacheCreation?: number;
  };
}

export interface InternalStreamChunk {
  type: 'content' | 'usage' | 'stop' | 'error' | 'reasoning' | 'tool_call';
  content?: ContentBlock;
  // Reasoning/thinking delta text (e.g. OpenAI's response.reasoning_summary_text.delta).
  // Pure-display — never enters textBuf or usage accumulation.
  reasoning?: string;
  usage?: InternalResponse['usage'];
  stopReason?: InternalResponse['stopReason'];
  error?: string;
  // A complete tool call surfaced during streaming, normalized across providers
  // so routes/bridges handle one shape. OpenAI/DashScope emit it from Responses'
  // response.output_item.done (function_call); Anthropic emits it at
  // content_block_stop after accumulating input_json_delta fragments (tool_use).
  // Lets streaming-only callers (GatewayModel) assemble the authoritative output
  // — text + tool_calls — from stream chunks alone, without a non-streamed
  // backfill. The /anthropic/v1/messages route consumes it to synthesize a
  // tool_use content_block; the two openai routes and GatewayModel consume it
  // as before (openai routes synthesize tool_calls/function_call items).
  toolCall?: { id: string; name: string; input: unknown };
}
