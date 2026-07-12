import type { ProviderAdapter } from "../providers/interface.js";
import { supportsLocalManagement } from "../providers/kinds.js";

export function providerRenderContext(
  provider: string,
  providers: any[],
  adapter: ProviderAdapter | null | undefined
) {
  return {
    provider,
    providers,
    manageable: supportsLocalManagement(adapter)
  };
}
