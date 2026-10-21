/**
 * Browser OIDC Authorization Code + PKCE. Tokens stay in JS memory, never local
 * or session storage. The API remains the verifier and authorization authority.
 */
const tokenState: { accessToken: string | null; expiresAt: number } = {
  accessToken: null, expiresAt: 0
};
const pendingKey = 'scopehatch.oidc.pkce';
function settings() {
  const authorizationUrl = import.meta.env.VITE_OIDC_AUTHORIZATION_ENDPOINT as string | undefined;
  const tokenUrl = import.meta.env.VITE_OIDC_TOKEN_ENDPOINT as string | undefined;
  const clientId = import.meta.env.VITE_OIDC_CLIENT_ID as string | undefined;
  if (!authorizationUrl || !tokenUrl || !clientId) return null;
  for (const raw of [authorizationUrl, tokenUrl]) {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && !(import.meta.env.DEV && url.hostname === 'localhost'))
      throw new Error('OIDC authorization and token endpoints must use HTTPS');
  }
  return { authorizationUrl, tokenUrl, clientId,
    redirectUri: window.location.origin + window.location.pathname };
}
function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
function randomString(): string {
  const random = new Uint8Array(32);
  crypto.getRandomValues(random);
  return base64url(random);
}
export function oidcConfigured(): boolean { return settings() !== null; }
export function isSignedIn(): boolean {
  return Boolean(tokenState.accessToken && tokenState.expiresAt > Date.now() + 10000);
}
export async function getAccessToken(): Promise<string | null> {
  return isSignedIn() ? tokenState.accessToken : null;
}
export function signOut(): void {
  tokenState.accessToken = null;
  tokenState.expiresAt = 0;
  sessionStorage.removeItem(pendingKey);
}
export async function beginSignIn(): Promise<void> {
  const cfg = settings();
  if (!cfg) throw new Error('An operator must configure the OIDC client and endpoints.');
  const verifier = randomString();
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const state = randomString();
  sessionStorage.setItem(pendingKey, JSON.stringify({
    state, verifier, issuedAt: Date.now(), redirectUri: cfg.redirectUri
  }));
  const authorize = new URL(cfg.authorizationUrl);
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('client_id', cfg.clientId);
  authorize.searchParams.set('redirect_uri', cfg.redirectUri);
  authorize.searchParams.set('scope', 'openid profile');
  authorize.searchParams.set('code_challenge_method', 'S256');
  authorize.searchParams.set('code_challenge', challenge);
  authorize.searchParams.set('state', state);
  window.location.assign(authorize.toString());
}
/** Validates state before a public-client token exchange. Does not trust ID token
 * or its role claims; the backend checks the access JWT and durable membership. */
export async function finishSignIn(): Promise<boolean> {
  const url = new URL(window.location.href);
  const hasCallback = url.searchParams.has('code') || url.searchParams.has('error');
  if (!hasCallback) return false;
  const clean = new URL(url);
  for (const k of ['code','state','error','error_description','session_state']) clean.searchParams.delete(k);
  window.history.replaceState({}, '', clean.pathname + clean.search + clean.hash);
  if (url.searchParams.has('error')) {
    sessionStorage.removeItem(pendingKey);
    throw new Error('The identity provider did not complete authentication.');
  }
  const stored = sessionStorage.getItem(pendingKey);
  sessionStorage.removeItem(pendingKey);
  if (!stored) throw new Error('Unsolicited or expired authorization response.');
  let pending: {state:string;verifier:string;issuedAt:number;redirectUri:string};
  try { pending = JSON.parse(stored); } catch { throw new Error('Invalid sign-in transaction.'); }
  if (!pending.state || pending.state !== url.searchParams.get('state') ||
      !pending.verifier || !pending.redirectUri ||
      Date.now() - pending.issuedAt > 600000 || pending.issuedAt > Date.now() + 10000)
    throw new Error('Sign-in state mismatch or expired authorization transaction.');
  const cfg = settings();
  if (!cfg || cfg.redirectUri !== pending.redirectUri) throw new Error('OIDC configuration changed during sign-in.');
  const response = await fetch(cfg.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    credentials: 'omit',
    body: new URLSearchParams({
      grant_type:'authorization_code',code:url.searchParams.get('code')||'',
      redirect_uri:pending.redirectUri,client_id:cfg.clientId,code_verifier:pending.verifier
    })
  });
  if (!response.ok) throw new Error('The identity provider rejected the authorization code.');
  const parsed: unknown = await response.json();
  const result = parsed as {access_token?:unknown;token_type?:unknown;expires_in?:unknown};
  if (!result || typeof result.access_token !== 'string' ||
      result.token_type?.toString().toLowerCase() !== 'bearer' ||
      typeof result.expires_in !== 'number' || !Number.isFinite(result.expires_in) ||
      result.expires_in <= 0 || result.expires_in > 86400)
    throw new Error('Identity provider returned an unusable access token.');
  tokenState.accessToken = result.access_token;
  tokenState.expiresAt = Date.now() + result.expires_in * 1000;
  return true;
}
