import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import { z } from 'zod';

import { AuthService } from './auth.service.js';
import type { AuthenticatedRequest } from './auth.types.js';
import { Public } from './public.decorator.js';
import { SESSION_COOKIE_NAME } from './session-auth.guard.js';

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  password: z.string().min(1).max(256),
});

type LoginInput = z.infer<typeof loginSchema>;

interface CookieResponse {
  clearCookie(name: string, options: Record<string, unknown>): void;
  cookie(name: string, value: string, options: Record<string, unknown>): void;
}

@Controller('auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(
    @Body({ schema: loginSchema }) input: LoginInput,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: CookieResponse,
  ) {
    const result = await this.auth.login(input.email, input.password, requestContext(request));
    response.cookie(SESSION_COOKIE_NAME, result.token, sessionCookieOptions(result.expiresAt));
    return { user: result.user, expiresAt: result.expiresAt.toISOString() };
  }

  @Get('me')
  me(@Req() request: AuthenticatedRequest) {
    return { user: request.user };
  }

  @Post('logout')
  @HttpCode(204)
  async logout(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: CookieResponse,
  ): Promise<void> {
    if (!request.authToken || !request.user) {
      return;
    }
    await this.auth.logout(request.authToken, request.user, requestContext(request));
    response.clearCookie(SESSION_COOKIE_NAME, sessionCookieOptions(new Date(0)));
  }
}

function requestContext(request: AuthenticatedRequest) {
  const forwardedFor = request.headers['x-forwarded-for'];
  const userAgent = request.headers['user-agent'];
  return {
    ipAddress:
      (Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor)?.split(',')[0]?.trim() ??
      request.ip ??
      request.socket?.remoteAddress,
    userAgent: Array.isArray(userAgent) ? userAgent[0] : userAgent,
  };
}

function sessionCookieOptions(expires: Date): Record<string, unknown> {
  return {
    expires,
    httpOnly: true,
    path: '/',
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
  };
}
