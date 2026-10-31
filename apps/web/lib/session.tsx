"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { api, ApiError, type User } from "./api";

type SessionValue = {
  user: User | null;
  loading: boolean;
  reload(): Promise<User | null>;
  logout(): Promise<void>;
  setUser(user: User | null): void;
};

const SessionContext = createContext<SessionValue | null>(null);
const REFRESH_KEY = "muuve.refreshedAt";
const REFRESH_EVERY_MS = 12 * 60 * 60 * 1000;

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const refreshing = useRef<Promise<unknown> | null>(null);

  const reload = useCallback(async () => {
    try {
      const res = await api<{ user: User }>("/api/me");
      setUser(res.user);
      return res.user;
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) setUser(null);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload().then((u) => {
      if (!u) return;
      // Rotate the session about twice a day; one refresh at a time.
      let last = 0;
      try {
        last = Number(localStorage.getItem(REFRESH_KEY) ?? 0);
      } catch {}
      if (Date.now() - last < REFRESH_EVERY_MS || refreshing.current) return;
      refreshing.current = api("/api/auth/refresh", {})
        .then(() => {
          try {
            localStorage.setItem(REFRESH_KEY, String(Date.now()));
          } catch {}
        })
        .catch(() => {})
        .finally(() => (refreshing.current = null));
    });
  }, [reload]);

  const logout = useCallback(async () => {
    await api("/api/auth/logout", {}).catch(() => {});
    try {
      localStorage.removeItem(REFRESH_KEY);
    } catch {}
    setUser(null);
  }, []);

  const value = useMemo(
    () => ({ user, loading, reload, logout, setUser }),
    [user, loading, reload, logout],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used inside SessionProvider");
  return ctx;
}
