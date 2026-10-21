// Liveness only, not readiness or user-flow proof.
const port = Number(process.env.PORT ?? 3000);
try {
  const signal = AbortSignal.timeout(3000);
  const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal });
  process.exit(response.ok ? 0 : 1);
} catch {
  process.exit(1);
}
