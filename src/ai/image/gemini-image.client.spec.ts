import {GenerateContentResponse} from '@google/genai';
import {parseThinkingLevel, readImageResponse} from './gemini-image.client';

const PNG = Buffer.from('fake-png-bytes');

function response(partial: Record<string, unknown>): GenerateContentResponse {
  return partial as unknown as GenerateContentResponse;
}

describe('readImageResponse', () => {
  it('takes the last non-thought image and splits the usage by modality', () => {
    const res = readImageResponse(
      response({
        candidates: [
          {
            finishReason: 'STOP',
            content: {
              parts: [
                {
                  thought: true,
                  inlineData: {mimeType: 'image/png', data: 'AAAA'},
                },
                {
                  inlineData: {
                    mimeType: 'image/png',
                    data: PNG.toString('base64'),
                  },
                },
              ],
            },
          },
        ],
        usageMetadata: {
          promptTokenCount: 900,
          candidatesTokenCount: 1180,
          thoughtsTokenCount: 400,
          candidatesTokensDetails: [
            {modality: 'IMAGE', tokenCount: 1120},
            {modality: 'TEXT', tokenCount: 60},
          ],
        },
      }),
    );
    expect(res.image?.equals(PNG)).toBe(true);
    expect(res.mimeType).toBe('image/png');
    expect(res.finishReason).toBe('STOP');
    expect(res.usage).toEqual({
      inputTokens: 900,
      imageTokens: 1120,
      textTokens: 60 + 400,
    });
  });

  it('assumes a 1K image when the breakdown is missing', () => {
    const res = readImageResponse(
      response({
        candidates: [
          {
            content: {
              parts: [{inlineData: {mimeType: 'image/jpeg', data: 'AAAA'}}],
            },
          },
        ],
        usageMetadata: {promptTokenCount: 10, candidatesTokenCount: 1120},
      }),
    );
    expect(res.usage.imageTokens).toBe(1120);
    expect(res.usage.textTokens).toBe(0);
  });

  it('reports a refusal with no picture and no image tokens', () => {
    const res = readImageResponse(
      response({
        candidates: [{finishReason: 'IMAGE_SAFETY', content: {parts: []}}],
        usageMetadata: {promptTokenCount: 700, candidatesTokenCount: 0},
      }),
    );
    expect(res.image).toBeNull();
    expect(res.finishReason).toBe('IMAGE_SAFETY');
    expect(res.usage).toEqual({
      inputTokens: 700,
      imageTokens: 0,
      textTokens: 0,
    });
  });

  it('surfaces a blocked prompt', () => {
    const res = readImageResponse(
      response({promptFeedback: {blockReason: 'PROHIBITED_CONTENT'}}),
    );
    expect(res.image).toBeNull();
    expect(res.blockReason).toBe('PROHIBITED_CONTENT');
  });
});

describe('parseThinkingLevel', () => {
  it('maps the env spelling and ignores anything else', () => {
    expect(parseThinkingLevel('minimal')).toBe('MINIMAL');
    expect(parseThinkingLevel(' Medium ')).toBe('MEDIUM');
    expect(parseThinkingLevel('turbo')).toBeUndefined();
    expect(parseThinkingLevel(undefined)).toBeUndefined();
  });
});
