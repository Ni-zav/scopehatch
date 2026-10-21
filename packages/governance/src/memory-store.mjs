/** TEST-ONLY serialized in-memory transaction store. No multi-process, crash or distributed safety. */
export class FakeGovernanceStore {
  constructor() { this.tenants = new Map(); this.locks = new Map(); }
  setAccount(tenantId, { currency = 'USD', limitMinor, spentMinor = '0', heldMinor = '0' }) {
    const state = this.tenants.get(tenantId) ?? { reservations: [], events: [] };
    this.tenants.set(tenantId, { ...state, account: { currency, limitMinor, spentMinor, heldMinor } });
  }
  async withTenantTransaction(tenantId, fn) {
    const previous = this.locks.get(tenantId) ?? Promise.resolve();
    let unlock;
    const next = new Promise(resolve => { unlock = resolve; });
    this.locks.set(tenantId, next);
    await previous;
    try {
      const current = this.tenants.get(tenantId) ?? { account: null, reservations: [], events: [] };
      const draft = structuredClone(current);
      const tx = {
        getAccount: () => draft.account ? structuredClone(draft.account) : null,
        putAccount: a => { draft.account = structuredClone(a); },
        getReservationByKey: key => structuredClone(draft.reservations.find(x => x.idempotencyKey === key) ?? null),
        getReservationById: id => structuredClone(draft.reservations.find(x => x.id === id) ?? null),
        putReservation: r => {
          const index = draft.reservations.findIndex(x => x.id === r.id);
          if (index === -1) draft.reservations.push(structuredClone(r)); else draft.reservations[index] = structuredClone(r);
        },
        getEvent: id => structuredClone(draft.events.find(x => x.id === id) ?? null),
        putEvent: e => {
          if (draft.events.some(x => x.id === e.id)) throw new Error('duplicate event');
          draft.events.push(structuredClone(e));
        }
      };
      const result = await fn(tx);
      this.tenants.set(tenantId, draft);
      return result;
    } finally {
      unlock();
      if (this.locks.get(tenantId) === next) this.locks.delete(tenantId);
    }
  }
  snapshot(tenantId) { return structuredClone(this.tenants.get(tenantId)); }
}
