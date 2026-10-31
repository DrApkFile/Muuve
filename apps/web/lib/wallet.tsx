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
import { getWallets } from "@wallet-standard/app";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import {
  SolanaSignMessage,
  SolanaSignTransaction,
  type SolanaSignMessageFeature,
  type SolanaSignTransactionFeature,
} from "@solana/wallet-standard-features";

// Talks to browser wallets (Phantom, Solflare, Backpack…) through the Wallet Standard.
// Muuve only ever asks for two things: sign a login/claim-key message, and sign an
// exact server-prepared transaction. We never send transactions from the browser.

const CHAIN = "solana:devnet";
const STORAGE_KEY = "muuve.wallet";

type ConnectFeature = {
  "standard:connect": {
    connect(input?: { silent?: boolean }): Promise<{ accounts: readonly WalletAccount[] }>;
  };
};
type DisconnectFeature = { "standard:disconnect": { disconnect(): Promise<void> } };
type EventsFeature = {
  "standard:events": {
    on(
      event: "change",
      listener: (props: { accounts?: readonly WalletAccount[] }) => void,
    ): () => void;
  };
};

function isUsable(wallet: Wallet) {
  return (
    "standard:connect" in wallet.features &&
    SolanaSignMessage in wallet.features &&
    SolanaSignTransaction in wallet.features &&
    wallet.chains.some((c) => c.startsWith("solana:"))
  );
}

type WalletContextValue = {
  wallets: readonly Wallet[];
  wallet: Wallet | null;
  account: WalletAccount | null;
  address: string | null;
  connecting: boolean;
  connect(wallet: Wallet): Promise<string>;
  disconnect(): Promise<void>;
  signMessage(message: Uint8Array): Promise<Uint8Array>;
  signTransaction(serialized: Uint8Array): Promise<Uint8Array>;
};

const WalletContext = createContext<WalletContextValue | null>(null);

function rejected(error: unknown): never {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  if (/reject|denied|cancel|declined|closed/i.test(text)) throw new Error("wallet_rejected");
  if (/chain id|network|cluster/i.test(text)) throw new Error("wallet_wrong_network");
  throw error;
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [wallets, setWallets] = useState<readonly Wallet[]>([]);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [account, setAccount] = useState<WalletAccount | null>(null);
  const [connecting, setConnecting] = useState(false);
  // Signing right after connect (same click) must see the new wallet, not the last render's.
  const current = useRef<{ wallet: Wallet | null; account: WalletAccount | null }>({
    wallet: null,
    account: null,
  });

  useEffect(() => {
    const registry = getWallets();
    const refresh = () => setWallets(registry.get().filter(isUsable));
    refresh();
    const offRegister = registry.on("register", refresh);
    const offUnregister = registry.on("unregister", refresh);
    return () => {
      offRegister();
      offUnregister();
    };
  }, []);

  const connectWith = useCallback(async (target: Wallet, silent: boolean) => {
    const feature = (target.features as unknown as ConnectFeature)["standard:connect"];
    const { accounts } = await feature.connect(silent ? { silent: true } : undefined);
    const next = accounts.find((a) => a.chains.some((c) => c.startsWith("solana:"))) ?? accounts[0];
    if (!next) throw new Error("wallet_rejected");
    current.current = { wallet: target, account: next };
    setWallet(target);
    setAccount(next);
    try {
      localStorage.setItem(STORAGE_KEY, target.name);
    } catch {}
    return next.address;
  }, []);

  // Quietly reconnect the wallet used last time, without a popup.
  useEffect(() => {
    if (wallet || !wallets.length) return;
    let remembered: string | null = null;
    try {
      remembered = localStorage.getItem(STORAGE_KEY);
    } catch {}
    const match = wallets.find((w) => w.name === remembered);
    if (match) connectWith(match, true).catch(() => {});
  }, [wallets, wallet, connectWith]);

  // Follow account switches inside the wallet.
  useEffect(() => {
    if (!wallet || !("standard:events" in wallet.features)) return;
    const events = (wallet.features as unknown as EventsFeature)["standard:events"];
    return events.on("change", ({ accounts }) => {
      if (!accounts) return;
      current.current = { wallet, account: accounts[0] ?? null };
      setAccount(accounts[0] ?? null);
    });
  }, [wallet]);

  const value = useMemo<WalletContextValue>(
    () => ({
      wallets,
      wallet,
      account,
      address: account?.address ?? null,
      connecting,
      async connect(target) {
        setConnecting(true);
        try {
          return await connectWith(target, false);
        } catch (error) {
          rejected(error);
        } finally {
          setConnecting(false);
        }
      },
      async disconnect() {
        try {
          localStorage.removeItem(STORAGE_KEY);
        } catch {}
        if (wallet && "standard:disconnect" in wallet.features)
          await (wallet.features as unknown as DisconnectFeature)["standard:disconnect"]
            .disconnect()
            .catch(() => {});
        current.current = { wallet: null, account: null };
        setWallet(null);
        setAccount(null);
      },
      async signMessage(message) {
        const { wallet, account } = current.current;
        if (!wallet || !account) throw new Error("wallet_required");
        const feature = (wallet.features as unknown as SolanaSignMessageFeature)[SolanaSignMessage];
        try {
          const [out] = await feature.signMessage({ account, message });
          if (!out) throw new Error("wallet_unsupported");
          return out.signature;
        } catch (error) {
          rejected(error);
        }
      },
      async signTransaction(serialized) {
        const { wallet, account } = current.current;
        if (!wallet || !account) throw new Error("wallet_required");
        const feature = (wallet.features as unknown as SolanaSignTransactionFeature)[
          SolanaSignTransaction
        ];
        if (!feature.supportedTransactionVersions.includes("legacy"))
          throw new Error("wallet_unsupported");
        try {
          const [out] = await feature.signTransaction({
            account,
            transaction: serialized,
            chain: CHAIN,
          });
          if (!out) throw new Error("wallet_unsupported");
          return out.signedTransaction;
        } catch (error) {
          rejected(error);
        }
      },
    }),
    [wallets, wallet, account, connecting, connectWith],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet() {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be used inside WalletProvider");
  return ctx;
}
