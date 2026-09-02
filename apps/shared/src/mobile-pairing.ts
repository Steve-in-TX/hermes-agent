/**
 * Phone pairing payload — what the dashboard renders as a QR code and the
 * Android app scans. It carries WHERE the gateway is, never a credential:
 * sign-in (RFC 8252 in the system browser) always follows.
 *
 *   hermes-gateway:{"v":1,"origin":"https://gw.example:9119","basePath":"","name":"studio"}
 *
 * A bare http(s) URL is accepted on decode too, so any QR that just holds
 * the gateway address works.
 */

export const PAIRING_SCHEME = 'hermes-gateway:'

export interface PairingPayload {
  v: 1
  origin: string
  basePath: string
  name?: string
}

function normalizeBasePath(raw: string | undefined): string {
  if (!raw) return ''
  const withLead = raw.startsWith('/') ? raw : `/${raw}`
  return withLead.replace(/\/+$/, '')
}

function parseGatewayUrl(input: string): { origin: string; basePath: string } | null {
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  return { origin: url.origin, basePath: normalizeBasePath(url.pathname) }
}

export function encodePairingPayload(payload: { origin: string; basePath?: string; name?: string }): string {
  const parsed = parseGatewayUrl(`${payload.origin}${normalizeBasePath(payload.basePath)}`)
  if (!parsed) throw new Error('pairing payload needs an http(s) origin')
  const body: PairingPayload = { v: 1, origin: parsed.origin, basePath: parsed.basePath }
  const name = payload.name?.trim()
  if (name) body.name = name.slice(0, 64)
  return `${PAIRING_SCHEME}${JSON.stringify(body)}`
}

export function decodePairingPayload(text: string): PairingPayload | null {
  const trimmed = text.trim()
  if (trimmed.startsWith(PAIRING_SCHEME)) {
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed.slice(PAIRING_SCHEME.length))
    } catch {
      return null
    }
    if (typeof parsed !== 'object' || parsed === null) return null
    const rec = parsed as Record<string, unknown>
    if (rec.v !== 1 || typeof rec.origin !== 'string') return null
    const url = parseGatewayUrl(`${rec.origin}${normalizeBasePath(typeof rec.basePath === 'string' ? rec.basePath : '')}`)
    if (!url) return null
    return {
      v: 1,
      origin: url.origin,
      basePath: url.basePath,
      ...(typeof rec.name === 'string' && rec.name.trim() ? { name: rec.name.trim().slice(0, 64) } : {})
    }
  }
  const url = parseGatewayUrl(trimmed)
  return url ? { v: 1, origin: url.origin, basePath: url.basePath } : null
}

/** Stable key for a gateway in registries and token stores. */
export function gatewayKey(origin: string, basePath: string): string {
  return `${origin.replace(/\/+$/, '')}${normalizeBasePath(basePath)}`
}
