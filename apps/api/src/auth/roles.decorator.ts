import { SetMetadata } from '@nestjs/common';

export const REQUIRED_ROLES_KEY = Symbol('required-roles');
export const Roles = (...roles: string[]) => SetMetadata(REQUIRED_ROLES_KEY, roles);
