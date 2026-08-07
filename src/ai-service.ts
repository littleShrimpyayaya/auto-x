import { getAiProvider } from './ai-config.js';
import type { AiGenerateRequest, AiGenerateResponse } from './types.js';

/**
 * AI 生成服务。
 * 支持两种 API 格式：
 *   - openai-compatible: POST {base}/chat/completions (OpenAI / DeepSeek / Grok…)
 *   - anthropic:          POST {base}/messages          (Anthropic / DeepSeek Anthropic…)
 * 所有调用均为无状态、无记忆——每次请求独立。
 */

const DEFAULT_SYSTEM_PROMPT =
  'You write short posts for X/Twitter. Reply with only the post text, no quotes or preamble. Stay under 240 characters so a short timestamp suffix can be added.';

const DEFAULT_TIMEOUT_MS = 30_000;

// ── OpenAI 兼容格式 ──────────────────────────────────

interface OpenAIChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface OpenAIChatRequest {
  model: string;
  messages: OpenAIChatMessage[];
  max_tokens?: number;
  temperature?: number;
}

interface OpenAIChatResponse {
  choices: Array<{ message: { content: string }; finish_reason: string }>;
  model: string;
  error?: { message: string; type: string };
}

async function callOpenAICompatible(
  baseUrl: string,
  apiKey: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
  maxTokens: number,
  temperature: number,
): Promise<AiGenerateResponse> {
  // 规范化 URL：去掉尾部斜杠
  let url = baseUrl.replace(/\/+$/, '');

  // 如果 URL 已经以 /chat/completions 结尾，直接使用
  if (url.endsWith('/chat/completions')) {
    // ok as-is
  }
  // 如果 URL 已经包含 /v1，直接拼接
  else if (url.includes('/v1')) {
    url += '/chat/completions';
  }
  // 否则追加 /v1/chat/completions
  else {
    url += '/v1/chat/completions';
  }

  const body: OpenAIChatRequest = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    max_tokens: maxTokens,
    temperature,
  };

  console.log(`[AI:openai] ${url} model=${model}`);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });

  const data = (await response.json()) as OpenAIChatResponse;

  if (!response.ok || data.error) {
    const errMsg = data.error?.message || `HTTP ${response.status}`;
    return { ok: false, error: errMsg };
  }

  const text = (data.choices?.[0]?.message?.content || '').trim();
  if (!text) {
    return { ok: false, error: 'AI 返回空内容' };
  }

  return { ok: true, text, model: data.model || model };
}

// ── Anthropic 兼容格式 ───────────────────────────────

interface AnthropicContentBlock {
  type: 'text';
  text: string;
}

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

interface AnthropicRequest {
  model: string;
  max_tokens: number;
  temperature?: number;
  system?: string;
  messages: AnthropicMessage[];
  thinking?: { type: 'disabled' } | { type: 'enabled'; budget_tokens: number };
}

interface AnthropicResponse {
  id: string;
  model: string;
  content: AnthropicContentBlock[];
  stop_reason: string;
  error?: { message: string; type: string };
}

async function callAnthropic(
  baseUrl: string,
  apiKey: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
  maxTokens: number,
  temperature: number,
): Promise<AiGenerateResponse> {
  // 规范化 URL
  let url = baseUrl.replace(/\/+$/, '');

  // 如果 URL 已经以 /messages 结尾，直接使用
  if (url.endsWith('/messages')) {
    // ok as-is
  }
  // 如果 URL 已经包含 /anthropic 或 /v1，直接拼接 /messages
  else if (url.includes('/anthropic') || url.includes('/v1')) {
    url += '/messages';
  }
  // 否则追加 /v1/messages
  else {
    url += '/v1/messages';
  }

  const body: AnthropicRequest = {
    model,
    max_tokens: maxTokens,
    temperature,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
    // 禁用 thinking 模式，确保直接返回文本（DeepSeek V4 等模型默认开思考）
    thinking: { type: 'disabled' },
  };

  console.log(`[AI:anthropic] ${url} model=${model}`);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });

  const rawText = await response.text();
  let data: AnthropicResponse;
  try {
    data = JSON.parse(rawText) as AnthropicResponse;
  } catch {
    console.error(`[AI:anthropic] 响应非 JSON (${response.status}):`, rawText.slice(0, 300));
    return { ok: false, error: `响应解析失败 (${response.status})` };
  }

  if (!response.ok || data.error) {
    const errMsg = data.error?.message || `HTTP ${response.status}`;
    console.error(`[AI:anthropic] API 错误 (${response.status}):`, errMsg, rawText.slice(0, 200));
    return { ok: false, error: errMsg };
  }

  console.log(`[AI:anthropic] 响应 content 数量: ${data.content?.length || 0}, stop_reason: ${data.stop_reason || '?'}`);

  // DeepSeek 等模型的 thinking 模式：跳过 thinking/redacted_thinking 块，取第一个 text 块
  const textBlock = data.content?.find((b: any) => b.type === 'text');
  const text = (textBlock?.text || '').trim();
  if (!text) {
    console.error(`[AI:anthropic] 无 text 块，content 类型: [${(data.content || []).map((b: any) => b.type).join(', ')}], 原始:`, rawText.slice(0, 400));
    return { ok: false, error: 'AI 返回空内容（模型可能处于思考模式，请增加 maxTokens 或关闭 thinking）' };
  }

  return { ok: true, text, model: data.model || model };
}

// ── 统一入口 ─────────────────────────────────────────

export async function generateTweetText(req: AiGenerateRequest): Promise<AiGenerateResponse> {
  const provider = getAiProvider(req.providerId);
  if (!provider) {
    return { ok: false, error: 'AI 供应商不存在' };
  }
  if (!provider.enabled) {
    return { ok: false, error: 'AI 供应商已禁用' };
  }
  if (!provider.apiKey) {
    return { ok: false, error: 'AI 供应商未配置 API Key' };
  }

  const model = req.model || provider.defaultModel;
  const systemPrompt = req.systemPrompt || DEFAULT_SYSTEM_PROMPT;
  const maxTokens = req.maxTokens || 200;
  const temperature = req.temperature ?? 0.8;

  try {
    if (provider.type === 'anthropic') {
      return await callAnthropic(
        provider.baseUrl, provider.apiKey, model, systemPrompt, req.prompt, maxTokens, temperature,
      );
    }
    // openai-compatible 或其他默认走 OpenAI 格式
    return await callOpenAICompatible(
      provider.baseUrl, provider.apiKey, model, systemPrompt, req.prompt, maxTokens, temperature,
    );
  } catch (err: any) {
    const msg = err.name === 'TimeoutError' ? '请求超时' : `网络错误: ${err.message}`;
    console.error(`[AI] ${msg}`);
    return { ok: false, error: msg };
  }
}

/**
 * 测试供应商连接：用简短 prompt 试调用一次。
 */
export async function testProviderConnection(
  providerId: string,
): Promise<{ ok: boolean; message: string }> {
  const result = await generateTweetText({
    providerId,
    prompt: 'Say "hello" in exactly one word.',
    maxTokens: 500,
    temperature: 0,
  });
  if (result.ok) {
    return { ok: true, message: `连接成功 (${result.model})` };
  }
  return { ok: false, message: result.error || '未知错误' };
}
