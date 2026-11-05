import type { DraftOutput, GenerationRequest, Usage } from './types.ts';

export interface AiProvider {
  id: string;
  modelVersion: string;
  enabled: boolean;
  generate(request: GenerationRequest, signal: AbortSignal): Promise<{ output: unknown; usage: Usage }>;
}

export interface ModelLimits {
  maxInputBytes: number;
  maxOutputBytes: number;
  maxProposals: number;
  maxEstimatedCostMicros: number;
  maxCostPerAttemptMicros: number;
  maxAttempts: number;
  maxConcurrency: number;
  timeoutMs: number;
}

const messages = Object.freeze({
  TRANSIENT: 'Temporary model provider failure',
  DISABLED: 'Model provider is disabled',
  INVALID_LIMITS: 'Invalid model runner configuration',
  INPUT_INVALID: 'Invalid model input',
  INPUT_TOO_LARGE: 'Model input exceeds its byte limit',
  OUTPUT_INVALID: 'Invalid model output',
  OUTPUT_TOO_LARGE: 'Model output exceeds its byte limit',
  USAGE_INVALID: 'Invalid model usage accounting',
  BUDGET_EXCEEDED: 'Model cost reservation limit reached',
  PROPOSAL_LIMIT: 'Model proposal limit reached',
  CONCURRENCY_LIMIT: 'Model concurrency limit reached',
  CANCELLED: 'Model request cancelled',
  TIMEOUT: 'Model request timed out',
  PROVIDER_FAILURE: 'Model provider failed',
});

export type ModelErrorCode = keyof typeof messages;

/** Codes and messages never contain provider exceptions, prompts or credentials. */
export class ModelError extends Error {
  readonly code: ModelErrorCode;
  readonly transient: boolean;
  constructor(code: ModelErrorCode) {
    const safe = typeof code === 'string' && Object.hasOwn(messages, code) ? code : 'PROVIDER_FAILURE';
    super(messages[safe]);
    this.name = 'ModelError'; this.code = safe; this.transient = safe === 'TRANSIENT';
  }
}

const defaults: Readonly<ModelLimits> = Object.freeze({
  maxInputBytes: 16384, maxOutputBytes: 16384, maxProposals: 5,
  maxEstimatedCostMicros: 1000, maxCostPerAttemptMicros: 10,
  maxAttempts: 2, maxConcurrency: 1, timeoutMs: 1000,
});
const maximums: Readonly<ModelLimits> = Object.freeze({
  maxInputBytes: 1048576, maxOutputBytes: 1048576, maxProposals: 100,
  maxEstimatedCostMicros: 1000000, maxCostPerAttemptMicros: 1000000,
  maxAttempts: 3, maxConcurrency: 4, timeoutMs: 10000,
});

function limits(input: Partial<ModelLimits>): Readonly<ModelLimits> {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !Object.hasOwn(defaults, key))) throw new ModelError('INVALID_LIMITS');
  const result = { ...defaults, ...input };
  for (const key of Object.keys(defaults) as (keyof ModelLimits)[]) {
    if (!Number.isSafeInteger(result[key]) || result[key] < 1 || result[key] > maximums[key]) throw new ModelError('INVALID_LIMITS');
  }
  return Object.freeze(result);
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Copy only ordinary JSON data. Reject lossy serialization instead of dropping fields. */
function jsonCopy<T>(value: T, maxBytes: number, invalid: ModelErrorCode, tooLarge: ModelErrorCode): { value: T; bytes: number } {
  let nodes = 0;
  const ancestors = new Set<object>();
  function copy(input: unknown, depth: number): unknown {
    if (++nodes > maxBytes) throw new ModelError(tooLarge);
    if (depth > 32) throw new ModelError(invalid);
    if (input === null || typeof input === 'boolean') return input;
    if (typeof input === 'string') {
      if (Buffer.byteLength(input, 'utf8') > maxBytes) throw new ModelError(tooLarge);
      return input;
    }
    if (typeof input === 'number') {
      if (!Number.isFinite(input)) throw new ModelError(invalid);
      return input;
    }
    if (typeof input !== 'object' || ancestors.has(input)) throw new ModelError(invalid);
    const array = Array.isArray(input);
    if (!array && ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new ModelError(invalid);
    ancestors.add(input);
    try {
      if (array) {
        const descriptors = Object.getOwnPropertyDescriptors(input);
        if (Reflect.ownKeys(input).some(key => typeof key !== 'string' || (key !== 'length'
          && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= input.length)))) throw new ModelError(invalid);
        const result: unknown[] = [];
        for (let index = 0; index < input.length; index++) {
          const descriptor = descriptors[String(index)];
          if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new ModelError(invalid);
          result.push(copy(descriptor.value, depth + 1));
        }
        return result;
      }
      const result: Record<string, unknown> = Object.create(null);
      for (const key of Reflect.ownKeys(input)) {
        if (typeof key !== 'string') throw new ModelError(invalid);
        const descriptor = Object.getOwnPropertyDescriptor(input, key)!;
        if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new ModelError(invalid);
        result[key] = copy(descriptor.value, depth + 1);
      }
      return result;
    } finally { ancestors.delete(input); }
  }
  try {
    const cloned = copy(value, 0) as T;
    const serialized = JSON.stringify(cloned);
    if (typeof serialized !== 'string') throw new ModelError(invalid);
    const bytes = Buffer.byteLength(serialized, 'utf8');
    if (bytes > maxBytes) throw new ModelError(tooLarge);
    return { value: JSON.parse(serialized) as T, bytes };
  } catch (error) {
    if (error instanceof ModelError) throw error;
    throw new ModelError(invalid);
  }
}

function validRequest(request: GenerationRequest): boolean {
  const strings = (value: unknown): boolean => Array.isArray(value) && value.every(item => typeof item === 'string' && Boolean(item.trim()));
  return object(request) && request.promptTemplateVersion === 'dayline-editorial-v1'
    && typeof request.systemInstructions === 'string' && Boolean(request.systemInstructions.trim())
    && object(request.untrustedData) && Array.isArray(request.untrustedData.evidence) && request.untrustedData.evidence.length > 0
    && request.untrustedData.evidence.every(item => object(item) && typeof item.id === 'string' && Boolean(item.id.trim())
      && typeof item.claim === 'string' && Boolean(item.claim.trim()) && strings(item.support) && strings(item.contradict)
      && typeof item.uncertainty === 'string');
}

export class ModelRunner {
  private readonly provider: AiProvider;
  private readonly configured: Readonly<ModelLimits>;
  private readonly providerId: string;
  private readonly modelVersion: string;
  private reservedCostMicros = 0;
  private attempts = 0;
  private proposals = 0;
  private active = 0;

  constructor(provider: AiProvider, configured: Partial<ModelLimits> = {}) {
    this.configured = limits(configured);
    try {
      if (!provider || typeof provider.generate !== 'function' || typeof provider.enabled !== 'boolean'
        || typeof provider.id !== 'string' || !/^[a-z][a-z0-9._-]{0,63}$/.test(provider.id)
        || typeof provider.modelVersion !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(provider.modelVersion)) throw new ModelError('INVALID_LIMITS');
      this.provider = provider; this.providerId = provider.id; this.modelVersion = provider.modelVersion;
    } catch { throw new ModelError('INVALID_LIMITS'); }
  }

  snapshot(): { reservedCostMicros: number; attempts: number; proposals: number; active: number } {
    return { reservedCostMicros: this.reservedCostMicros, attempts: this.attempts, proposals: this.proposals, active: this.active };
  }

  private available(): void {
    let enabled: boolean;
    try { enabled = this.provider.enabled; } catch { throw new ModelError('PROVIDER_FAILURE'); }
    if (enabled !== true) throw new ModelError('DISABLED');
    if (this.active >= this.configured.maxConcurrency) throw new ModelError('CONCURRENCY_LIMIT');
    if (this.reservedCostMicros + this.configured.maxCostPerAttemptMicros > this.configured.maxEstimatedCostMicros) throw new ModelError('BUDGET_EXCEEDED');
  }

  private async attempt(request: GenerationRequest, signal?: AbortSignal): Promise<{ output: unknown; usage: Usage }> {
    if (signal?.aborted) throw new ModelError('CANCELLED');
    this.available();
    this.reservedCostMicros += this.configured.maxCostPerAttemptMicros;
    this.attempts++; this.active++;
    const controller = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel: (() => void) | undefined;
    const interrupted = new Promise<never>((_resolve, reject) => {
      cancel = () => { controller.abort(); reject(new ModelError('CANCELLED')); };
      signal?.addEventListener('abort', cancel, { once: true });
      timer = setTimeout(() => { timedOut = true; controller.abort(); reject(new ModelError('TIMEOUT')); }, this.configured.timeoutMs);
    });
    let providerResult: Promise<{ output: unknown; usage: Usage }>;
    try { providerResult = Promise.resolve(this.provider.generate(structuredClone(request), controller.signal)); }
    catch (error) { providerResult = Promise.reject(error); }
    // This slot belongs to the actual provider work, not the timeout race. A
    // provider that ignores cancellation cannot accumulate background requests.
    const settled = providerResult.then(result => { this.active--; return result; }, error => { this.active--; throw error; });
    try {
      const response = await Promise.race([settled, interrupted]);
      if (signal?.aborted) throw new ModelError('CANCELLED');
      if (!object(response) || !Object.hasOwn(response, 'output') || !Object.hasOwn(response, 'usage')) throw new ModelError('OUTPUT_INVALID');
      const output = jsonCopy(response.output, this.configured.maxOutputBytes, 'OUTPUT_INVALID', 'OUTPUT_TOO_LARGE').value;
      const usage = jsonCopy(response.usage, 1024, 'USAGE_INVALID', 'USAGE_INVALID').value;
      if (!object(usage) || !['inputTokens', 'outputTokens', 'estimatedCostMicros'].every(key => Number.isSafeInteger(usage[key]) && (usage[key] as number) >= 0)
        || usage.inputTokens > this.configured.maxInputBytes || usage.outputTokens > this.configured.maxOutputBytes
        || usage.estimatedCostMicros > this.configured.maxCostPerAttemptMicros) throw new ModelError('USAGE_INVALID');
      return { output, usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, estimatedCostMicros: usage.estimatedCostMicros } };
    } catch (error) {
      if (signal?.aborted) throw new ModelError('CANCELLED');
      if (timedOut) throw new ModelError('TIMEOUT');
      const code = error instanceof ModelError ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined;
      if (typeof code === 'string' && Object.hasOwn(messages, code)) throw new ModelError(code as ModelErrorCode);
      throw new ModelError('PROVIDER_FAILURE');
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (cancel) signal?.removeEventListener('abort', cancel);
    }
  }

  async run(request: GenerationRequest, signal?: AbortSignal): Promise<{ output: unknown; usage: Usage; providerId: string; modelVersion: string }> {
    if (signal?.aborted) throw new ModelError('CANCELLED');
    this.available();
    if (this.proposals >= this.configured.maxProposals) throw new ModelError('PROPOSAL_LIMIT');
    const captured = jsonCopy(request, this.configured.maxInputBytes, 'INPUT_INVALID', 'INPUT_TOO_LARGE').value;
    if (!validRequest(captured)) throw new ModelError('INPUT_INVALID');
    this.proposals++;
    for (let attempt = 0; attempt < this.configured.maxAttempts; attempt++) {
      try {
        const result = await this.attempt(captured, signal);
        return { ...result, providerId: this.providerId, modelVersion: this.modelVersion };
      } catch (error) {
        if (!(error instanceof ModelError) || error.code !== 'TRANSIENT' || attempt + 1 >= this.configured.maxAttempts) throw error;
      }
    }
    throw new ModelError('PROVIDER_FAILURE');
  }
}

/** Offline extractive fixture: no network, SDK, credentials or invented claims. */
export class MockEditorialProvider implements AiProvider {
  readonly id = 'mock-editorial';
  readonly modelVersion = 'extractive-v1';
  readonly enabled: boolean;
  constructor(enabled = true) { this.enabled = enabled; }
  async generate(request: GenerationRequest, signal: AbortSignal): Promise<{ output: unknown; usage: Usage }> {
    if (!this.enabled) throw new ModelError('DISABLED');
    if (signal.aborted) throw new ModelError('CANCELLED');
    const evidence = request.untrustedData.evidence;
    const output: DraftOutput = {
      headline: evidence[0].claim,
      summary: evidence.map(item => item.claim).join(' '),
      claims: evidence.map(item => ({ evidenceId: item.id, text: item.claim,
        supportingSourceIds: [...item.support], contradictingSourceIds: [...item.contradict] })),
      sections: evidence.flatMap(item => [{ kind: 'FACT' as const, text: item.claim, evidenceIds: [item.id] },
        ...(item.uncertainty.trim() ? [{ kind: 'UNCERTAINTY' as const, text: item.uncertainty, evidenceIds: [item.id] }] : [])]),
      uncertainties: [...new Set(evidence.filter(item => item.uncertainty.trim()).map(item => item.uncertainty))],
    };
    return { output, usage: { inputTokens: Math.ceil(Buffer.byteLength(JSON.stringify(request), 'utf8') / 4),
      outputTokens: Math.ceil(Buffer.byteLength(JSON.stringify(output), 'utf8') / 4), estimatedCostMicros: 1 } };
  }
}
