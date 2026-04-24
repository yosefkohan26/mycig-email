// MyCIG session shim. Validates the JWT that MyCIG's Go backend issues and
// mirrors into a `.ciglaw.com`-scoped cookie (see MyCIG backend
// handlers/cookie.go). Lets the Zero worker recognize a session minted at
// crm.ciglaw.com without a second login at inbox.ciglaw.com.
//
// Non-enforcing: missing/invalid token leaves context empty and calls next().
// Per-route enforcement (requireMyCIGUser) is the explicit gate.

import type { Context, MiddlewareHandler } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { jwtVerify } from 'jose';
import type { HonoContext } from '../ctx';

export const MYCIG_SESSION_COOKIE = 'mycig_session';

/** Matches MyCIG backend services/auth_service.go JWTClaims shape. */
export type MyCIGClaims = {
  user_id: string;
  email: string;
  name: string;
  first_name?: string;
  last_name?: string;
  role: 'admin' | 'user';
  job_title?: string;
  job_role?: string;
  bar_number?: string;
  extension?: string;
};

function readToken(c: Context<HonoContext>): string | null {
  // Cookie path — the subdomain-shared session set by MyCIG.
  const cookieToken = getCookie(c, MYCIG_SESSION_COOKIE);
  if (cookieToken) return cookieToken;

  // Bearer path — for mobile / internal clients that don't carry cookies.
  const authz = c.req.header('authorization');
  if (authz) {
    const [scheme, token] = authz.split(' ');
    if (scheme?.toLowerCase() === 'bearer' && token) return token;
  }
  return null;
}

async function validate(
  token: string,
  secret: string,
  issuer: string,
  audience: string,
): Promise<MyCIGClaims | null> {
  try {
    const key = new TextEncoder().encode(secret);
    const { payload } = await jwtVerify(token, key, {
      algorithms: ['HS256'],
      issuer,
      audience,
    });
    if (typeof payload.user_id !== 'string' || !payload.user_id) return null;
    return payload as unknown as MyCIGClaims;
  } catch {
    // Expired, bad signature, wrong issuer/audience — treat as unauthenticated.
    return null;
  }
}

/**
 * Populates `c.var.mycigUser` when a valid MyCIG session is present. Always
 * calls next() — callers that need enforcement should use `requireMyCIGUser`.
 */
export const mycigAuthMiddleware = (): MiddlewareHandler<HonoContext> => async (c, next) => {
  const secret = c.env.JWT_SECRET;
  if (!secret) {
    // Misconfigured worker — fail open so other auth paths still work, but log.
    console.warn('[mycig-auth] JWT_SECRET missing; session shim disabled');
    return next();
  }
  const token = readToken(c);
  if (!token) return next();

  const claims = await validate(
    token,
    secret,
    c.env.JWT_ISSUER || 'mycig-api',
    c.env.JWT_AUDIENCE || 'mycig-clients',
  );
  if (claims) c.set('mycigUser', claims);
  return next();
};

/** Per-route gate. Use after `mycigAuthMiddleware`. */
export const requireMyCIGUser = (): MiddlewareHandler<HonoContext> => async (c, next) => {
  if (!c.var.mycigUser) return c.json({ error: 'unauthorized' }, 401);
  return next();
};

// --- Dev impersonation ------------------------------------------------------
// Mints a MyCIG-shaped JWT locally so devs don't need a full MyCIG web+backend
// stack to iterate on Zero. See routes/dev-session.ts for the HTTP entry.

const MINUTE = 60;

/** Sign a MyCIG-compatible HS256 JWT. Dev-only — never call from request paths. */
export async function signMyCIGJWT(
  claims: MyCIGClaims,
  opts: { secret: string; issuer: string; audience: string; ttlSeconds?: number },
): Promise<string> {
  const { SignJWT } = await import('jose');
  const key = new TextEncoder().encode(opts.secret);
  const ttl = opts.ttlSeconds ?? 15 * MINUTE;
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(opts.issuer)
    .setAudience(opts.audience)
    .setSubject(claims.user_id)
    .setIssuedAt()
    .setNotBefore('0s')
    .setExpirationTime(`${ttl}s`)
    .sign(key);
}

/** Write the session cookie onto the response — used by dev/session only. */
export function setMyCIGCookie(
  c: Context<HonoContext>,
  token: string,
  opts: { maxAge?: number; domain?: string; secure?: boolean } = {},
) {
  setCookie(c, MYCIG_SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'Lax',
    maxAge: opts.maxAge ?? 15 * MINUTE,
    domain: opts.domain,
    secure: opts.secure ?? false,
  });
}

export function clearMyCIGCookie(c: Context<HonoContext>) {
  deleteCookie(c, MYCIG_SESSION_COOKIE, { path: '/' });
}
