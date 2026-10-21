export type MoneyMinor = string; // nonnegative integer in decimal format
export type Usage = {status:'unknown'} | {status:'reported';inputTokens:number;outputTokens:number};
export type ProviderPrice = {inputPerMillionMinor:MoneyMinor;outputPerMillionMinor:MoneyMinor};
export type Provider = {tenantId:string;providerId:string;model:string;enabled:boolean;capabilities:string[];contextWindow:number;residency:string;currency:string;price:ProviderPrice;priority?:number;timeoutMs?:number};
export type TenantPolicy = {tenantId:string;currency:string;allowedModels:Array<{providerId:string;model:string}>;allowedResidencies?:string[]};
export type Reservation = {id:string;tenantId:string;status:'reserved'|'dispatched'|'unknown'|'settled'|'released';providerId:string;model:string;currency:string;reservedMinor:MoneyMinor;costMinor:MoneyMinor|null;usage:Usage;dispatched:boolean;replay?:boolean};
export type Account = {currency:string;limitMinor:MoneyMinor;heldMinor:MoneyMinor;spentMinor:MoneyMinor};
export type LedgerRow = Reservation & {idempotencyKey:string;intent:string;price:ProviderPrice;createdAt:number};
export type LedgerEvent = {tenantId:string;id:string;reservationId:string;kind:string;fingerprint:string};
export type MaybePromise<T> = T | Promise<T>;
export interface LedgerTransaction {
  getAccount(): MaybePromise<Account|null>;
  putAccount(account:Account):MaybePromise<void>;
  getReservationByKey(key:string):MaybePromise<LedgerRow|null>;
  getReservationById(id:string):MaybePromise<LedgerRow|null>;
  putReservation(row:LedgerRow):MaybePromise<void>;
  getEvent(eventId:string):MaybePromise<LedgerEvent|null>;
  putEvent(event:LedgerEvent):MaybePromise<void>;
}
export interface GovernanceStorage {withTenantTransaction<T>(tenantId:string, callback:(tx:LedgerTransaction)=>Promise<T>):Promise<T>}
export class GovernanceError extends Error {readonly code:string;readonly status:number;constructor(code:string,message:string,status?:number)}
export function amount(value:string,name?:string):bigint;
export function tokenCostMinor(price:ProviderPrice, usage:{inputTokens:number;outputTokens:number}):MoneyMinor;
export function eligibleProviders(request:{tenantId:string;policy:TenantPolicy;candidates:Provider[];capability:string;inputTokens:number;outputTokens:number;residency?:string;circuit?:CircuitBreaker}):Array<Omit<Provider,'enabled'|'capabilities'|'contextWindow'>>;
export class CircuitBreaker {constructor(options?:{threshold?:number;cooldownMs?:number;clock?:()=>number});canRequest(t:string,p:string,m:string):boolean;success(t:string,p:string,m:string):void;failure(t:string,p:string,m:string):void}
export type ReserveRequest = {tenantId:string;idempotencyKey:string;requestDigest:string;policy:TenantPolicy;candidates:Provider[];capability:string;inputTokens:number;outputTokens:number;residency?:string};
export class GovernanceEngine {
  readonly storage:GovernanceStorage; readonly circuit:CircuitBreaker;readonly clock:()=>number;readonly sleep:(ms:number)=>Promise<void>;
  constructor(options:{storage:GovernanceStorage;circuit?:CircuitBreaker;clock?:()=>number;sleep?:(ms:number)=>Promise<void>});
  reserve(request:ReserveRequest):Promise<Reservation>;
  markDispatched(request:{tenantId:string;reservationId:string}):Promise<Reservation>;
  release(request:{tenantId:string;reservationId:string;eventId:string;confirmedNotBilled?:boolean}):Promise<Reservation>;
  settle(request:{tenantId:string;reservationId:string;eventId:string;usage:Usage}):Promise<Reservation>;
  reconcile(request:{tenantId:string;reservationId:string;eventId:string;billedCostMinor:MoneyMinor;evidenceRef:string}):Promise<Reservation>;
}
export function safeTrace(request:{traceId:string;tenantId:string;providerId?:string;model?:string;status?:string;attempts?:number;latencyMs?:number;usageStatus?:string;costMinor?:MoneyMinor|null}):Readonly<Record<string,string|number>>;
export function executeGoverned<T>(options:{engine:GovernanceEngine;request:ReserveRequest;traceId:string;call:(context:{providerId:string;model:string;attempt:number;signal:AbortSignal;traceId:string})=>Promise<{value:T;usage?:Usage}>;signal?:AbortSignal;maxAttempts?:number;retryDelayMs?:number}):Promise<{status:string;reservation:Reservation;value?:T;trace?:Readonly<Record<string,string|number>>}>;
