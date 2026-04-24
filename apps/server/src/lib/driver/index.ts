import type { MailManager, ManagerConfig } from './types';
import { OutlookMailManager } from './microsoft';

// Google/Gmail has been retired; Microsoft Graph is the only supported driver.
// Kept as a map (rather than a single class) so swapping in additional
// providers later is a one-line change.
const supportedProviders = {
  microsoft: OutlookMailManager,
};

export const createDriver = (
  provider: keyof typeof supportedProviders | (string & {}),
  config: ManagerConfig,
): MailManager => {
  const Provider = supportedProviders[provider as keyof typeof supportedProviders];
  if (!Provider) throw new Error(`Provider not supported: ${provider}`);
  return new Provider(config);
};
