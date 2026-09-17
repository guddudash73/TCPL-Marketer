export interface AuthPrincipal {
  id: string;
  email: string;
  displayName: string | null;
  roles: string[];
}

export interface AuthenticatedRequest {
  authToken?: string;
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
  socket?: { remoteAddress?: string };
  user?: AuthPrincipal;
}
