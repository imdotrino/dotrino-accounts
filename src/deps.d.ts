// Tipos de los pilares que usa este servicio y que se publican en JS sin .d.ts. Solo lo que se
// usa aquí, con la forma que documenta cada pilar en su JSDoc.

/** El enlace de este aparato con su bóveda (`@dotrino/remote-agent/link`). */
interface AccountsLink {
  proxy: string
  iss: string
  device: { publickey: string, privateJwk: JsonWebKey }
  cert: { seq?: number } & Record<string, unknown>
  enc?: { privateJwk?: JsonWebKey } & Record<string, unknown>
}

declare module '@dotrino/remote-agent/link' {
  export function dataDir (name?: string): string
  export function loadLink (dir?: string): AccountsLink | null
  export function clientLink (link: AccountsLink, opts?: { dir?: string }): AccountsLink
  export function renewLink (link: AccountsLink, opts?: { dir?: string, force?: boolean }):
    Promise<{ renewed: boolean, seq?: number | null, reason?: string }>
  export function enroll (args: { qr: string, label?: string, dir?: string, ns?: string | null }): Promise<AccountsLink>
}

declare module '@dotrino/remote-agent/agent' {
  export interface AgentSession {
    device: string
    on (ev: 'message', fn: (msg: unknown) => void): void
    send (msg: object): void
  }
  export interface RemoteAgent {
    checkCap (pub: string, cap: string): Promise<{ ok: boolean, code?: string }>
  }
  export function startRemoteAgent (opts: {
    label?: string, dir?: string, product?: string, version?: string,
    onSession?: (session: AgentSession) => void, onRevoked?: () => void
  }): Promise<RemoteAgent>
}

declare module '@dotrino/vault/service' {
  export function waitForSecrets (o: {
    ns: string, proxyUrl?: string, masterPubkey?: string, device?: object, cert?: object, enc?: object,
    product?: string, version?: string, onRetry?: (e: Error, ms: number) => void
  }): Promise<Record<string, string>>
}

declare module '@dotrino/vault/device-info' {
  export function deviceInfo (link: AccountsLink, extra?: Record<string, unknown>): Promise<Record<string, unknown>>
  export function formatDeviceInfo (info: Record<string, unknown>): string
}

declare module '@dotrino/update' {
  export interface ReleaseAsset { name: string, browser_download_url?: string }
  export function latestVersion (o: { source: 'github' | 'npm', repo?: string, pkg?: string, fetchImpl?: typeof fetch, product?: string }):
    Promise<{ ok: true, version: string, assets?: ReleaseAsset[] } | { ok: false, reason: string }>
  export function watchForUpdate (o: { name: string, version: string, log?: (...a: unknown[]) => void }): Promise<unknown>
}

declare module '@dotrino/update/fetch' {
  export function fetchVerified (asset: import('@dotrino/update').ReleaseAsset, o: { repo: string, fetchImpl?: typeof fetch, product?: string }):
    Promise<{ ok: true, file: string } | { ok: false, file?: string, reason: string }>
}

declare module '@dotrino/identity/assertion' {
  export function verifySignedFor (args: {
    data?: unknown, signature?: string, publickey?: string, chain?: unknown[], audience?: string, now?: number
  }): Promise<{ ok: true, profileId: string, signer: string, seq: number, aud: string } | { ok: false, reason: string }>
}

declare module '@dotrino/identity/keyid' {
  export function pubkeyId (publicJwk: string | JsonWebKey): Promise<string>
}

declare module '@dotrino/identity/capabilities' {
  export function keyLabel (publicJwk: string | JsonWebKey): Promise<string>
}

declare module '@dotrino/pay' {
  export interface PayPalClient {
    provider: 'paypal'
    live: boolean
    createSubscription (o: { planId: string, customId: string, returnUrl: string, cancelUrl: string, brand?: string }): Promise<{ id: string, approveUrl: string }>
    getSubscription (id: string): Promise<{ id: string, status: string, planId: string, customId: string | null, paidThrough: number | null }>
    cancelSubscription (id: string, reason?: string): Promise<void>
    subscriptionPayments (id: string, range: { since: number, until: number }): Promise<Array<{ id: string, status: string, amount: string | null, time: number }>>
    refundCapture (captureId: string, opts?: { note?: string }): Promise<{ id: string, status: string }>
    verifyWebhook (o: { headers: Record<string, string | string[] | undefined>, event: unknown, webhookId: string }): Promise<boolean>
    createProduct (o: { name: string, description: string }): Promise<{ id: string }>
    createPlan (o: { productId: string, name: string, price: string, taxPercent: number }): Promise<{ id: string }>
    createWebhook (o: { url: string, eventTypes: string[] }): Promise<{ id: string }>
    listWebhooks (): Promise<Array<{ id: string, url: string }>>
  }
  // clientId/secret pueden faltar: paypalClient lo comprueba y lanza.
  export function paypalClient (o: { clientId: string | undefined, secret: string | undefined, live?: boolean, fetch?: typeof fetch }): PayPalClient
  export function priceWithTax (o: { unitCents: number, quantity?: number, taxPercent: number }): { subtotal: string, tax: string, total: string }
}
