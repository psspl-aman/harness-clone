import type { FastifyInstance } from 'fastify';

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function hostnameOf(hostHeader: string | undefined): string | null {
  if (!hostHeader) return null;
  if (hostHeader.startsWith('[')) return hostHeader.slice(0, hostHeader.indexOf(']') + 1);
  return hostHeader.split(':')[0] ?? null;
}

/**
 * The daemon can spawn processes and write files, so it only answers:
 *  - requests whose Host is a loopback name (or the configured bind host),
 *    which defeats DNS-rebinding attacks, and
 *  - browser requests whose Origin is the AI Harness web app (CSRF guard).
 * Non-browser clients (no Origin header) such as curl and tests are allowed.
 */
export function registerLocalOnlyGuard(
  app: FastifyInstance,
  opts: { bindHost: string; isOriginAllowed: (o: string | undefined) => boolean },
): void {
  const allowedHosts = new Set(LOCAL_HOSTNAMES);
  allowedHosts.add(opts.bindHost);
  app.addHook('onRequest', async (req, reply) => {
    const host = hostnameOf(req.headers.host);
    if (!host || !allowedHosts.has(host)) {
      return reply
        .status(403)
        .send({ error: { code: 'FORBIDDEN_HOST', message: 'Host not allowed' } });
    }
    if (!opts.isOriginAllowed(req.headers.origin)) {
      return reply
        .status(403)
        .send({ error: { code: 'FORBIDDEN_ORIGIN', message: 'Origin not allowed' } });
    }
  });
}

export const originChecker =
  (allowed: string[]) =>
  (origin: string | undefined): boolean =>
    origin === undefined || allowed.includes(origin);
