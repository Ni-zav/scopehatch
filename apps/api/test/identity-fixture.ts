import { Pool } from 'pg';

/** Disposable seeded Studio A/B only. Never import this into the application. */
export async function bindFixtureIssuer(issuer:string) {
  if (!process.env.TEST_PG_ADMIN_URL) throw new Error('Disposable admin database required');
  const admin=new Pool({connectionString:process.env.TEST_PG_ADMIN_URL});
  try {
    await admin.query("INSERT INTO scopehatch.tenant_identity_issuers(tenant_id,issuer) VALUES ('studio-a',$1),('studio-b',$1) ON CONFLICT(tenant_id) DO UPDATE SET issuer=excluded.issuer",[issuer]);
  } finally {await admin.end();}
}
