import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { Button } from "./ui/button";

interface Connection {
  enabled: boolean;
  resourceUrl: string | null;
  binding: { id: string; status: string; connected: boolean; subscriptionVerified: boolean; hasPendingChallenge: boolean;
    assignment?: { status: string; attentionRequired: boolean } | null } | null;
}

/** Pairing codes stay in component memory and expire; never save them in config. */
export function DotRunnerConnection({ companyId, agentId, bindingId, onBinding }: {
  companyId?: string; agentId?: string; bindingId?: string; onBinding: (id: string) => void;
}) {
  const client = useQueryClient();
  const [pairing, setPairing] = useState<{ pairingCode: string; expiresAt: string } | null>(null);
  const path = `/companies/${companyId}/agents/${agentId}/dot-binding`;
  const key = ["dot-binding", companyId, agentId];
  const state = useQuery({ queryKey: key, enabled: !!companyId && !!agentId,
    queryFn: () => api.get<Connection>(path),
    refetchInterval: query => query.state.data?.binding?.status === "pairing" ||
      (query.state.data?.binding?.connected && !query.state.data.binding.subscriptionVerified) ||
      query.state.data?.binding?.hasPendingChallenge || query.state.data?.binding?.assignment ? 5000 : false });
  const pair = useMutation({ mutationFn: () => api.post<{ bindingId: string; pairingCode: string; expiresAt: string }>(path, {}),
    onSuccess: result => { setPairing(result); onBinding(result.bindingId); void client.invalidateQueries({ queryKey: key }); } });
  const test = useMutation({ mutationFn: () => api.post(path + "/event-test", {}),
    onSuccess: () => { void client.invalidateQueries({ queryKey: key }); } });
  const revoke = useMutation({ mutationFn: () => api.delete(path),
    onSuccess: async () => {
      await client.cancelQueries({ queryKey: key });
      client.setQueryData<Connection>(key, previous => previous ? { ...previous, binding: null } : previous);
      setPairing(null); onBinding("");
      await client.invalidateQueries({ queryKey: key });
    } });
  const existingBindingId = state.data?.binding?.id;
  useEffect(() => {
    if (existingBindingId && existingBindingId !== bindingId && !revoke.isPending) onBinding(existingBindingId);
  }, [existingBindingId, bindingId, onBinding, revoke.isPending]);
  if (!agentId) return <p className="text-sm text-muted-foreground">Save the agent, then return here to pair your Dot.</p>;
  const error = state.error ?? pair.error ?? test.error ?? revoke.error;
  const b = state.data?.binding;
  return <div className="space-y-3">
    <p className="text-sm text-muted-foreground">Dot manages its model and external tools. Paperclip supplies task tools through a dedicated agent connection. Provider usage and cost are unavailable; stopping a Paperclip run revokes access without confirming an external stop.</p>
    {state.data && !state.data.enabled && <p className="text-sm text-muted-foreground">This instance has not enabled OpenAI Dot.</p>}
    {state.data?.resourceUrl && <p className="text-sm break-all">Private plugin MCP URL: <code>{state.data.resourceUrl}</code></p>}
    {b && <p className="text-sm">Connection: {b.status}. Event subscription: {b.subscriptionVerified ? "verified" : "required"}.</p>}
    {b?.assignment && <p className="text-sm">Assignment: {b.assignment.status === "offered" ? "waiting for Dot to accept" : "accepted by Dot"}.</p>}
    {b?.assignment?.attentionRequired && <p className="text-sm text-destructive" role="alert">Dot has not reported useful activity for 15 minutes. Inspect the Dot before assigning replacement work; Paperclip cannot confirm its external stop.</p>}
    {pairing && b?.status === "pairing" && <div className="space-y-2 rounded-md border border-border p-3">
      <p className="text-sm">Connect the private plugin in your Dot and approve agent access. Ask it to call <code>paperclip_dot_pair</code> with this code, then subscribe to <code>paperclip.dot.mailbox_updated</code> for the returned binding.</p>
      <code className="text-sm break-all">{pairing.pairingCode}</code>
      <p className="text-xs text-muted-foreground">Expires {new Date(pairing.expiresAt).toLocaleTimeString()}.</p>
    </div>}
    {!pairing && b?.status === "pairing" && <p className="text-sm text-muted-foreground">This page no longer has the one-use code. Revoke the pending connection and pair again to generate a fresh code.</p>}
    <div className="flex flex-wrap items-center gap-2">
      {!b && <Button type="button" variant="outline" disabled={!state.data?.enabled || !state.data?.resourceUrl || pair.isPending} onClick={() => pair.mutate()}>Pair Dot</Button>}
      {b?.subscriptionVerified && <Button type="button" variant="outline" disabled={test.isPending || b.hasPendingChallenge} onClick={() => test.mutate()}>Test event delivery</Button>}
      <Button type="button" variant="outline" onClick={() => { void state.refetch(); }}>Refresh connection</Button>
      {b && <Button type="button" variant="outline" disabled={revoke.isPending} onClick={() => revoke.mutate()}>Revoke connection</Button>}
    </div>
    {b?.hasPendingChallenge && <p className="text-sm text-muted-foreground">Waiting for Dot to read and confirm the harmless mailbox challenge.</p>}
    {error && <p className="text-sm text-destructive" role="alert">{error instanceof Error ? error.message : "Connection failed"}</p>}
  </div>;
}
