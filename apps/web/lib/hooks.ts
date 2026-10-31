"use client";

import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type Balance, type LinkDetail, type LinkSummary } from "./api";

const BALANCE_EVENT = "muuve:balance-changed";

type Resource<T> = {
  data: T | null;
  error: unknown;
  loading: boolean;
  reload(): Promise<void>;
};

function useResource<T>(path: string | null, events: string[] = []): Resource<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(!!path);

  const reload = useCallback(async () => {
    if (!path) return;
    try {
      setData(await api<T>(path));
      setError(null);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    void reload();
    const handler = () => void reload();
    for (const e of events) window.addEventListener(e, handler);
    return () => {
      for (const e of events) window.removeEventListener(e, handler);
    };
  }, [reload]);

  return { data, error, loading, reload };
}

export function useBalance() {
  return useResource<Balance>("/api/balance", [BALANCE_EVENT]);
}

export function useLinks() {
  const res = useResource<{ links: LinkSummary[] }>("/api/links", [BALANCE_EVENT]);
  return { ...res, links: res.data?.links ?? [] };
}

/** One link, polled every 5s while any money is still waiting or moving (2s while confirming). */
export function useLink(id: string) {
  const res = useResource<{ link: LinkDetail }>(`/api/links/${id}`, [BALANCE_EVENT]);
  const link = res.data?.link ?? null;
  const confirming = link?.status === "pending";
  const active =
    confirming || !!link?.slots.some((s) => s.status === "funded" || s.status === "cashing_out");
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => void res.reload(), confirming ? 2000 : 5000);
    return () => clearInterval(t);
  }, [active, confirming, res.reload]);
  return { ...res, link, notFound: res.error instanceof ApiError && res.error.status === 404 };
}

/** Ticking clock for countdowns. */
export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
