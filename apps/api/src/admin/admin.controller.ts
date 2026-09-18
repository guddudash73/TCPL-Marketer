import { Controller, Get, Req } from "@nestjs/common";

import type { AuthenticatedRequest } from "../auth/auth.types.js";
import { Roles } from "../auth/roles.decorator.js";

@Controller("admin")
@Roles("ADMIN")
export class AdminController {
  @Get("ping")
  ping(@Req() request: AuthenticatedRequest) {
    return { status: "ok", userId: request.user?.id };
  }
}
