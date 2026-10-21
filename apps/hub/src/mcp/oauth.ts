import { randomBytes } from 'node:crypto';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';

/** What the hub keeps of an OAuth sign-in to an MCP server (sealed in the database). */
export interface OAuthState {
  redirectUrl?: string;
  /** Ties the browser's return to this server. */
  state?: string;
  codeVerifier?: string;
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
}

/**
 * The MCP SDK's view of a server's OAuth sign-in, backed by the hub's database: the SDK finds
 * the authorization server, registers MowBot as a client, and refreshes tokens; the hub only
 * keeps what it hands over and catches the URL to send the user to.
 */
export class StoredOAuthProvider implements OAuthClientProvider {
  /** Where the user must go to approve, when the SDK asks for it. */
  authorizationUrl: URL | null = null;

  constructor(
    private data: OAuthState,
    private readonly save: (data: OAuthState) => Promise<void>,
  ) {}

  private async update(patch: Partial<OAuthState>): Promise<void> {
    this.data = { ...this.data, ...patch };
    await this.save(this.data);
  }

  get redirectUrl(): string | undefined {
    return this.data.redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'MowBot',
      redirect_uris: this.data.redirectUrl ? [this.data.redirectUrl] : [],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }

  async state(): Promise<string> {
    const state = randomBytes(24).toString('base64url');
    await this.update({ state });
    return state;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.data.clientInformation;
  }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    await this.update({ clientInformation });
  }

  tokens(): OAuthTokens | undefined {
    return this.data.tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.update({ tokens });
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    this.authorizationUrl = authorizationUrl;
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await this.update({ codeVerifier });
  }

  codeVerifier(): string {
    if (!this.data.codeVerifier) throw new Error('No sign-in in progress');
    return this.data.codeVerifier;
  }

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery') {
    if (scope === 'all')
      await this.update({
        clientInformation: undefined,
        tokens: undefined,
        codeVerifier: undefined,
      });
    else if (scope === 'client') await this.update({ clientInformation: undefined });
    else if (scope === 'tokens') await this.update({ tokens: undefined });
    else if (scope === 'verifier') await this.update({ codeVerifier: undefined });
  }
}
