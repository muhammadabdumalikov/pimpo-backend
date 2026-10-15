import {
  GenerateContentResponse,
  GoogleGenAI,
  Modality,
  Part,
  ThinkingLevel,
} from '@google/genai';
import {IMAGE_TOKENS_1K, ImageCallUsage} from './ai-image.pricing';

/** A photo handed to the model, as bytes — it is never uploaded anywhere. */
export interface InlinePhoto {
  data: Buffer;
  mimeType: string;
}

export interface DescribeResult {
  text: string;
  inputTokens: number;
  /** Text plus thinking. */
  outputTokens: number;
}

export interface ImageResult {
  /** Null when the model answered without a picture (refusal, NO_IMAGE…). */
  image: Buffer | null;
  mimeType: string | null;
  /** The candidate's finish reason, e.g. STOP, IMAGE_SAFETY, NO_IMAGE. */
  finishReason: string | null;
  /** The prompt was refused before generation (promptFeedback.blockReason). */
  blockReason: string | null;
  usage: ImageCallUsage;
}

const THINKING_LEVELS: Record<string, ThinkingLevel> = {
  minimal: ThinkingLevel.MINIMAL,
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  high: ThinkingLevel.HIGH,
};

/** 'minimal' | 'low' | 'medium' | 'high'; anything else = the model's default. */
export function parseThinkingLevel(
  raw: string | undefined,
): ThinkingLevel | undefined {
  return raw ? THINKING_LEVELS[raw.trim().toLowerCase()] : undefined;
}

/**
 * The two Gemini calls behind AI product images, on Pimpo's own key.
 *
 * `generateContent`, not the newer Interactions API: Interactions stores every
 * request (55 days on paid) unless told otherwise, and the shop's photo must
 * not outlive the request (AI-RASM.md). Kept apart from the BYOK GeminiProvider
 * on purpose — that one spends the shop's key, this one spends ours.
 */
export class GeminiImageClient {
  constructor(private readonly ai: GoogleGenAI) {}

  static fromKey(apiKey: string): GeminiImageClient {
    return new GeminiImageClient(new GoogleGenAI({apiKey}));
  }

  /** The cheap text step: drafts the English packaging description. */
  async describe(opts: {
    model: string;
    system: string;
    instruction: string;
    photo?: InlinePhoto;
    signal?: AbortSignal;
  }): Promise<DescribeResult> {
    const parts: Part[] = [];
    if (opts.photo) parts.push(inline(opts.photo));
    parts.push({text: opts.instruction});

    const res = await this.ai.models.generateContent({
      model: opts.model,
      contents: [{role: 'user', parts}],
      config: {
        systemInstruction: opts.system,
        // Generous for a 45-word answer: on the Gemini 3 line this budget is
        // shared with thinking, and a tight one comes back empty.
        maxOutputTokens: 1024,
        abortSignal: opts.signal,
      },
    });

    const usage = res.usageMetadata;
    return {
      text: res.text ?? '',
      inputTokens: usage?.promptTokenCount ?? 0,
      outputTokens:
        (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0),
    };
  }

  /** One 1:1, 1K packshot. The photo, when given, goes before the prompt. */
  async generate(opts: {
    model: string;
    prompt: string;
    photo?: InlinePhoto;
    thinkingLevel?: ThinkingLevel;
    signal?: AbortSignal;
  }): Promise<ImageResult> {
    const parts: Part[] = [];
    if (opts.photo) parts.push(inline(opts.photo));
    parts.push({text: opts.prompt});

    const res = await this.ai.models.generateContent({
      model: opts.model,
      contents: [{role: 'user', parts}],
      config: {
        responseModalities: [Modality.IMAGE],
        imageConfig: {aspectRatio: '1:1', imageSize: '1K'},
        ...(opts.thinkingLevel
          ? {thinkingConfig: {thinkingLevel: opts.thinkingLevel}}
          : {}),
        abortSignal: opts.signal,
      },
    });

    return readImageResponse(res);
  }
}

function inline(photo: InlinePhoto): Part {
  return {
    inlineData: {mimeType: photo.mimeType, data: photo.data.toString('base64')},
  };
}

/** Picks the picture out of a response and prices what it consumed. */
export function readImageResponse(res: GenerateContentResponse): ImageResult {
  const candidate = res.candidates?.[0];
  // Thought parts can carry interim images; the answer is the last real one.
  const part = (candidate?.content?.parts ?? [])
    .filter((p) => p.inlineData?.data && !p.thought)
    .pop();

  const image = part?.inlineData?.data
    ? Buffer.from(part.inlineData.data, 'base64')
    : null;

  const usage = res.usageMetadata;
  const candidates = usage?.candidatesTokenCount ?? 0;
  const thinking = usage?.thoughtsTokenCount ?? 0;
  const details = usage?.candidatesTokensDetails;
  let imageTokens = 0;
  if (details?.length) {
    imageTokens = details
      .filter((d) => String(d.modality) === 'IMAGE')
      .reduce((sum, d) => sum + (d.tokenCount ?? 0), 0);
  } else if (image) {
    // No breakdown: a 1K picture is a fixed 1120 tokens; the rest is text.
    imageTokens = Math.min(candidates, IMAGE_TOKENS_1K) || IMAGE_TOKENS_1K;
  }

  return {
    image,
    mimeType: part?.inlineData?.mimeType ?? null,
    finishReason: candidate?.finishReason
      ? String(candidate.finishReason)
      : null,
    blockReason: res.promptFeedback?.blockReason
      ? String(res.promptFeedback.blockReason)
      : null,
    usage: {
      inputTokens: usage?.promptTokenCount ?? 0,
      imageTokens,
      textTokens: Math.max(0, candidates - imageTokens) + thinking,
    },
  };
}
