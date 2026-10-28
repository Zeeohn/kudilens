// Meta Model API client (https://api.meta.ai/v1), built on fetch with no SDK.
// Muse Spark reads images and audio and answers in strict JSON; SAM 3.1 finds objects;
// Muse Voice Transcribe turns speech to text; Muse Image makes pictures.

export const MODELS = {
  reason: 'muse-spark-1.3', // vision, extraction, the agent
  audio: 'muse-spark-1.2', // Meta recommends 1.2 for audio input
  wonder: 'muse-wonder-1.0', // long-horizon work (month-end close)
  sam: 'sam-3.1',
  image: 'muse-image-1.0',
  transcribe: 'muse-voice-transcribe-1.0',
} as const;

export type Effort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentPart[] | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'input_audio'; input_audio: { data: string; format: 'wav' | 'mp3' } };

export interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
export interface ToolDef { type: 'function'; function: { name: string; description: string; parameters: object } }

export interface Usage { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }

export class MetaError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(message: string, status: number, body: string) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export interface MetaOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  retries?: number;
  fetchImpl?: typeof fetch;
  /** Called after every request with the model, kind, latency and usage, for cost tracking. */
  onUsage?: (u: { model: string; kind: string; ms: number; usage?: Usage; units?: number }) => void;
}

export class Meta {
  private readonly opts: MetaOptions;
  private readonly base: string;
  private readonly f: typeof fetch;

  constructor(opts: MetaOptions) {
    this.opts = opts;
    this.base = (opts.baseUrl ?? 'https://api.meta.ai/v1').replace(/\/$/, '');
    this.f = opts.fetchImpl ?? fetch;
  }

  // ------------------------------------------------------------------ transport

  private async request(path: string, init: RequestInit, kind: string, model: string): Promise<Response> {
    const retries = this.opts.retries ?? 4;
    let delay = 500;
    for (let attempt = 0; ; attempt++) {
      const started = Date.now();
      let res: Response;
      try {
        res = await this.f(`${this.base}${path}`, {
          ...init,
          headers: { Authorization: `Bearer ${this.opts.apiKey}`, ...(init.headers ?? {}) },
          signal: AbortSignal.timeout(this.opts.timeoutMs ?? 120_000),
        });
      } catch (err) {
        if (attempt >= retries) throw err;
        await sleep(jitter(delay));
        delay *= 2;
        continue;
      }
      if (res.ok) {
        this.opts.onUsage?.({ model, kind, ms: Date.now() - started });
        return res;
      }
      const body = await res.text();
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= retries) {
        throw new MetaError(`${kind} failed: HTTP ${res.status} ${body.slice(0, 300)}`, res.status, body);
      }
      const after = Number(res.headers.get('retry-after'));
      await sleep(Number.isFinite(after) && after > 0 ? after * 1000 : jitter(delay));
      delay *= 2;
    }
  }

  private async json<T>(path: string, body: unknown, kind: string, model: string): Promise<T> {
    const res = await this.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, kind, model);
    return (await res.json()) as T;
  }

  // ------------------------------------------------------------------ chat

  async chat(req: {
    model?: string;
    messages: ChatMessage[];
    tools?: ToolDef[];
    schema?: { name: string; schema: object };
    effort?: Effort;
    maxTokens?: number;
  }): Promise<{ message: ChatMessage; usage?: Usage; finish: string }> {
    const model = req.model ?? MODELS.reason;
    const body: Record<string, unknown> = {
      model,
      messages: req.messages,
      max_tokens: req.maxTokens ?? 8000, // reasoning shares this budget; too small returns empty text
    };
    if (req.effort) body.reasoning_effort = req.effort;
    if (req.tools?.length) body.tools = req.tools;
    if (req.schema) body.response_format = { type: 'json_schema', json_schema: { name: req.schema.name, schema: req.schema.schema, strict: true } };
    const r = await this.json<any>('/chat/completions', body, 'chat', model);
    const choice = r.choices?.[0];
    if (!choice) throw new MetaError('chat returned no choices', 200, JSON.stringify(r).slice(0, 300));
    this.opts.onUsage?.({ model, kind: 'chat.tokens', ms: 0, usage: r.usage });
    return { message: choice.message, usage: r.usage, finish: choice.finish_reason };
  }

  /** Ask for JSON that matches `schema`; decoding is constrained, so it always parses. */
  async structured<T>(req: { model?: string; system: string; parts: ContentPart[]; name: string; schema: object; effort?: Effort }): Promise<T> {
    const { message, finish } = await this.chat({
      model: req.model,
      effort: req.effort ?? 'medium',
      schema: { name: req.name, schema: req.schema },
      messages: [{ role: 'system', content: req.system }, { role: 'user', content: req.parts }],
    });
    const text = typeof message.content === 'string' ? message.content : '';
    if (!text) throw new MetaError(`empty structured output (finish: ${finish})`, 200, '');
    return JSON.parse(text) as T;
  }

  // ------------------------------------------------------------------ speech

  /** Muse Voice Transcribe. Audio must be mono 16-bit PCM WAV at 16 or 24 kHz. */
  async transcribe(wav: Uint8Array, opts: { languageBias?: string[]; keywords?: string[] } = {}): Promise<{ transcript: string; durationMs: number }> {
    const form = new FormData();
    const settings = { model: MODELS.transcribe, mode: 'PUSH_TO_TALK', audioEncoding: 'WAV', ...opts };
    form.append('request', new Blob([JSON.stringify(settings)], { type: 'application/json' }));
    form.append('audio', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
    const res = await this.request('/asr/transcribe', { method: 'POST', body: form, headers: { Accept: 'application/json' } }, 'transcribe', MODELS.transcribe);
    const r = (await res.json()) as any;
    return { transcript: r.transcript ?? '', durationMs: r.audioDurationMs ?? 0 };
  }

  // ------------------------------------------------------------------ SAM 3.1

  /** Every instance of `concept` in the image, as pixel boxes with confidence. */
  async segment(image: { bytes: Uint8Array; mime: string }, concept: string): Promise<SamResult> {
    const r = await this.json<any>('/responses', {
      model: MODELS.sam,
      input: [{
        type: 'message', role: 'user', content: [
          { type: 'input_text', text: concept },
          { type: 'input_image', image_url: dataUrl(image.bytes, image.mime) },
        ],
      }],
      metadata: { include_confidence: 'true', mask_encoding: 'one_bit' },
    }, 'segment', MODELS.sam);
    return parseSam(outputText(r));
  }

  // ------------------------------------------------------------------ Muse Image

  async generateImage(prompt: string, size = '1024x1536'): Promise<Uint8Array> {
    const r = await this.json<any>('/images/generations', {
      model: MODELS.image, prompt, n: 1, size, output_format: 'png',
    }, 'image', MODELS.image);
    const b64 = r.data?.[0]?.b64_json;
    if (!b64) throw new MetaError('image generation returned no image', 200, JSON.stringify(r).slice(0, 300));
    return Buffer.from(b64, 'base64');
  }
}

// -------------------------------------------------------------------- helpers

export interface SamBox { id: number; x1: number; y1: number; x2: number; y2: number; confidence: number | null }
export interface SamResult { width: number; height: number; boxes: SamBox[] }

/** Parse SAM's special-token text. Only boxes are needed here, so masks are skipped. */
export function parseSam(text: string): SamResult {
  const boxes: SamBox[] = [];
  let width = 0;
  let height = 0;
  const re = /(?:^|,|>)(\d+)<\|box;([^|]*)\|>/g;
  for (const m of text.matchAll(re)) {
    const f = Object.fromEntries(m[2].split(';').map((kv) => kv.split('=') as [string, string]));
    width = Number(f.w);
    height = Number(f.h);
    boxes.push({
      id: Number(m[1]), x1: Number(f.x1), y1: Number(f.y1), x2: Number(f.x2), y2: Number(f.y2),
      confidence: f.c !== undefined ? Number(f.c) : null,
    });
  }
  return { width, height, boxes };
}

/** The text output of a non-streaming Responses API call. */
export function outputText(r: any): string {
  if (typeof r?.output_text === 'string') return r.output_text;
  const parts: string[] = [];
  for (const item of r?.output ?? []) {
    for (const c of item?.content ?? []) if (typeof c?.text === 'string') parts.push(c.text);
  }
  return parts.join('');
}

export function dataUrl(bytes: Uint8Array, mime: string): string {
  return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
}

export const imagePart = (bytes: Uint8Array, mime: string): ContentPart => ({ type: 'image_url', image_url: { url: dataUrl(bytes, mime) } });
export const audioPart = (wav: Uint8Array): ContentPart => ({ type: 'input_audio', input_audio: { data: Buffer.from(wav).toString('base64'), format: 'wav' } });
export const textPart = (text: string): ContentPart => ({ type: 'text', text });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jitter = (ms: number) => ms / 2 + Math.random() * ms;
