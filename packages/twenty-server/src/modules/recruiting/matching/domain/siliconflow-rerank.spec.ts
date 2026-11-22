/** Covers the documented SiliconFlow rerank contract without calling the network. */
import {
  RERANK_INSTRUCTION,
  RerankCallError,
  RerankPayloadTooLargeError,
  SILICONFLOW_RERANK_MODEL,
  SiliconflowRerankClient,
  bindRerankResponse,
  buildRerankRequest,
  readRelevanceScore,
} from './siliconflow-rerank';

const documents = ['候选人甲的项目经历', '候选人乙的项目经历'];

describe('siliconflow rerank contract', () => {
  it('sends the real model, instruction and every document', () => {
    const body = JSON.parse(buildRerankRequest('岗位要求全文', documents));
    expect(body).toEqual({
      model: SILICONFLOW_RERANK_MODEL,
      query: '岗位要求全文',
      documents,
      instruction: RERANK_INSTRUCTION,
      top_n: 2,
      return_documents: true,
    });
    expect(body.max_chunks_per_doc).toBeUndefined();
    expect(body.overlap_tokens).toBeUndefined();
    expect(body.instruction).toContain('不是0到4档能力分');
  });

  it('refuses to slice a request that exceeds the transport limit', () => {
    expect(() => buildRerankRequest('岗位', ['证据'.repeat(400_000)])).toThrow(
      RerankPayloadTooLargeError,
    );
  });

  it('keeps a reversed result on the person whose text was echoed', () => {
    const bound = bindRerankResponse(documents, {
      id: 'req',
      results: [
        { index: 1, relevance_score: 0.25, document: { text: documents[1] } },
        { index: 0, relevance_score: 0.91, document: { text: documents[0] } },
      ],
      meta: { tokens: { input_tokens: 20, output_tokens: 2 } },
    });
    expect(bound.assignments.get(0)?.relevanceScore).toBe(0.91);
    expect(bound.assignments.get(1)?.relevanceScore).toBe(0.25);
    expect(bound.usage).toEqual({ inputTokens: 20, outputTokens: 2 });
  });

  it('rejects a swapped document, a duplicate index, an empty body and an illegal score', () => {
    const swapped = bindRerankResponse(documents, {
      results: [
        { index: 0, relevance_score: 0.9, document: { text: documents[1] } },
      ],
    });
    expect(swapped.assignments.size).toBe(0);
    expect(swapped.failures.get(0)).toContain('不一致');
    expect(swapped.failures.get(1)).toContain('缺少');
    const duplicate = bindRerankResponse([documents[0]], {
      results: [
        { index: 0, relevance_score: 0.9, document: { text: documents[0] } },
        { index: 0, relevance_score: 0.1, document: { text: documents[0] } },
      ],
    });
    expect(duplicate.assignments.size).toBe(0);
    expect(duplicate.failures.get(0)).toContain('重复');

    const empty = bindRerankResponse(documents, { results: [] });
    expect(
      [...empty.failures.values()].every((message) => message.includes('没有')),
    ).toBe(true);
    expect(empty.assignments.size).toBe(0);

    const illegal = bindRerankResponse([documents[0]], {
      results: [
        { index: 0, relevance_score: 4, document: { text: documents[0] } },
      ],
    });
    expect(illegal.assignments.size).toBe(0);
    expect(illegal.failures.get(0)).toContain('无效');
    expect(readRelevanceScore(Number.NaN)).toBeUndefined();
    expect(readRelevanceScore(0)).toBe(0);
    expect(readRelevanceScore(1)).toBe(1);
  });
});

describe('siliconflow rerank client', () => {
  const transportFor = (responses: { status: number; body: string }[]) => {
    const calls: { body: string; headers: Record<string, string> }[] = [];
    const sleeps: number[] = [];
    const transport = jest.fn(
      async (input: { body: string; headers: Record<string, string> }) => {
        calls.push(input);
        const next = responses.shift();
        if (!next) throw new Error('abort');
        return next;
      },
    );
    const client = new SiliconflowRerankClient({
      transport,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      env: { SILICONFLOW_API_KEY: 'test-key' },
      maxRetries: 2,
    });
    return { client, calls, sleeps, transport };
  };

  const ok = JSON.stringify({
    results: [
      { index: 0, relevance_score: 0.4, document: { text: documents[0] } },
    ],
  });

  it('does not send a request when the key is missing', async () => {
    const transport = jest.fn();
    const client = new SiliconflowRerankClient({
      transport,
      env: {},
    });
    await expect(client.rerank('岗位', [documents[0]])).rejects.toMatchObject({
      kind: 'auth',
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it('retries a rate limit and then a timeout before succeeding', async () => {
    const { client, calls, sleeps } = transportFor([
      { status: 429, body: 'TPM limit reached secret' },
      { status: 504, body: 'timeout' },
      { status: 200, body: ok },
    ]);
    const bound = await client.rerank('岗位', [documents[0]]);
    expect(bound.assignments.get(0)?.relevanceScore).toBe(0.4);
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([200, 800]);
    expect(calls[0].headers.Authorization).toBe('Bearer test-key');
    expect(JSON.parse(calls[0].body).documents[0]).toBe(documents[0]);
  });

  it('stops on authorization and does not include the response body in the error', async () => {
    const { client, transport } = transportFor([
      { status: 401, body: 'bad secret token' },
    ]);
    const error = await client.rerank('岗位', [documents[0]]).then(
      () => {
        throw new Error('expected rejection');
      },
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(RerankCallError);
    expect(error).toMatchObject({ kind: 'auth' });
    expect(String(error)).not.toContain('secret');
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('does not retry an illegal request or a context rejection', async () => {
    const rejected = transportFor([{ status: 400, body: 'schema invalid' }]);
    await expect(
      rejected.client.rerank('岗位', [documents[0]]),
    ).rejects.toMatchObject({
      kind: 'rejected',
    });
    expect(rejected.transport).toHaveBeenCalledTimes(1);
    const context = transportFor([
      { status: 400, body: 'context_length_exceeded: private resume' },
    ]);
    await expect(
      context.client.rerank('岗位', [documents[0]]),
    ).rejects.toMatchObject({
      kind: 'context',
    });
    expect(context.transport).toHaveBeenCalledTimes(1);
  });

  it('gives up after the retry budget without turning the failure into a score', async () => {
    const { client, transport } = transportFor([
      { status: 503, body: 'overloaded' },
      { status: 503, body: 'overloaded' },
      { status: 503, body: 'overloaded' },
    ]);
    await expect(client.rerank('岗位', [documents[0]])).rejects.toMatchObject({
      kind: 'unavailable',
    });
    expect(transport).toHaveBeenCalledTimes(3);
  });
});
