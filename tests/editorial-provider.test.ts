import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelError, ModelRunner, MockEditorialProvider, type AiProvider, type ModelLimits } from '../src/editorial/provider.ts';
import type { DraftOutput, GenerationRequest, Usage } from '../src/editorial/types.ts';

const request: GenerationRequest = {
  promptTemplateVersion: 'dayline-editorial-v1',
  systemInstructions: 'Extract only the explicitly supplied fictional evidence. Human review is required.',
  untrustedData: { evidence: [
    { id: 'evidence-one', claim: 'The fictional committee met on Tuesday.', support: ['source-one'], contradict: [], uncertainty: 'Attendance remains unconfirmed.' },
    { id: 'evidence-two', claim: 'The fictional vote was deferred.', support: ['source-two'], contradict: ['source-three'], uncertainty: 'Attendance remains unconfirmed.' },
  ] },
};
const usage: Usage = { inputTokens: 1, outputTokens: 1, estimatedCostMicros: 1 };
function provider(generate: AiProvider['generate'], enabled = true): AiProvider {
  return { id: 'fictional-provider', modelVersion: 'test-v1', enabled, generate };
}
function code(expected: string): (error: unknown) => boolean {
  return error => error instanceof ModelError && error.code === expected;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const good = () => ({ output: { fictional: true }, usage });

test('offline mock extracts exact claims, attribution and uncertainty deterministically', async () => {
  const runner = new ModelRunner(new MockEditorialProvider());
  const original = structuredClone(request);
  const first = await runner.run(request);
  const second = await runner.run(request);
  assert.deepEqual(request, original);
  assert.deepEqual(first, second);
  assert.equal(first.providerId, 'mock-editorial');
  assert.equal(first.modelVersion, 'extractive-v1');
  const output = first.output as DraftOutput;
  assert.equal(output.headline, request.untrustedData.evidence[0].claim);
  assert.equal(output.summary, request.untrustedData.evidence.map(item => item.claim).join(' '));
  assert.deepEqual(output.claims, request.untrustedData.evidence.map(item => ({ evidenceId: item.id, text: item.claim,
    supportingSourceIds: item.support, contradictingSourceIds: item.contradict })));
  assert.deepEqual(output.uncertainties, ['Attendance remains unconfirmed.']);
  assert.deepEqual(output.sections.map(section => section.kind), ['FACT', 'UNCERTAINTY', 'FACT', 'UNCERTAINTY']);
  assert.equal(first.usage.estimatedCostMicros, 1);
  assert.deepEqual(runner.snapshot(), { reservedCostMicros: 20, attempts: 2, proposals: 2, active: 0 });
});

test('disabled providers make no requests or reservations', async () => {
  let calls = 0;
  const runner = new ModelRunner(provider(async () => { calls++; return good(); }, false));
  await assert.rejects(runner.run(request), code('DISABLED'));
  await assert.rejects(new ModelRunner(new MockEditorialProvider(false)).run(request), code('DISABLED'));
  assert.equal(calls, 0);
  assert.deepEqual(runner.snapshot(), { reservedCostMicros: 0, attempts: 0, proposals: 0, active: 0 });
});

test('runner rejects unsafe configuration instead of silently relaxing limits', () => {
  const invalid: Partial<ModelLimits>[] = [
    { maxInputBytes: 1048577 }, { maxOutputBytes: 0 }, { maxProposals: 101 },
    { maxEstimatedCostMicros: Infinity }, { maxCostPerAttemptMicros: -1 },
    { maxAttempts: 4 }, { maxConcurrency: 5 }, { timeoutMs: 10001 }, { timeoutMs: 1.5 },
  ];
  for (const limits of invalid) assert.throws(() => new ModelRunner(provider(async () => good()), limits), code('INVALID_LIMITS'));
  assert.throws(() => new ModelRunner(provider(async () => good()), { unbounded: true } as Partial<ModelLimits>), code('INVALID_LIMITS'));
});

test('input byte boundaries and malformed non-JSON inputs fail before provider calls', async () => {
  let calls = 0;
  const make = () => provider(async () => { calls++; return good(); });
  const bytes = Buffer.byteLength(JSON.stringify(request), 'utf8');
  await assert.rejects(new ModelRunner(make(), { maxInputBytes: bytes - 1 }).run(request), code('INPUT_TOO_LARGE'));
  const circular: Record<string, unknown> = { ...request }; circular.self = circular;
  const invalid = [circular, { ...request, hidden: undefined }, { ...request, hidden: () => 'secret' },
    { ...request, hidden: 1n }, { ...request, hidden: new Date() }, { ...request, hidden: Number.NaN }, null,
    { ...request, untrustedData: { evidence: [] } }];
  for (const input of invalid) await assert.rejects(new ModelRunner(make()).run(input as unknown as GenerationRequest), code('INPUT_INVALID'));
  assert.equal(calls, 0);
  await new ModelRunner(make(), { maxInputBytes: bytes }).run(request);
  assert.equal(calls, 1);
});

test('output byte limits reject oversized or lossy output and keep attempt reservations', async () => {
  const output = { text: 'fictional' };
  const bytes = Buffer.byteLength(JSON.stringify(output), 'utf8');
  const exact = new ModelRunner(provider(async () => ({ output, usage })), { maxOutputBytes: bytes });
  assert.deepEqual((await exact.run(request)).output, output);
  const tooLarge = new ModelRunner(provider(async () => ({ output, usage })), { maxOutputBytes: bytes - 1 });
  await assert.rejects(tooLarge.run(request), code('OUTPUT_TOO_LARGE'));
  assert.equal(tooLarge.snapshot().attempts, 1);
  assert.equal(tooLarge.snapshot().reservedCostMicros, 10);
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  for (const malformed of [cyclic, undefined, { text: undefined }, { text: () => 'secret' }, { amount: Infinity }]) {
    const runner = new ModelRunner(provider(async () => ({ output: malformed, usage })));
    await assert.rejects(runner.run(request), code('OUTPUT_INVALID'));
    assert.equal(runner.snapshot().attempts, 1);
  }
});

test('usage requires bounded integral token counts and cannot exceed reserved attempt cost', async () => {
  const invalid = [
    { ...usage, inputTokens: -1 }, { ...usage, inputTokens: 0.5 }, { ...usage, outputTokens: Infinity },
    { ...usage, outputTokens: 1048577 }, { ...usage, estimatedCostMicros: 11 },
    { ...usage, estimatedCostMicros: Number.NaN }, { inputTokens: 1, outputTokens: 1 },
  ];
  for (const accounting of invalid) {
    const runner = new ModelRunner(provider(async () => ({ output: {}, usage: accounting as Usage })));
    await assert.rejects(runner.run(request), code('USAGE_INVALID'));
    assert.equal(runner.snapshot().reservedCostMicros, 10);
  }
  const changing = Object.defineProperty({ ...usage }, 'estimatedCostMicros', { get() { throw Error('SECRET_USAGE_GETTER'); }, enumerable: true });
  await assert.rejects(new ModelRunner(provider(async () => ({ output: {}, usage: changing }))).run(request), code('USAGE_INVALID'));
});

test('only explicit transient model errors retry and every retry reserves bounded cost', async () => {
  let calls = 0;
  const runner = new ModelRunner(provider(async input => {
    calls++;
    assert.equal(input.untrustedData.evidence[0].claim, request.untrustedData.evidence[0].claim);
    if (calls === 1) { input.untrustedData.evidence[0].claim = 'Provider mutation'; throw new ModelError('TRANSIENT'); }
    return good();
  }));
  await runner.run(request);
  assert.equal(calls, 2);
  assert.deepEqual(runner.snapshot(), { reservedCostMicros: 20, attempts: 2, proposals: 1, active: 0 });
  assert.notEqual(request.untrustedData.evidence[0].claim, 'Provider mutation');
});

test('retry exhaustion and aggregate cost reservations stop additional provider calls', async () => {
  let calls = 0;
  const alwaysTransient = () => provider(async () => { calls++; throw new ModelError('TRANSIENT'); });
  const attempts = new ModelRunner(alwaysTransient(), { maxAttempts: 3 });
  await assert.rejects(attempts.run(request), code('TRANSIENT'));
  assert.equal(calls, 3);
  assert.equal(attempts.snapshot().reservedCostMicros, 30);
  calls = 0;
  const cost = new ModelRunner(alwaysTransient(), { maxEstimatedCostMicros: 10, maxAttempts: 3 });
  await assert.rejects(cost.run(request), code('BUDGET_EXCEEDED'));
  await assert.rejects(cost.run(request), code('BUDGET_EXCEEDED'));
  assert.equal(calls, 1);
  assert.deepEqual(cost.snapshot(), { reservedCostMicros: 10, attempts: 1, proposals: 1, active: 0 });
});

test('failed and invalid proposals consume proposal and cost limits without retry', async () => {
  let calls = 0;
  const runner = new ModelRunner(provider(async () => { calls++; return { output: undefined, usage }; }), { maxProposals: 2 });
  await assert.rejects(runner.run(request), code('OUTPUT_INVALID'));
  await assert.rejects(runner.run(request), code('OUTPUT_INVALID'));
  await assert.rejects(runner.run(request), code('PROPOSAL_LIMIT'));
  assert.equal(calls, 2);
  assert.deepEqual(runner.snapshot(), { reservedCostMicros: 20, attempts: 2, proposals: 2, active: 0 });
});

test('cancellation before execution makes no calls or reservations', async () => {
  let calls = 0;
  const controller = new AbortController(); controller.abort('SECRET_ABORT_REASON');
  const runner = new ModelRunner(provider(async () => { calls++; return good(); }));
  await assert.rejects(runner.run(request, controller.signal), code('CANCELLED'));
  assert.equal(calls, 0);
  assert.equal(runner.snapshot().proposals, 0);
});

test('cancellation drains listeners while an ignoring provider retains its concurrency slot until settling', async () => {
  const work = deferred<ReturnType<typeof good>>();
  let received!: AbortSignal; let calls = 0;
  const runner = new ModelRunner(provider(async (_request, signal) => { received = signal; calls++; return work.promise; }));
  const controller = new AbortController();
  const running = runner.run(request, controller.signal);
  controller.abort('SECRET_ABORT_REASON');
  await assert.rejects(running, code('CANCELLED'));
  assert.equal(received.aborted, true);
  assert.equal(runner.snapshot().active, 1);
  await assert.rejects(runner.run(request), code('CONCURRENCY_LIMIT'));
  assert.equal(calls, 1);
  work.resolve(good()); await work.promise; await Promise.resolve();
  assert.equal(runner.snapshot().active, 0);
});

test('timeout aborts provider work, reserves its cost, and prevents ignored-abort background accumulation', async () => {
  const work = deferred<ReturnType<typeof good>>();
  let received!: AbortSignal; let calls = 0;
  const runner = new ModelRunner(provider(async (_request, signal) => { received = signal; calls++; return work.promise; }), { timeoutMs: 5 });
  await assert.rejects(runner.run(request), code('TIMEOUT'));
  assert.equal(received.aborted, true);
  assert.deepEqual(runner.snapshot(), { reservedCostMicros: 10, attempts: 1, proposals: 1, active: 1 });
  await assert.rejects(runner.run(request), code('CONCURRENCY_LIMIT'));
  work.reject(Error('SECRET_LATE_PROVIDER_ERROR')); await work.promise.catch(() => {}); await Promise.resolve();
  assert.equal(runner.snapshot().active, 0);
  assert.equal(calls, 1);
});

test('bounded concurrent calls are admitted together and a third cannot start', async () => {
  const work = deferred<ReturnType<typeof good>>();
  let calls = 0;
  const runner = new ModelRunner(provider(async () => { calls++; return work.promise; }), { maxConcurrency: 2 });
  const one = runner.run(request); const two = runner.run(request);
  await assert.rejects(runner.run(request), code('CONCURRENCY_LIMIT'));
  assert.equal(calls, 2); assert.equal(runner.snapshot().active, 2);
  work.resolve(good()); await Promise.all([one, two]);
  assert.equal(runner.snapshot().active, 0);
});

test('raw provider errors and spoofed retry errors are sanitized without leaking input or credentials', async () => {
  const accessorError = Object.defineProperty(new ModelError('TRANSIENT'), 'code', { get() { throw Error('SECRET_ERROR_GETTER'); } });
  for (const failure of [Error('SECRET_API_KEY raw response body'), { code: 'TRANSIENT', message: 'SECRET_PROVIDER_DETAIL' }, accessorError]) {
    let calls = 0;
    const runner = new ModelRunner(provider(async () => { calls++; throw failure; }));
    await assert.rejects(runner.run(request), error => {
      assert.ok(error instanceof ModelError); assert.equal(error.code, 'PROVIDER_FAILURE');
      assert.doesNotMatch(String(error), /SECRET|response body|Tuesday/);
      assert.equal(Object.hasOwn(error, 'cause'), false); return true;
    });
    assert.equal(calls, 1);
  }
});
