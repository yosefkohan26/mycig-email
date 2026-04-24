import { OutlookSubscriptionFactory } from './outlook-subscription.factory';
import { BaseSubscriptionFactory } from './base-subscription.factory';
import { EProviders } from '../../types';

// Provider factory registry. Google/Gmail has been retired — only Microsoft.
const subscriptionFactoryRegistry = new Map<EProviders, BaseSubscriptionFactory>();

const outlookFactory = new OutlookSubscriptionFactory();
subscriptionFactoryRegistry.set(EProviders.microsoft, outlookFactory);

export function getSubscriptionFactory(provider: EProviders): BaseSubscriptionFactory {
  const factory = subscriptionFactoryRegistry.get(provider);
  if (!factory) {
    throw new Error(`No subscription factory registered for provider: ${provider}`);
  }
  return factory;
}

export function getAllRegisteredProviders(): EProviders[] {
  return Array.from(subscriptionFactoryRegistry.keys());
}

// Export individual factories for direct access if needed
export { outlookFactory };
