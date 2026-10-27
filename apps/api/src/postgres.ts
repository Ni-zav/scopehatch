import type { Pool } from 'pg';
import { ApiError } from './core.ts';
import { normalizeScope,normalizeProposal,renderProposalMarkdown } from './proposal.ts';
import type {
  PersistencePort, MembershipPort, UnitOfWork, Principal,
  Project, Scope, Estimate, Review, AuditEvent, Catalog, ProjectPage, ServiceRate, ProposalMetadata
} from './ports.ts';
// The shared JavaScript persistence module retains its own runtime contract.
// @ts-expect-error JS ESM module is independently shipped without a .d.mts
import { createPersistence } from '../../../packages/persistence/index.mjs';
// @ts-expect-error Shared JS transaction attestor.
import { createContextBinder } from '../../../packages/persistence/identity-context.mjs';

type DbRepo = {
  getProject(id: string): Promise<{id:string;title:string;brief:string;status:string}>;
  createProject(data: {id:string;title:string;brief:string}): Promise<unknown>;
  listCatalogs(): Promise<unknown[]>;
  getCatalog(v?:number):Promise<unknown>;
  getScope(id:string,revision?:number):Promise<Scope>;
  createScope(data:{projectId:string;deliverables:Scope['deliverables'];unknowns:Scope['unknowns'];proposal?:ProposalMetadata}):Promise<Scope>;
  /** Sprint 02 DB worker must expose atomic baseVersion CAS, not Sprint 01 createCatalog(). */
  createCatalog(input:{baseVersion:number;currency:string;services:readonly ServiceRate[]}):Promise<Catalog>;
  /** Sprint 02 DB worker must provide tenant-bound SQL keyset pagination. */
  listProjects?(input:{limit:number;cursor?:string}):Promise<ProjectPage>;
  getEstimate(id:string,revision?:number):Promise<Estimate & {revision:number}>;
  createEstimate(data:{projectId:string;scopeRevision:number;catalogVersion:number}):Promise<Estimate & {revision:number}>;
  listReviews(id:string):Promise<(Review & {id:string;estimateRevision:number})[]>;
  submitReview(data:{projectId:string;estimateRevision:number}):Promise<Review>;
  approveReview(data:{projectId:string;reviewId:string}):Promise<Review>;
  exportApproved(id:string):Promise<{projectId:string;revision:number;currency:string;totalMinor:number;markdown:string;proposal?:ProposalMetadata}>;
  listAudit(data:{projectId:string;before?:string;limit:number}):Promise<{items:Array<{
    id:string;tenantId:string;projectId:string;actorId:string;requestId:string;action:string;objectRevision:number|null;
    outcome:string;createdAt:Date
  }>;nextCursor:string|null}>;
  idempotent<T>(data:{key:string;operation:string;payload:unknown;execute:(tx:DbRepo)=>Promise<T>}):Promise<{replayed:boolean;result:T}>;
};

function isMissing(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === 'NOT_FOUND';
}
async function optional<T>(work:()=>Promise<T>):Promise<T|null> {
  try {return await work();}catch(error){if(isMissing(error))return null;throw error;}
}
function stale():never {
  throw Object.assign(new Error('Revision changed during transaction'), {code:'STALE_REVISION'});
}
function adapt(repo:DbRepo, principal:Principal):UnitOfWork {
  return {
    async getProject(id) {
      const r=await optional(()=>repo.getProject(id));
      return r ? { ...r, tenantId: principal.tenantId } as Project : null;
    },
    async insertProject(project) {
      await repo.createProject({id:project.id,title:project.title,brief:project.brief});
    },
    listCatalogs: async () => await repo.listCatalogs() as Catalog[],
    async createCatalogVersion(input) {
      // Sprint 02 DB module names this atomic CAS operation createCatalog.
      // Alias only at the HTTP UnitOfWork contract; do not split its transaction.
      return repo.createCatalog(input);
    },
    async listProjects(input) {
      if(!repo.listProjects)throw new ApiError('DEPENDENCY_UNAVAILABLE',503,'Project listing persistence extension unavailable');
      return repo.listProjects(input);
    },
    async getCatalog(version) {
      return await optional(()=>repo.getCatalog(version)) as Awaited<ReturnType<UnitOfWork['getCatalog']>>;
    },
    async getLatestScope(id){const scope=await optional(()=>repo.getScope(id));return scope?normalizeScope(scope):null;},
    async insertScope(scope) {
      const saved=await repo.createScope({projectId:scope.projectId,deliverables:scope.deliverables,unknowns:scope.unknowns,proposal:scope.proposal});
      if(saved.revision!==scope.revision || saved.authorId!==principal.id) stale();
      const actual=normalizeScope(saved);
      const intended=normalizeScope(scope);
      // Existing Sprint 01 persistence silently discards metadata. Roll back rather than accept
      // a 201 with lost commercial terms. The DB Sprint 02 worker supplies the forward migration.
      if(JSON.stringify(actual.proposal)!==JSON.stringify(intended.proposal)||
         JSON.stringify(actual.deliverables.map(d=>d.clientDescription))!==
         JSON.stringify(intended.deliverables.map(d=>d.clientDescription)))
        throw new ApiError('DEPENDENCY_UNAVAILABLE',503,'Revision metadata persistence unavailable');
    },
    async getEstimate(id,scopeRevision,catalogVersion) {
      const candidate=await optional(()=>repo.getEstimate(id));
      return candidate && candidate.scopeRevision===scopeRevision && candidate.catalogVersion===catalogVersion
        ? candidate : null;
    },
    async insertEstimate(estimate) {
      const saved=await repo.createEstimate({projectId:estimate.projectId,scopeRevision:estimate.scopeRevision,
        catalogVersion:estimate.catalogVersion});
      if(saved.state!==estimate.state || saved.totalMinor!==estimate.totalMinor) stale();
    },
    async getReview(id,scopeRevision,catalogVersion) {
      const reviews=await repo.listReviews(id);
      return reviews.find(x=>x.scopeRevision===scopeRevision&&x.catalogVersion===catalogVersion)??null;
    },
    async getLatestReview(id) {
      const reviews=await repo.listReviews(id);
      return reviews[0]??null;
    },
    async insertReview(review) {
      const estimate=await repo.getEstimate(review.projectId);
      if(estimate.scopeRevision!==review.scopeRevision||estimate.catalogVersion!==review.catalogVersion) stale();
      await repo.submitReview({projectId:review.projectId,estimateRevision:estimate.revision});
    },
    async approveReview(review) {
      const reviews=await repo.listReviews(review.projectId);
      const exact=reviews.find(x=>x.scopeRevision===review.scopeRevision&&x.catalogVersion===review.catalogVersion);
      if(!exact || exact.state!=='pending') stale();
      const approved=await repo.approveReview({projectId:review.projectId,reviewId:exact.id});
      if(approved.approvedBy!==principal.id||approved.state!=='approved') stale();
    },
    async listAudit(id) {
      const events:AuditEvent[]=[];
      let before:string|undefined;
      // The HTTP v1 facade uses oldest-first cursor pagination.
      // Do not silently truncate long audit histories.
      do {
        const page=await repo.listAudit({projectId:id,before,limit:100});
        for(const e of page.items) events.push({
          id:e.id,tenantId:e.tenantId,projectId:e.projectId,actorId:e.actorId,
          requestId:e.requestId,action:e.action,scopeRevision:e.objectRevision,
          outcome:'success',createdAt:new Date(e.createdAt).toISOString()
        });
        before=page.nextCursor??undefined;
      } while(before);
      return events.reverse();
    },
    async appendAudit() {
      // Every DB mutation already appends its durable event in the same transaction.
      // Do not double-write an API-side event or use a non-atomic secondary channel.
    },
    async getIdempotency() {
      throw new Error('Unsafe split idempotency read: use transaction-shaped DB idempotent');
    },
    async insertIdempotency() {
      throw new Error('Unsafe split idempotency write: use transaction-shaped DB idempotent');
    }
  };
}

/** Run before opening any listener, using the SAME pool the API will use. */
export async function assertRestrictedPgPool(pool:Pool):Promise<void> {
  const client=await pool.connect();
  try {
    const result=await client.query(
      "SELECT current_user AS username, r.rolsuper, r.rolbypassrls, r.rolinherit, r.rolcreaterole, r.rolcreatedb, r.rolreplication,"+
      " pg_has_role(current_user,'scopehatch_app','member') AS member,"+
      " pg_get_userbyid(c.relowner) AS table_owner,"+
      " EXISTS (SELECT 1 FROM pg_roles d WHERE d.rolname IN ('pg_read_all_data','pg_write_all_data',"+
      " 'pg_read_server_files','pg_write_server_files','pg_execute_server_program')"+
      " AND pg_has_role(current_user,d.oid,'member')) AS dangerous_role,"+
      " EXISTS (SELECT 1 FROM pg_roles d WHERE (d.rolsuper OR d.rolbypassrls OR d.rolcreaterole)"+
      " AND pg_has_role(current_user,d.oid,'member')) AS privileged_membership,"+
      " has_function_privilege(current_user,'scopehatch.admin_bind_context(text,text)','EXECUTE') AS signing_oracle,"+
      " EXISTS (SELECT 1 FROM pg_class k JOIN pg_namespace n ON n.oid=k.relnamespace"+
      " WHERE n.nspname='scopehatch_private' AND k.relname='context_key'"+
      " AND has_table_privilege(current_user,k.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')) AS key_access,"+
      " EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace"+
      " WHERE n.nspname='scopehatch_private' AND p.proname='context_mac'"+
      " AND has_function_privilege(current_user,p.oid,'EXECUTE')) AS private_signing_oracle,"+
      " EXISTS (SELECT 1 FROM pg_namespace n WHERE n.nspname IN ('scopehatch','scopehatch_private')"+
      " AND (pg_has_role(current_user,n.nspowner,'member') OR has_schema_privilege(current_user,n.oid,'CREATE'))) AS schema_control,"+
      " row_security_active('scopehatch.projects'::regclass) AS rls_active"+
      " FROM pg_roles r CROSS JOIN pg_class c"+
      " WHERE r.rolname=current_user AND c.oid='scopehatch.projects'::regclass"
    );
    const row=result.rows[0];
    if(!row || row.rolsuper || row.rolbypassrls || !row.rolinherit ||
       !row.member || row.username===row.table_owner || !row.rls_active ||
       row.rolcreaterole || row.rolcreatedb || row.rolreplication || row.dangerous_role ||
       row.privileged_membership || row.signing_oracle || row.schema_control ||
       row.key_access || row.private_signing_oracle) {
      throw new Error('Refusing privileged or RLS-bypassing runtime database identity');
    }
    await client.query('BEGIN');
    try {
      await createContextBinder()(client,{tenantId:'__startup_probe__',id:'__startup_probe__'});
    } finally {await client.query('ROLLBACK');}
  } finally {client.release();}
}

export function createPgPorts(pool:Pool):{store:PersistencePort;memberships:MembershipPort} {
  const persistence=createPersistence(pool);
  const bindIdentity=createContextBinder('membership');
  const store:PersistencePort={
    transaction:(principal,execute)=>persistence.withPrincipal(principal,(repo:DbRepo)=>execute(adapt(repo,principal))),
    idempotent:(principal,input)=>persistence.withPrincipal(principal,async (repo:DbRepo)=>{
      const wrapped=await repo.idempotent({
        key:input.key,operation:input.operation,payload:input.payload,
        execute:async (tx:DbRepo)=>input.execute(adapt(tx,principal))
      });
      return wrapped.result;
    }),
    exportApproved:(principal,projectId,revision)=>persistence.withPrincipal(principal,async (repo:DbRepo)=>{
      const result=await repo.exportApproved(projectId);
      if(result.revision!==revision) stale();
      const scope=normalizeScope(await repo.getScope(projectId,revision));
      // Approval/export locks are acquired by the durable persistence operation first.
      // Do not use latest text from another scope revision.
      return {...result,proposal:normalizeProposal(scope.proposal),
        markdown:result.proposal ? result.markdown : result.markdown+renderProposalMarkdown(scope)};
    })
  };
  const memberships:MembershipPort={
    async findByVerifiedSubject(subject,issuer) {
      if(!subject||subject.length>512||!issuer||issuer.length>2048)return [];
      const client=await pool.connect();
      let res;
      try {
        await client.query('BEGIN');
        await bindIdentity(client,{subject,issuer});
        res=await client.query('SELECT tenant_id,principal_id,roles,active FROM scopehatch.lookup_verified_subject($1,$2)',[subject,issuer]);
        await client.query('COMMIT');
      } catch(error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {client.release();}
      return res.rows.map(x=>({
        subject,actorId:x.principal_id,tenantId:x.tenant_id,roles:x.roles,active:x.active
      }));
    }
  };
  return {store,memberships};
}
