/** Optional, explicitly configured Ollama/OpenAI-compatible evaluation adapter.
 * Credentials, briefs, raw responses and raw errors never enter measurements.
 */
import { performance } from 'node:perf_hooks';
import { buildMessages } from '../../packages/extraction/prompt.mjs';

const name = v => typeof v === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,119}$/.test(v);
const count = n => Number.isSafeInteger(n) && n >= 0;
const failure = code => Object.assign(new Error('Evaluation provider failed'), { code });

export function validateProviderConfig({provider, endpoint, model, apiKey, allowedHosts,
  temperature=0, seed=null, maxOutputTokens=2048, jsonMode=true} = {}) {
  if (!['ollama','openai-compatible'].includes(provider) || !name(model) ||
      (apiKey !== undefined && (typeof apiKey !== 'string' || !apiKey.trim())) ||
      !Number.isFinite(temperature) || temperature < 0 || temperature > 2 ||
      (seed !== null && (!Number.isSafeInteger(seed) || seed < 0)) ||
      !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 8192 ||
      typeof jsonMode !== 'boolean') throw failure('INVALID_PROVIDER_CONFIG');
  let url;
  try { url = new URL(endpoint); } catch { throw failure('INVALID_PROVIDER_CONFIG'); }
  if (!['https:','http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
      !['/v1/chat/completions','/chat/completions'].includes(url.pathname) ||
      !Array.isArray(allowedHosts) || !allowedHosts.includes(url.hostname) ||
      (url.protocol === 'http:' && !['localhost','127.0.0.1','[::1]'].includes(url.hostname)))
    throw failure('INVALID_PROVIDER_CONFIG');
  return Object.freeze({provider, endpoint:url.href, model, apiKey, temperature, seed, maxOutputTokens, jsonMode});
}
async function boundedJson(response, maxBytes=65536) {
  if (!response.body?.getReader) throw failure('SCHEMA_ERROR');
  const reader=response.body.getReader(), chunks=[];
  let length=0;
  try {
    while (true) {
      const {value,done}=await reader.read();
      if (done) break;
      length+=value.byteLength;
      if (length>maxBytes) throw failure('SCHEMA_ERROR');
      chunks.push(value);
    }
    const bytes=new Uint8Array(length);
    let offset=0;
    for(const part of chunks) { bytes.set(part,offset);offset+=part.byteLength; }
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  } catch(e) { if(e?.code==='SCHEMA_ERROR') throw e; throw failure('SCHEMA_ERROR'); }
  finally { try{await reader.cancel();}catch{} reader.releaseLock(); }
}
function reportedCost(usage) {
  if (!usage || typeof usage!=='object' || !/^[A-Z]{3}$/.test(usage.currency)) return null;
  const value=String(usage.cost);
  if ((typeof usage.cost!=='number' && typeof usage.cost!=='string') ||
      !/^(?:0|[1-9]\d*)(?:\.\d{1,9})?$/.test(value) || !Number.isFinite(Number(value))) return null;
  return {amount:value,currency:usage.currency,source:'provider_reported'};
}
/** Injectable transport for offline harness testing; never automatically retries writes/requests. */
export function createEvaluationAdapter({config,fetchImpl=globalThis.fetch}) {
  const checked=validateProviderConfig(config);
  if(typeof fetchImpl!=='function') throw failure('INVALID_PROVIDER_CONFIG');
  const observations=[];
  async function extractBrief(input,context={}) {
    const started=performance.now();
    let status='error',usage={status:'unknown'},cost=null,reportedModel=null;
    try {
      const response=await fetchImpl(checked.endpoint,{
        method:'POST',redirect:'error',signal:context.signal,
        headers:{'content-type':'application/json',
          ...(checked.apiKey?{authorization:'Bearer '+checked.apiKey}:{})},
        body:JSON.stringify({model:checked.model,temperature:checked.temperature,stream:false,
          max_tokens:checked.maxOutputTokens,
          ...(checked.seed!==null?{seed:checked.seed}:{}),
          ...(checked.jsonMode?{response_format:{type:'json_object'}}:{}),
          messages:buildMessages(input)})
      });
      if(response.status===429) throw failure('RATE_LIMIT');
      if([502,503,504].includes(response.status)) throw failure('PROVIDER_UNAVAILABLE');
      if(!response.ok) throw failure('PROVIDER_REJECTED');
      const envelope=await boundedJson(response);
      const choice=envelope?.choices?.[0];
      if(['length','content_filter'].includes(choice?.finish_reason) ||
          typeof choice?.message?.content!=='string' ||
          Buffer.byteLength(choice.message.content,'utf8')>32768) throw failure('SCHEMA_ERROR');
      let suggestion;
      try {suggestion=JSON.parse(choice.message.content);}catch{throw failure('SCHEMA_ERROR');}
      if(!suggestion || typeof suggestion!=='object' || Array.isArray(suggestion)) throw failure('SCHEMA_ERROR');
      if(count(envelope.usage?.prompt_tokens) && count(envelope.usage?.completion_tokens))
        usage={status:'reported',inputTokens:envelope.usage.prompt_tokens,outputTokens:envelope.usage.completion_tokens};
      cost=reportedCost(envelope.usage);
      reportedModel=name(envelope.model)?envelope.model:null;
      status='completed';
      // Unknown authority fields from a model remain visible to the scorer.
      return {...suggestion,provider:checked.provider,model:checked.model,usage};
    } catch(err) {
      if(context.signal?.aborted) throw failure('TIMEOUT');
      if(typeof err?.code==='string' && /^[A-Z_]{2,40}$/.test(err.code)) throw failure(err.code);
      throw failure('PROVIDER_UNAVAILABLE');
    } finally {
      observations.push({requestId:input.requestId,status,
        latencyMs:Math.max(0,Math.round(performance.now()-started)),
        usage:status==='completed'?usage:{status:'unknown'},
        cost:status==='completed'?cost:null,reportedModel});
    }
  }
  return Object.freeze({extractBrief,observations:()=>observations.map(o=>({
    ...o,usage:{...o.usage},cost:o.cost&&{...o.cost}}))});
}
export function configurationFromEnv(env) {
  return {provider:env.EVAL_PROVIDER,endpoint:env.EVAL_MODEL_URL,model:env.EVAL_MODEL,
    apiKey:env.EVAL_API_KEY,allowedHosts:(env.EVAL_ALLOWED_HOSTS??'').split(',').map(s=>s.trim()).filter(Boolean),
    temperature:env.EVAL_TEMPERATURE===undefined?0:Number(env.EVAL_TEMPERATURE),
    seed:env.EVAL_SEED===undefined?null:Number(env.EVAL_SEED),
    maxOutputTokens:env.EVAL_MAX_OUTPUT_TOKENS===undefined?2048:Number(env.EVAL_MAX_OUTPUT_TOKENS),
    jsonMode:env.EVAL_JSON_MODE!=='false'};
}
/** Backward-compatible export for the original --adapter live CLI. */
export async function extractBrief(input,context) {
  return createEvaluationAdapter({config:configurationFromEnv(process.env)}).extractBrief(input,context);
}
