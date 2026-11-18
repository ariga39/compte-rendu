import { gatewayProviderPath } from './routes';
export interface GatewayConfig {
  readonly accountId: string;
  readonly gatewayId: string;
  readonly runToken: string;
}

export const gatewayHeaders = (gateway: GatewayConfig, alias: string) => ({
  'cf-aig-authorization': `Bearer ${gateway.runToken}`,
  'cf-aig-collect-log': 'false',
  'cf-aig-collect-log-payload': 'false',
  'cf-aig-skip-cache': 'true',
  'cf-aig-byok-alias': alias,
});
export const gatewayUrl = (
  gateway: GatewayConfig,
  slug: string,
  path: '/models' | '/chat/completions',
) =>
  `https://gateway.ai.cloudflare.com/v1/${gateway.accountId}/${gateway.gatewayId}/${gatewayProviderPath(slug)}${path}`;
