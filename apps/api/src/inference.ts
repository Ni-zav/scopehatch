import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { PersistencePort, Principal, Project, Catalog, Scope } from './ports.ts';
import { ApiError } from './core.ts';
// @ts-expect-error Independent ESM extraction module's published types use .d.mts.
import { extractBrief, createFixtureProvider, createOpenAICompatibleProvider } from '../../../packages/extraction/index.mjs';
// @ts-expect-error Independent ESM governance module.
import { GovernanceEngine, executeGoverned } from '../../../packages/governance/src/index.mjs';
// @ts-expect-error Independent ESM Postgres adapter.
import { createPostgresGovernanceStorage } from '../../../packages/governance/pg-storage.mjs';

type Route = {
  tenantId: string; providerId: string; model: string; enabled: boolean;
  capabilities: string[]; contextWindow: number; residency: string; currency: string;
  price: { inputPerMillionMinor: string; outputPerMillionMinor: string };
  priority: number; timeoutMs: number;
};
type Config = { account: unknown; policy: {tenantId:string;currency:string;allowedModels:{providerId:string;model:string}[]};candidates:Route[] };

const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
const denied=(code:string,status:number,message:string):never=>{throw new ApiError(code,status,message);};

function createFixture(brief: string, services:{id:string;label:string}[],requestId:string){
  // Deterministic *non-model* fixture: no paid inference or token charge is
  // claimed. Outputs only an exact source quote, with an unknown quantity
  // whenever the source does not spell out a supported positive numeral.
  const catalog=services.find(x=>x.id==='render')??services[0];
  const matched=/\b([1-9][0-9]{0,3})\s+(?:interior |exterior )?(?:images?|views?|renders?)\b/i.exec(brief);
  const quote=matched?.[0]??brief.slice(0,Math.min(120,brief.length));
  const start=brief.indexOf(quote);
  const evidence=start>=0&&quote.trim()?{start,end:start+quote.length,quote}:null;
  const quantity=matched&&evidence?Number(matched[1]):null;
  const output={suggestedDeliverables:[{serviceId:catalog.id,quantity,evidence}],
    unknowns:quantity===null?['Quantity requires confirmation by an operator']:[]};
  const base=createFixtureProvider({model:'fixture-v1',cases:[{requestId,brief,output}]});
  return {
    name:'fixture',model:'fixture-v1',
    async complete(input:unknown,context:unknown){
      const result=await base.complete(input,context);
      // Measured fixture accounting is explicitly known to be zero; not a
      // proxy for paid-model usage or missing token reports.
      return {...result,usage:{status:'reported',inputTokens:0,outputTokens:0}};
    }
  };
}

export function createInferenceGateway(pool: Pool, store: PersistencePort) {
  return {
    async suggest(principal: Principal, projectId:string, idempotencyKey:string,
      requestId:string, scopeRevision?:number) {
      if(!principal.roles.some(r=>r==='owner'||r==='operator'))
        denied('FORBIDDEN',403,'Only scope operators can request suggestions');
      if(typeof idempotencyKey!=='string'||idempotencyKey.length<1||idempotencyKey.length>200)
        denied('INVALID_INPUT',422,'A valid idempotency key is required');
      const initial=await store.transaction(principal,async tx=>{
        const project=await tx.getProject(projectId);
        if(!project)denied('NOT_FOUND',404,'Project not found');
        const scope=await tx.getLatestScope(projectId);
        if(scopeRevision!==undefined&&(scope?.revision??0)!==scopeRevision)
          denied('STALE_REVISION',409,'Scope revision has changed');
        const catalog=(await tx.listCatalogs())[0];
        if(!catalog)denied('NO_CATALOG',409,'No trusted catalog exists');
        return {project:project as Project,scope:scope as Scope|null,catalog:catalog as Catalog};
      });
      if(initial.project.brief.length>20000)
        denied('INVALID_INPUT',422,'Brief exceeds the extraction size limit');
      if(initial.catalog.services.length>100)
        denied('INVALID_INPUT',422,'Catalog exceeds the extraction size limit');
      const storage=createPostgresGovernanceStorage(pool,principal);
      const {account,policy,candidates}:Config=await storage.getRoutes();
      if(!account)denied('BUDGET_NOT_CONFIGURED',503,'Tenant inference budget not configured');
      const providerType=process.env.SCOPEHATCH_INFERENCE_PROVIDER??'fixture';
      const configuredModel=process.env.SCOPEHATCH_INFERENCE_MODEL??'fixture-v1';
      const allowed=candidates.filter((c:Route)=>c.providerId===providerType&&c.model===configuredModel);
      if(!allowed.length)denied('NO_ELIGIBLE_PROVIDER',503,'No allowed tenant model for this operation');
      const serviceCatalog=initial.catalog.services.map(s=>({id:s.id,label:s.label}));
      const intentPayload={
        projectId,tenantId:principal.tenantId,actorId:principal.id,
        briefSha:sha(initial.project.brief),catalogVersion:initial.catalog.version,
        scopeRevision:initial.scope?.revision??0,bodyScopeRevision:scopeRevision??null
      };
      const digest=sha(JSON.stringify(intentPayload));
      const qualifiedKey=sha(principal.id+':'+projectId+':'+idempotencyKey);
      const request={
        tenantId:principal.tenantId,idempotencyKey:qualifiedKey,requestDigest:digest,
        policy,candidates:allowed,capability:'brief-extraction',
        inputTokens:Math.ceil(Buffer.byteLength(initial.project.brief,'utf8')+
          Buffer.byteLength(JSON.stringify(serviceCatalog),'utf8')+4096),
        outputTokens:2048
      };
      const engine=new GovernanceEngine({storage});
      const currentProject=async()=>store.transaction(principal,async tx=>({
        project:await tx.getProject(projectId),
        scope:await tx.getLatestScope(projectId),
        catalog:(await tx.listCatalogs())[0]
      }));
      const result=await executeGoverned({
        engine,request,traceId:sha(requestId).slice(0,32),maxAttempts:1,
        call:async ({providerId,model,signal}:{providerId:string;model:string;signal:AbortSignal})=>{
          const input={brief:initial.project.brief,serviceCatalog,requestId:sha(requestId).slice(0,32)};
          let provider:ReturnType<typeof createFixture> | ReturnType<typeof createOpenAICompatibleProvider>;
          if(providerId==='fixture'&&model==='fixture-v1'){
            provider=createFixture(input.brief,input.serviceCatalog,input.requestId);
          }else {
            const endpoint=process.env.SCOPEHATCH_INFERENCE_BASE_URL;
            if(!endpoint||providerType!=='openai-compatible')
              denied('NO_ELIGIBLE_PROVIDER',503,'Configured provider not connected');
            const host=new URL(endpoint).hostname;
            provider=createOpenAICompatibleProvider({
              endpoint: endpoint.endsWith('/chat/completions')?endpoint:
                endpoint.replace(/\/$/,'')+'/chat/completions',
              model,provider:providerId,apiKey:process.env.OPENAI_API_KEY,
              allowedHosts:[host],maxOutputTokens:2048
            });
          }
          const value=await extractBrief(input,{tenantId:principal.tenantId,signal},provider,{timeoutMs:allowed[0].timeoutMs});
          return {value,usage:value.usage};
        }
      });
      if(result.status==='replayed'){
        const replay=await storage.withTenantTransaction(principal.tenantId,async (tx:{
          getReservationByKey(key:string):Promise<{suggestionResult?:unknown;status:string}>|null
        })=>tx.getReservationByKey(qualifiedKey));
        if(replay?.suggestionResult)return {status:200,body:replay.suggestionResult};
        denied('INFERENCE_IN_PROGRESS',409,'Prior inference is pending or requires reconciliation');
      }
      const current=await currentProject();
      if(current.project?.brief!==initial.project.brief ||
        (current.scope?.revision??0)!==(initial.scope?.revision??0) ||
        current.catalog?.version!==initial.catalog.version)
        denied('STALE_REVISION',409,'Source or catalog changed while inference was running');
      const value=result.value;
      const body={suggestion:{suggestedDeliverables:value.suggestedDeliverables,
        unknowns:value.unknowns},provenance:value.provenance,
        model:value.model,usage:value.usage};
      await storage.withTenantTransaction(principal.tenantId,async(tx:{
        getReservationById(id:string):Promise<{status:string;tenantId:string}|null>;
        putReservation(x:unknown):Promise<void>;
      })=>{
        const reserved=await tx.getReservationById(result.reservation.id);
        if(!reserved)denied('NOT_FOUND',404,'Reservation missing');
        await tx.putReservation({...reserved,suggestionResult:body});
      });
      return {status:200,body};
    }
  };
}
