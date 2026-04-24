// Dev-only impersonate route. Mounted when NODE_ENV !== 'production' AND
// ALLOW_DEV_IMPERSONATE === 'true'. Never mount in production — signing a MyCIG
// JWT bypasses Microsoft SSO.

import { Hono } from 'hono';
import type { HonoContext } from '../ctx';
import { clearMyCIGCookie, setMyCIGCookie, signMyCIGJWT, type MyCIGClaims } from '../lib/mycig-auth';

type ImpersonateBody = Partial<MyCIGClaims> & { user_id: string; email: string };

export const devSessionRouter = new Hono<HonoContext>();

devSessionRouter.post('/dev/session', async (c) => {
  if (c.env.NODE_ENV === 'production' || c.env.ALLOW_DEV_IMPERSONATE !== 'true') {
    return c.json({ error: 'dev impersonate disabled' }, 404);
  }
  const secret = c.env.JWT_SECRET;
  if (!secret) return c.json({ error: 'JWT_SECRET missing' }, 500);

  let body: ImpersonateBody;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid json' }, 400);
  }
  if (!body.user_id || !body.email) {
    return c.json({ error: 'user_id and email are required' }, 400);
  }

  const claims: MyCIGClaims = {
    user_id: body.user_id,
    email: body.email,
    name: body.name ?? body.email,
    first_name: body.first_name,
    last_name: body.last_name,
    role: body.role ?? 'user',
    job_title: body.job_title,
    job_role: body.job_role,
    bar_number: body.bar_number,
    extension: body.extension,
  };

  const token = await signMyCIGJWT(claims, {
    secret,
    issuer: c.env.JWT_ISSUER || 'mycig-api',
    audience: c.env.JWT_AUDIENCE || 'mycig-clients',
  });
  setMyCIGCookie(c, token);

  return c.json({ token, user: claims });
});

devSessionRouter.delete('/dev/session', async (c) => {
  if (c.env.NODE_ENV === 'production' || c.env.ALLOW_DEV_IMPERSONATE !== 'true') {
    return c.json({ error: 'dev impersonate disabled' }, 404);
  }
  clearMyCIGCookie(c);
  return c.body(null, 204);
});

// Diagnostic — echoes what mycigAuthMiddleware extracted from the incoming
// cookie/bearer. Useful for verifying the shim end-to-end. Dev-only.
devSessionRouter.get('/dev/session', async (c) => {
  if (c.env.NODE_ENV === 'production' || c.env.ALLOW_DEV_IMPERSONATE !== 'true') {
    return c.json({ error: 'dev impersonate disabled' }, 404);
  }
  return c.json({ authenticated: !!c.var.mycigUser, user: c.var.mycigUser ?? null });
});
