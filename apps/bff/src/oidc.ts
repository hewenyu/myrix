import * as client from "openid-client";
import type { OidcAdapter } from "./auth";

/** Constructs a strict OIDC code+PKCE client. No tokens or secrets are returned to the browser. */
export async function createOidcAdapter(options: {
  issuer: string;
  clientId: string;
  clientSecret: string;
  origin: string;
}): Promise<OidcAdapter> {
  const issuer = new URL(options.issuer);
  const origin = new URL(options.origin);
  if (issuer.protocol !== "https:" || origin.protocol !== "https:") throw new Error("Production OIDC requires HTTPS");
  if (!options.clientId || !options.clientSecret) throw new Error("OIDC client credentials are required");
  const config = await client.discovery(issuer, options.clientId, options.clientSecret, client.ClientSecretPost(options.clientSecret), {
    execute: [client.enableNonRepudiationChecks],
  });
  // Refuse unexpected discovery redirects changing the authoritative issuer.
  if (config.serverMetadata().issuer !== options.issuer) throw new Error("OIDC discovered issuer does not match configuration");
  const redirectUri = new URL("/api/v1/auth/callback", origin).href;
  return {
    async begin() {
      const flow = { state: client.randomState(), nonce: client.randomNonce(), verifier: client.randomPKCECodeVerifier() };
      const url = client.buildAuthorizationUrl(config, {
        redirect_uri: redirectUri, scope: "openid profile", response_type: "code", state: flow.state, nonce: flow.nonce,
        code_challenge: await client.calculatePKCECodeChallenge(flow.verifier), code_challenge_method: "S256",
      });
      return { flow, url: url.href };
    },
    async complete(url, flow) {
      if (url.origin !== origin.origin || url.pathname !== "/api/v1/auth/callback") throw new Error("Unexpected OIDC callback URI");
      const tokens = await client.authorizationCodeGrant(config, url, {
        pkceCodeVerifier: flow.verifier, expectedState: flow.state, expectedNonce: flow.nonce, idTokenExpected: true,
      });
      const claims = tokens.claims();
      if (!claims || claims.iss !== options.issuer || !claims.sub) throw new Error("OIDC identity claims are missing");
      return { issuer: claims.iss, subject: claims.sub };
    },
  };
}
