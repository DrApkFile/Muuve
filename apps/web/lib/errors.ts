import { ApiError } from "./api";

// Plain-language copy for the backend's stable error codes. Never show raw codes or provider text.
const COPY: Record<string, string> = {
  network_error: "You seem to be offline. Check your connection and try again.",
  unauthorized: "Your session has ended. Log in again to continue.",
  invalid_origin: "This page can't reach Muuve from here. Open it at the Muuve address.",
  rate_limited: "Too many tries. Wait a few minutes, then try again.",
  invalid_code: "That code isn't right. Check it and try again.",
  invalid_challenge: "That code has expired or had too many tries. Send a new one.",
  invalid_wallet_challenge: "That sign-in request expired. Try connecting again.",
  channel_unavailable: "WhatsApp codes aren't available right now. Use SMS instead.",
  not_on_payment: "This number isn't on this payment. Check with the sender.",
  link_expired: "This payment has passed its 48-hour window.",
  not_funded: "This payment isn't ready yet. Try again in a moment.",
  slot_not_funded: "This money has already been claimed, recalled or returned.",
  self_payment: "You can't send money to your own number.",
  outstanding_limit:
    "You've hit the $1,000 limit for unclaimed money. Recall or wait for claims first.",
  funding_limit: "That's over today's $200 limit for test dollars.",
  wallet_required: "Connect a wallet to your account first.",
  quote_expired: "That rate expired. We've fetched a new one.",
  account_not_found: "We couldn't find that account. Check the number and bank.",
  transaction_message_mismatch:
    "Your wallet changed the transaction. Approve it again without edits.",
  invalid_transaction_signatures: "The signature didn't match. Approve it again in your wallet.",
  operation_conflict: "This request changed since it was prepared. Start again.",
  idempotency_conflict: "This request changed since it was prepared. Start again.",
  link_id_conflict: "That link already exists. Start a new payment.",
  retry_not_available: "This payout can't be retried right now.",
  claim_intent_required: "Start the claim again to continue.",
  devnet_required: "Test dollars are only available on the demo network.",
  invalid_request: "Something in that request wasn't valid. Check the details.",
  wallet_rejected: "You cancelled the request in your wallet.",
  wallet_unsupported: "This wallet can't sign the request. Try Phantom, Solflare or Backpack.",
};

export function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    const known = COPY[error.code];
    if (known) return known;
    if (error.status === 429) return COPY.rate_limited!;
    if (error.status === 401) return COPY.unauthorized!;
    const ref = error.requestId ? ` (ref ${error.requestId.slice(0, 8)})` : "";
    return `Something went wrong. Try again.${ref}`;
  }
  if (error instanceof Error && COPY[error.message]) return COPY[error.message]!;
  return "Something went wrong. Try again.";
}

export function isCode(error: unknown, ...codes: string[]) {
  return error instanceof ApiError && codes.includes(error.code);
}
