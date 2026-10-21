/** Durable PostgreSQL governance port, one serialized account row per tenant. */
export function createPostgresGovernanceStorage(pool, principal) {
  if (!pool?.connect || !principal?.id || !principal?.tenantId)
    throw new Error('Verified principal and PostgreSQL pool required');
  async function withTenantTransaction(tenantId, callback) {
    if (tenantId !== principal.tenantId) throw Object.assign(new Error('Tenant mismatch'),{code:'FORBIDDEN'});
    const client=await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('scopehatch.actor_id',$1,true),set_config('scopehatch.tenant_id',$2,true)",[principal.id,tenantId]);
      // Every reservation event and account modification is serialized across
      // independent API processes, not just within one Node.js instance.
      await client.query('SELECT tenant_id FROM scopehatch.inference_accounts WHERE tenant_id=$1 FOR UPDATE',[tenantId]);
      const tx={
        async getAccount(){
          const r=await client.query('SELECT currency, limit_minor::text AS "limitMinor", held_minor::text AS "heldMinor", spent_minor::text AS "spentMinor" FROM scopehatch.inference_accounts WHERE tenant_id=$1',[tenantId]);
          return r.rows[0]??null;
        },
        async putAccount(account){
          const r=await client.query('UPDATE scopehatch.inference_accounts SET held_minor=$2,spent_minor=$3 WHERE tenant_id=$1 AND currency=$4',[tenantId,account.heldMinor,account.spentMinor,account.currency]);
          if(r.rowCount!==1) throw Object.assign(new Error('Budget row was not updated'),{code:'BUDGET_NOT_CONFIGURED'});
        },
        async getReservationByKey(key) {
          const r=await client.query('SELECT * FROM scopehatch.inference_reservations WHERE tenant_id=$1 AND idempotency_key=$2',[tenantId,key]);
          return r.rows[0]?unpack(r.rows[0]):null;
        },
        async getReservationById(id) {
          const r=await client.query('SELECT * FROM scopehatch.inference_reservations WHERE tenant_id=$1 AND id=$2',[tenantId,id]);
          return r.rows[0]?unpack(r.rows[0]):null;
        },
        async putReservation(row) {
          if(row.tenantId!==tenantId)throw Object.assign(new Error('Cross-tenant reservation rejected'),{code:'FORBIDDEN'});
          const result=await client.query(`
            INSERT INTO scopehatch.inference_reservations
              (tenant_id,id,idempotency_key,intent,status,provider_id,model,currency,
              price,reserved_minor,cost_minor,usage,dispatched,created_at,suggestion_result)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
            ON CONFLICT(tenant_id,id) DO UPDATE SET
              status=EXCLUDED.status,cost_minor=EXCLUDED.cost_minor,
              usage=EXCLUDED.usage,dispatched=EXCLUDED.dispatched,
              suggestion_result=EXCLUDED.suggestion_result
            WHERE scopehatch.inference_reservations.intent=EXCLUDED.intent
              AND scopehatch.inference_reservations.idempotency_key=EXCLUDED.idempotency_key
            RETURNING id`,[tenantId,row.id,row.idempotencyKey,row.intent,row.status,
              row.providerId,row.model,row.currency,JSON.stringify(row.price),
              row.reservedMinor,row.costMinor,JSON.stringify(row.usage),row.dispatched,
              row.createdAt,row.suggestionResult?JSON.stringify(row.suggestionResult):null]);
          if(result.rowCount!==1)throw Object.assign(new Error('Immutable reservation mismatch'),{code:'IDEMPOTENCY_CONFLICT'});
        },
        async getEvent(eventId) {
          const r=await client.query('SELECT tenant_id AS "tenantId",id,reservation_id AS "reservationId",kind,fingerprint FROM scopehatch.inference_events WHERE tenant_id=$1 AND id=$2',[tenantId,eventId]);
          return r.rows[0]??null;
        },
        async putEvent(event) {
          if(event.tenantId!==tenantId)throw Object.assign(new Error('Cross-tenant event rejected'),{code:'FORBIDDEN'});
          await client.query('INSERT INTO scopehatch.inference_events(tenant_id,id,reservation_id,kind,fingerprint) VALUES($1,$2,$3,$4,$5)',[tenantId,event.id,event.reservationId,event.kind,event.fingerprint]);
        }
      };
      const answer=await callback(tx);
      await client.query('COMMIT');
      return answer;
    } catch(e) {
      try{await client.query('ROLLBACK');}catch{}
      throw e;
    } finally {client.release();}
  }
  async function getRoutes(){
    return withTenantTransaction(principal.tenantId,async tx=>{
      const account=await tx.getAccount();
      const client=await pool.connect();
      try{
        await client.query('BEGIN READ ONLY');
        await client.query("SELECT set_config('scopehatch.actor_id',$1,true),set_config('scopehatch.tenant_id',$2,true)",[principal.id,principal.tenantId]);
        const r=await client.query('SELECT tenant_id AS "tenantId",provider_id AS "providerId",model,enabled,capabilities,context_window AS "contextWindow",residency,currency,input_per_million_minor::text AS "inputPerMillionMinor",output_per_million_minor::text AS "outputPerMillionMinor",priority,timeout_ms AS "timeoutMs" FROM scopehatch.inference_routes WHERE tenant_id=$1 AND enabled=true',[principal.tenantId]);
        await client.query('COMMIT');
        const candidates=r.rows.map(x=>({
          tenantId:x.tenantId,providerId:x.providerId,model:x.model,enabled:x.enabled,
          capabilities:x.capabilities,contextWindow:x.contextWindow,
          residency:x.residency,currency:x.currency,
          price:{inputPerMillionMinor:x.inputPerMillionMinor,outputPerMillionMinor:x.outputPerMillionMinor},
          priority:x.priority,timeoutMs:x.timeoutMs
        }));
        return {account,candidates,policy:{
          tenantId:principal.tenantId,currency:account?.currency??'',
          allowedModels:candidates.map(x=>({providerId:x.providerId,model:x.model}))
        }};
      }catch(e){try{await client.query('ROLLBACK');}catch{}throw e;}
      finally{client.release();}
    });
  }
  return {withTenantTransaction,getRoutes};
}

function unpack(row){
  return {
    id:row.id,tenantId:row.tenant_id,idempotencyKey:row.idempotency_key,
    intent:row.intent,status:row.status,providerId:row.provider_id,model:row.model,
    currency:row.currency,price:row.price,reservedMinor:String(row.reserved_minor),
    costMinor:row.cost_minor===null?null:String(row.cost_minor),usage:row.usage,
    dispatched:row.dispatched,createdAt:Number(row.created_at),
    ...(row.suggestion_result?{suggestionResult:row.suggestion_result}:{})
  };
}
