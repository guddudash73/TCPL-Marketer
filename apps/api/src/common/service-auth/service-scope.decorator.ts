import { SetMetadata } from "@nestjs/common";
import type { ServiceScope } from "@tcpl-marketer/orchestration-contracts";

export const SERVICE_SCOPE_KEY = "tcpl:service-scope";

/** The one permission a machine caller needs to reach this route. */
export const RequiresServiceScope = (scope: ServiceScope) =>
  SetMetadata(SERVICE_SCOPE_KEY, scope);
