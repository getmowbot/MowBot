import { z } from 'zod';

export const scopeSchema = z.enum([
  'read',
  'chat',
  'files:read',
  'files:write',
  'control',
  'admin',
]);
export type Scope = z.infer<typeof scopeSchema>;
export const ALL_SCOPES: readonly Scope[] = scopeSchema.options;

export const deviceKindSchema = z.enum(['web', 'ios', 'android', 'desktop', 'cli']);
export type DeviceKind = z.infer<typeof deviceKindSchema>;

export const deviceInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  kind: deviceKindSchema,
});
export type DeviceInput = z.infer<typeof deviceInputSchema>;

export const PASSWORD_MIN_LENGTH = 12;
export const newPasswordSchema = z.string().min(PASSWORD_MIN_LENGTH).max(256);

export const authStatusSchema = z.object({
  setupRequired: z.boolean(),
});
export type AuthStatus = z.infer<typeof authStatusSchema>;

export const setupRequestSchema = z.object({
  setupToken: z.string().min(1).max(256),
  displayName: z.string().trim().min(1).max(100),
  password: newPasswordSchema,
  device: deviceInputSchema,
});
export type SetupRequest = z.infer<typeof setupRequestSchema>;

/** Changing the hub's password needs the current one. */
export const passwordChangeSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: newPasswordSchema,
  /** Signs out every other device: they sign in again with the new password. */
  signOutOthers: z.boolean().default(false),
});
export type PasswordChange = z.infer<typeof passwordChangeSchema>;

export const loginRequestSchema = z.object({
  password: z.string().min(1).max(256),
  device: deviceInputSchema,
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

/** Native clients send the refresh token in the body; web clients rely on the httpOnly cookie. */
export const refreshRequestSchema = z.object({
  refreshToken: z.string().min(1).max(512).optional(),
});
export type RefreshRequest = z.infer<typeof refreshRequestSchema>;

export const tokenResponseSchema = z.object({
  accessToken: z.string(),
  accessTokenExpiresAt: z.iso.datetime(),
  /** Omitted for web devices: the refresh token is set as an httpOnly cookie instead. */
  refreshToken: z.string().optional(),
  refreshTokenExpiresAt: z.iso.datetime(),
  deviceId: z.uuid(),
});
export type TokenResponse = z.infer<typeof tokenResponseSchema>;
