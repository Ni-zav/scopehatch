import { randomUUID } from 'node:crypto';
import { validateRequest, InputError, ConflictError, DatabaseError } from './bootstrap.mjs';

/** Trusted host only. Runtime credentials must never reach this module. */
export async function manageIdentity(client, input, {dryRun=false}={}) {
  const data=validateRequest({...input,workspaceName:'Identity administration'});
  if (!['member add','member disable','tenant bind-issuer'].includes(data.command)) throw new InputError('Unknown identity operation');
  if (data.command==='tenant bind-issuer') {
    if (data.membersVerified!==true) throw new InputError('Verify every existing membership against the issuer before binding');
  } else {
    validateRequest({...data,ownerSub:data.memberSub});
    if (data.memberSub===data.ownerSub) throw new InputError('Member must differ from the verified owner');
    if (data.command==='member add' && !['operator','reviewer'].includes(data.role)) throw new InputError('Member role must be operator or reviewer');
    if (data.command==='member disable' && data.role!==undefined) throw new InputError('Disable does not accept a role');
  }
  let begun=false;
  try {
    await client.query(dryRun?'BEGIN READ ONLY':'BEGIN');begun=true;
    await client.query("SET LOCAL statement_timeout = '15s'");
    await client.query("SET LOCAL lock_timeout = '5s'");
    const identity=await client.query('SELECT current_user AS username,current_database() AS database,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user');
    const row=identity.rows[0];
    if (!row || row.database!==data.database || (!row.rolsuper&&!row.rolbypassrls) || ['scopehatch_app','scopehatch_runtime'].includes(row.username)) throw new InputError('Protected administrative role and matching database required');
    if (!dryRun) await client.query("SELECT pg_advisory_xact_lock(hashtextextended('scopehatch/bootstrap/' || $1,0))",[data.tenantId]);
    const tenant=await client.query('SELECT id FROM scopehatch.tenants WHERE id=$1'+(dryRun?'':' FOR UPDATE'),[data.tenantId]);
    if (tenant.rows.length!==1) throw new ConflictError();
    const owner=await client.query('SELECT roles,active FROM scopehatch.memberships WHERE tenant_id=$1 AND principal_id=$2',[data.tenantId,data.ownerSub]);
    if (!owner.rows[0]?.active || !owner.rows[0].roles.includes('owner')) throw new ConflictError();
    const binding=await client.query('SELECT issuer FROM scopehatch.tenant_identity_issuers WHERE tenant_id=$1',[data.tenantId]);
    if (binding.rows.length && binding.rows[0].issuer!==data.issuer) throw new ConflictError();
    let changed=false;
    if (data.command==='tenant bind-issuer') {
      changed=binding.rows.length===0;
      if (changed&&!dryRun) await client.query('INSERT INTO scopehatch.tenant_identity_issuers(tenant_id,issuer) VALUES ($1,$2)',[data.tenantId,data.issuer]);
    } else {
      if (binding.rows.length!==1) throw new ConflictError();
      const member=await client.query('SELECT roles,active FROM scopehatch.memberships WHERE tenant_id=$1 AND principal_id=$2',[data.tenantId,data.memberSub]);
      const existing=member.rows[0];
      if (data.command==='member add') {
        if (existing && (!existing.active || existing.roles.length!==1 || existing.roles[0]!==data.role)) throw new ConflictError();
        changed=!existing;
        if (changed&&!dryRun) await client.query('INSERT INTO scopehatch.memberships(tenant_id,principal_id,roles,active) VALUES ($1,$2,ARRAY[$3]::text[],true)',[data.tenantId,data.memberSub,data.role]);
      } else {
        if (!existing || existing.roles.includes('owner')) throw new ConflictError();
        changed=existing.active;
        if (changed&&!dryRun) await client.query('UPDATE scopehatch.memberships SET active=false WHERE tenant_id=$1 AND principal_id=$2',[data.tenantId,data.memberSub]);
      }
    }
    if (changed&&!dryRun) {
      await client.query('SELECT scopehatch.admin_bind_context($1,$2)',[data.tenantId,data.ownerSub]);
      await client.query("INSERT INTO scopehatch.audit_events(tenant_id,id,actor_id,action,request_id,outcome,metadata) VALUES ($1,$2,$3,$4,$5,'succeeded',$6::jsonb)",
        [data.tenantId,randomUUID(),data.ownerSub,'admin.'+data.command.replaceAll(' ','.'),randomUUID(),JSON.stringify({memberSub:data.memberSub??null,role:data.role??null})]);
    }
    await client.query(dryRun?'ROLLBACK':'COMMIT');begun=false;
    return (dryRun?'would-be-':'')+(changed?'changed':'unchanged');
  } catch(error) {
    if (begun) {try {await client.query('ROLLBACK');} catch { /* preserve sanitized outcome */ }}
    if (error instanceof InputError||error instanceof ConflictError) throw error;
    throw new DatabaseError();
  }
}
