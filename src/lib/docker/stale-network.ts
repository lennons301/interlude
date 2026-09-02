/**
 * A container whose network was recreated under it (issue #190) — the pure half
 * of the self-heal `startContainer` performs around it.
 *
 * The shape: `docker compose down` removed the `interlude` network and `up -d`
 * recreated it with a new ID, while every parked agent container (stopped but
 * preserved since #93) still referenced the old one. Their next start then
 * failed permanently, and the queue retried it every 2s forever. The root cause
 * is fixed in `docker-compose.yml` (the network is external now, so no deploy
 * destroys it) — this exists for the containers already orphaned, and for any
 * other way a network gets recreated under a stopped container.
 */

/** The endpoint config to restore when reattaching. */
export interface NetworkReattach {
  network: string;
  aliases: string[];
}

/**
 * Does this start failure mean the container's network was recreated under it?
 *
 * Deliberately not a check on the 404: the daemon's message leads with
 * "no such container" for a container that is demonstrably there, so the status
 * code cannot tell this apart from a container that really has been removed —
 * and reattaching a removed container would be a pointless second failure. The
 * networking clause is the only part of the message that identifies the fault.
 */
export function isRecreatedNetworkFailure(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? "");
  return (
    message.includes("failed to set up container networking") &&
    /network\s+\S+\s+not found/.test(message)
  );
}

/**
 * What to restore when reattaching, read from the container's own inspect
 * output rather than recomputed from the task row.
 *
 * The aliases are the reason this is not a bare `network connect`: a container
 * network alias is what Docker DNS resolves for the preview subdomain
 * (`task-<shortid>` matches the subdomain prefix Caddy proxies to), so dropping
 * it reattaches the container and breaks its preview silently. Docker keeps
 * `Aliases` in the endpoint config even once `NetworkID` has been emptied by the
 * network's removal, so the container is its own source of truth here.
 *
 * Null when the container is not on that network at all — nothing to restore,
 * and its start failed for some other reason.
 */
export function planNetworkReattach(
  networks: Record<string, { Aliases?: string[] | null }> | undefined,
  networkName: string
): NetworkReattach | null {
  const endpoint = networks?.[networkName];
  if (!endpoint) return null;
  return { network: networkName, aliases: endpoint.Aliases ?? [] };
}
