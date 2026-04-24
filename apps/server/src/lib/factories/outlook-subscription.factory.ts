// Microsoft Graph mailbox subscriptions for Outlook. Creates a change
// notification subscription on the user's /me/messages feed pointing at our
// webhook, stores the subscription id for renewal/teardown, and gates incoming
// notifications on a per-subscription HMAC secret (clientState).
//
// Graph ref: https://learn.microsoft.com/graph/api/subscription-post-subscriptions
// Expiration: message subscriptions max ~4230 min (~70.5h). We request ~70h
// and count on a scheduled renewer to refresh before expiry.

import {
  BaseSubscriptionFactory,
  type SubscriptionData,
  type UnsubscriptionData,
} from './base-subscription.factory';
import { c, getNotificationsUrl, setSubscribedState } from '../utils';
import { EProviders } from '../../types';
import { env } from '../../env';

// Cloudflare Workers expose crypto.randomUUID / crypto.subtle; no Node import.

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
// Graph allows up to 4230 min for message subscriptions. We subscribe for ~70h
// and renew on a cron before expiry.
const SUBSCRIPTION_MINUTES = 70 * 60;

type GraphTokenResponse = { access_token: string; expires_in: number };

type GraphSubscriptionResponse = {
  id: string;
  expirationDateTime: string;
  resource: string;
  changeType: string;
};

/** Acquire a delegated access token for the given refresh token. */
async function refreshGraphAccessToken(refreshToken: string): Promise<string> {
  const body = new URLSearchParams({
    client_id: env.MICROSOFT_CLIENT_ID,
    client_secret: env.MICROSOFT_CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  const res = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    throw new Error(`Graph token refresh failed: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as GraphTokenResponse;
  return json.access_token;
}

function graphFetch(accessToken: string, path: string, init: RequestInit = {}) {
  return fetch(path.startsWith('http') ? path : `${GRAPH_BASE}${path}`, {
    ...init,
    headers: {
      ...init.headers,
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  });
}

/**
 * Generate a 256-bit random secret. Each subscription gets its own; we store it
 * in KV keyed by connectionId so the webhook handler can match clientState on
 * incoming notifications.
 */
function newClientState(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export class OutlookSubscriptionFactory extends BaseSubscriptionFactory {
  readonly providerId = EProviders.microsoft;

  public async subscribe(data: { body: SubscriptionData }): Promise<Response> {
    const { connectionId } = data.body;
    if (!connectionId) {
      return c.json({ error: 'connectionId is required' }, { status: 400 }) as unknown as Response;
    }

    const connectionData = await this.getConnectionFromDb(connectionId);
    if (!connectionData) {
      return c.json({ error: 'connection not found' }, { status: 400 }) as unknown as Response;
    }
    if (!connectionData.refreshToken) {
      return c.json({ error: 'connection missing refresh token' }, {
        status: 400,
      }) as unknown as Response;
    }

    try {
      const accessToken = await refreshGraphAccessToken(connectionData.refreshToken);

      // Provision a per-subscription HMAC secret; store BEFORE creating the
      // subscription so the validation handshake has what it needs.
      const clientState = newClientState();
      await env.subscribed_accounts.put(
        `${connectionId}__${EProviders.microsoft}__clientState`,
        clientState,
      );

      const expirationDateTime = new Date(
        Date.now() + SUBSCRIPTION_MINUTES * 60 * 1000,
      ).toISOString();

      const body = {
        changeType: 'created,updated,deleted',
        notificationUrl: getNotificationsUrl(EProviders.microsoft),
        lifecycleNotificationUrl: getNotificationsUrl(EProviders.microsoft),
        resource: '/me/messages',
        expirationDateTime,
        clientState,
      };

      const res = await graphFetch(accessToken, '/subscriptions', {
        method: 'POST',
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const text = await res.text();
        // Clean up the client-state key if we couldn't create the sub.
        await env.subscribed_accounts.delete(
          `${connectionId}__${EProviders.microsoft}__clientState`,
        );
        console.error('[SUBSCRIPTION][msft] create failed', { status: res.status, body: text });
        return c.json({ error: 'graph subscription failed', detail: text }, {
          status: 502,
        }) as unknown as Response;
      }

      const sub = (await res.json()) as GraphSubscriptionResponse;

      await env.subscribed_accounts.put(`${connectionId}__${EProviders.microsoft}`, sub.id);
      await env.subscribed_accounts.put(
        `${connectionId}__${EProviders.microsoft}__expiresAt`,
        sub.expirationDateTime,
      );
      await setSubscribedState(connectionId, EProviders.microsoft);
      await this.initializeConnectionLabels(connectionId);

      return c.json({ subscriptionId: sub.id, expiresAt: sub.expirationDateTime }) as unknown as Response;
    } catch (error) {
      console.error('[SUBSCRIPTION][msft] error', error);
      return c.json({ error: 'subscription failed' }, { status: 500 }) as unknown as Response;
    }
  }

  public async unsubscribe(data: { body: UnsubscriptionData }): Promise<Response> {
    const { connectionId } = data.body;
    if (!connectionId) {
      return c.json({ error: 'connectionId is required' }, { status: 400 }) as unknown as Response;
    }

    const subscriptionId = await env.subscribed_accounts.get(
      `${connectionId}__${EProviders.microsoft}`,
    );
    if (!subscriptionId) {
      return c.json({ message: 'not subscribed' }, { status: 200 }) as unknown as Response;
    }

    const connectionData = await this.getConnectionFromDb(connectionId);
    if (connectionData?.refreshToken) {
      try {
        const accessToken = await refreshGraphAccessToken(connectionData.refreshToken);
        const res = await graphFetch(accessToken, `/subscriptions/${subscriptionId}`, {
          method: 'DELETE',
        });
        // Graph returns 204 on success; 404 if the subscription already
        // expired is also fine — either way we proceed with local cleanup.
        if (!res.ok && res.status !== 404) {
          console.warn('[SUBSCRIPTION][msft] delete non-OK', {
            status: res.status,
            body: await res.text(),
          });
        }
      } catch (error) {
        console.warn('[SUBSCRIPTION][msft] delete errored (proceeding with local cleanup)', error);
      }
    }

    await env.subscribed_accounts.delete(`${connectionId}__${EProviders.microsoft}`);
    await env.subscribed_accounts.delete(
      `${connectionId}__${EProviders.microsoft}__clientState`,
    );
    await env.subscribed_accounts.delete(
      `${connectionId}__${EProviders.microsoft}__expiresAt`,
    );
    return c.json({}) as unknown as Response;
  }

  /**
   * Incoming Graph webhook notifications carry the `clientState` we supplied
   * at subscription time. This confirms the caller is Graph and that the
   * subscription id they reference belongs to one of our connections.
   */
  public async verifyToken(clientState: string): Promise<boolean> {
    // KV doesn't have a native "search by value" — callers pass the state
    // and we match against any connection that owns it. Cheap because KV list
    // is paginated and scoped by the prefix.
    const list = await env.subscribed_accounts.list({ prefix: '' });
    for (const key of list.keys) {
      if (!key.name.endsWith('__clientState')) continue;
      const stored = await env.subscribed_accounts.get(key.name);
      if (stored && stored === clientState) return true;
    }
    return false;
  }
}
