// Trusted provider boundary for PROTECTED execution (offering redesign v2,
// spec §8.2). A buyer-supplied URL is never a trusted executor just because it
// parses. Private user-owned pipelines keep their own endpoints; this module
// only decides whether a seller's protected workflow may run through one.
//
// What it enforces, in order, at the moment a run is created (so a refusal
// costs nothing): payer ownership of the provider record, the provider being
// enabled, https with no embedded credentials, a public (non-private,
// non-link-local, non-metadata) address, and an EXACT row in
// `trusted_provider_endpoints` — which ships EMPTY, so protected execution is
// off until an admin approves each destination and records its logging
// disclosure.
//
// What it deliberately does NOT claim: see PROTECTED_EGRESS_RESIDUAL_RISKS.
// §8.2 forbids presenting an allowlist as a secrecy guarantee, so the residual
// risks are part of the returned decision and shown to callers, not hidden.

import { and, eq } from "drizzle-orm";
import { llmProviders, trustedProviderEndpoints } from "@db/schema";
import { getDb } from "../queries/connection";
import { logger } from "../lib/logger";

export const PROTECTED_EGRESS_POLICY_VERSION = "v2-egress-1";

/** Honest limits of this boundary. Disclosed with every protected run so no
 *  reader infers a guarantee the platform does not make (§8.2). */
export const PROTECTED_EGRESS_RESIDUAL_RISKS = [
  "Prompts necessarily leave DeeWaanAI for the approved LLM endpoint; the platform cannot hide them from that provider.",
  "An approved provider may log requests or retain inputs for its credential owner. The recorded logging disclosure states which class applies; it is a disclosure, not a control.",
  "Endpoint approval is checked at admission and again at dispatch. A DNS name that resolves to a different address between those checks (rebinding) is not prevented by this layer.",
  "Output inference is out of reach of any endpoint policy: a determined buyer can probe the workflow through its permitted outputs.",
] as const;

export class EgressPolicyError extends Error {
  readonly code: string;
  constructor(code: string, detail: string) {
    super(`egress_${code}: ${detail}`);
    this.code = code;
    this.name = "EgressPolicyError";
  }
}

export interface ApprovedEndpoint {
  endpointId: number;
  provider: string;
  baseUrl: string;
  adapterKind: string;
  endpointClass: "first_party" | "approved_proxy";
  protectionClass: "standard" | "reduced";
  loggingDisclosure: string;
  policyVersion: string;
}

/** The adapter `createProviderAdapter` will actually build. Kept next to the
 *  routing rule in api/lib/providers/index.ts — if that routing changes, this
 *  must change with it, because the approved row names the adapter. */
export function resolvedAdapterKind(slug: string): "anthropic" | "openai_compatible" {
  return slug === "anthropic" ? "anthropic" : "openai_compatible";
}

/** Block-literal and private-range hostnames. Compared on the URL the request
 *  will actually use, after normalization, so `http://127.0.0.1:8000` and
 *  `http://[::1]/` are both caught, as is the cloud metadata address. */
const BLOCKED_HOSTS = new Set(["localhost", "metadata.google.internal", "0.0.0.0", "[::]", "[::1]"]);

export function blockedHostReason(hostname: string): string | null {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (BLOCKED_HOSTS.has(host) || BLOCKED_HOSTS.has(hostname.toLowerCase())) return "loopback or internal hostname";
  if (host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".localhost")) return "internal mDNS/UTC hostname";
  // IPv4, including the decimal/octal/hex forms that sneak past string checks.
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4 && ipv4.length === 5) {
    const octets = ipv4.slice(1).map(Number);
    if (octets.some((o) => !Number.isFinite(o) || o > 255)) return "malformed IPv4 literal";
    const [a, b] = octets;
    if (a === 127 || a === 10 || a === 0) return "private or loopback IPv4";
    if (a === 169 && b === 254) return "link-local IPv4 (cloud metadata)";
    if (a === 172 && b >= 16 && b <= 31) return "private IPv4 (172.16/12)";
    if (a === 192 && b === 168) return "private IPv4 (192.168/16)";
    if (a === 100 && b >= 64 && b <= 127) return "CGNAT range (100.64/10)";
    return null;
  }
  if (host.includes(":")) {
    const v6 = host.toLowerCase();
    if (v6 === "::1" || v6.startsWith("fe80") || v6.startsWith("fc") || v6.startsWith("fd")) return "private or link-local IPv6";
    if (/^(::f{4}:)?(\d{1,3}\.){3}\d{1,3}$/.test(v6)) {
      const inner = v6.split(":").pop() ?? "";
      return blockedHostReason(inner) ?? "IPv4-mapped IPv6 literal";
    }
    return null;
  }
  // A hostname that is not a literal is allowed only if an approved row names
  // it exactly; no suffix or wildcard matching is performed here.
  return null;
}

/** Canonical form used for BOTH the comparison and the stored row: scheme, host
 *  lower-cased, default port dropped, no trailing slash, no query or fragment.
 *  Anything that could carry a second destination is rejected outright. */
export function normalizeEndpointUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new EgressPolicyError("url_unparseable", "the configured endpoint is not an absolute URL");
  }
  if (url.protocol !== "https:") {
    throw new EgressPolicyError("insecure_transport", `protected runs require https, got '${url.protocol.replace(":", "")}'`);
  }
  if (url.username || url.password) {
    throw new EgressPolicyError("embedded_credentials", "credential forwarding to another origin is not permitted");
  }
  if (url.search || url.hash) {
    throw new EgressPolicyError("url_has_query_or_fragment", "a query string or fragment could carry a different destination than the approved path");
  }
  const reason = blockedHostReason(url.hostname);
  if (reason) throw new EgressPolicyError("blocked_destination", `${reason} is never a trusted executor`);
  const port = url.port && url.port !== "443" ? `:${url.port}` : "";
  return `${url.protocol}//${url.hostname.toLowerCase()}${port}${url.pathname.replace(/\/+$/, "")}`;
}

/**
 * Resolve the endpoint a protected run may use, or refuse. The provider must
 * belong to the authorized PAYER (never inherited from the seller), be enabled,
 * and match one approved, enabled allowlist row exactly on provider slug +
 * normalized base URL + adapter identity.
 */
export async function assertTrustedEgress(opts: {
  provider: typeof llmProviders.$inferSelect;
  payerId: number;
}): Promise<ApprovedEndpoint> {
  const { provider, payerId } = opts;
  if (provider.userId !== payerId) {
    throw new EgressPolicyError("provider_not_payers", "the provider binding does not belong to the authorized payer");
  }
  if (provider.isEnabled === false) {
    throw new EgressPolicyError("provider_disabled", "the provider binding is disabled");
  }
  const normalized = normalizeEndpointUrl(provider.baseUrl);
  const adapterKind = resolvedAdapterKind(provider.slug);

  const db = getDb();
  const rows = await db.select().from(trustedProviderEndpoints)
    .where(and(
      eq(trustedProviderEndpoints.provider, provider.slug),
      eq(trustedProviderEndpoints.enabled, true),
    ));
  // Compare on the normalized form so an approved row cannot be satisfied by a
  // differently-cased, trailing-slash or default-port variant of the same URL.
  const match = rows.find((r) => {
    try {
      return normalizeEndpointUrl(r.baseUrl) === normalized && r.adapterKind === adapterKind;
    } catch {
      return false; // a malformed row simply never matches; it is not an error for the caller
    }
  });
  if (!match) {
    throw new EgressPolicyError(
      "endpoint_not_approved",
      `${normalized} (adapter ${adapterKind}) is not on the approved endpoint list for protected execution`,
    );
  }
  if (match.protectionClass === "reduced") {
    logger.warn("protected run on a REDUCED-protection endpoint", {
      endpointId: match.id, provider: match.provider, policyVersion: match.policyVersion,
    });
  }
  return {
    endpointId: match.id,
    provider: match.provider,
    baseUrl: normalized,
    adapterKind: match.adapterKind,
    endpointClass: match.endpointClass,
    protectionClass: match.protectionClass,
    loggingDisclosure: match.loggingDisclosure,
    policyVersion: match.policyVersion,
  };
}
