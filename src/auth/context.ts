import { AsyncLocalStorage } from 'node:async_hooks';

export type RequestContext = {
  userId: string;
  organizationId: string;
  role: string;
  email: string;
};

export const requestContext = new AsyncLocalStorage<RequestContext>();

export function getContext(): RequestContext | undefined {
  return requestContext.getStore();
}

export function getOrganizationId(): string | undefined {
  return requestContext.getStore()?.organizationId;
}
