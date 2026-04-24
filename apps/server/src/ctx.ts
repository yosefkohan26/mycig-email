import type { Autumn } from 'autumn-js';
import type { Auth } from './lib/auth';
import type { ZeroEnv } from './env';
import type { MyCIGClaims } from './lib/mycig-auth';

export type SessionUser = NonNullable<Awaited<ReturnType<Auth['api']['getSession']>>>['user'];

export type HonoVariables = {
  auth: Auth;
  sessionUser?: SessionUser;
  autumn?: Autumn;
  traceId?: string;
  requestId?: string;
  // Populated by mycigAuthMiddleware when a valid MyCIG cookie/bearer is
  // present. Absent when the caller hasn't authenticated through MyCIG.
  mycigUser?: MyCIGClaims;
};

export type HonoContext = { Variables: HonoVariables; Bindings: ZeroEnv };
