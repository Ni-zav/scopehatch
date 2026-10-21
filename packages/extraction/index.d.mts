export interface CatalogService { id: string; label: string }
export interface ExtractInput { brief: string; serviceCatalog: CatalogService[]; requestId: string }
export interface ExtractContext { tenantId: string; signal?: AbortSignal }
export interface Evidence { start: number; end: number; quote: string }
export interface SuggestedDeliverable { serviceId: string; quantity: number | null; evidence: Evidence | null }
export interface TokenUsage { inputTokens?: number; outputTokens?: number; status: 'reported' | 'unknown' }
export interface ModelMetadata { latencyMs: number; finishReason: string; reportedModel: string | null }
export interface ExtractionResult {
  suggestedDeliverables: SuggestedDeliverable[];
  unknowns: string[];
  provider: string;
  model: string;
  usage: TokenUsage;
  provenance: {
    source: 'submitted-brief'; offsetEncoding: 'utf16'; promptVersion: string;
    schemaVersion: string; requestId: string; evidenceVerified: true;
  };
  modelMetadata: ModelMetadata;
}
export interface Completion {
  content: string;
  provider: string;
  model: string;
  usage?: TokenUsage;
  metadata?: { finishReason?: string; reportedModel?: string | null };
}
export interface ExtractionProvider {
  name: string; model: string;
  complete(request: ExtractInput, context: { signal: AbortSignal }): Promise<Completion>;
}
export class ExtractionError extends Error {
  readonly code: string;
  readonly provider: string | null;
  readonly requestId: string | null;
  readonly status: number | null;
}
export function extractBrief(
  input: ExtractInput, context: ExtractContext, provider: ExtractionProvider,
  options?: { timeoutMs?: number }
): Promise<ExtractionResult>;
export function createExtractor(options: { provider: ExtractionProvider; timeoutMs?: number }): {
  extractBrief(input: ExtractInput, context: ExtractContext): Promise<ExtractionResult>;
};
export function createOpenAICompatibleProvider(options: {
  endpoint: string; model: string; apiKey?: string; allowedHosts: string[];
  provider?: string; fetchImpl?: typeof fetch; jsonMode?: boolean; maxOutputTokens?: number;
  allowDockerOllamaHttp?: boolean;
}): ExtractionProvider;
export interface FixtureCase { requestId: string; brief: string; output: string | {
  suggestedDeliverables: SuggestedDeliverable[]; unknowns: string[];
} }
export function createFixtureProvider(options: { cases: FixtureCase[]; model?: string }): ExtractionProvider;
export const PROMPT_VERSION: string;
export const SCHEMA_VERSION: string;
export const LIMITS: Readonly<Record<string, number>>;
export function validateCompletion(content: string, request: Pick<ExtractInput, 'brief' | 'serviceCatalog'>): {
  suggestedDeliverables: SuggestedDeliverable[]; unknowns: string[];
};
