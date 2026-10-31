// Feature gates from docs/frontend-integration.md. Public, non-secret build-time flags.

/** Recipient claim intents, mock cash-out and account cash-out. Off until the backend
 *  handoff's hosted recipient/treasury/worker checks pass. */
export const CLAIMS_ENABLED = process.env.NEXT_PUBLIC_CLAIMS_ENABLED === "true";

/** "Keep in dollars": the recipient creates a Muuve account and the server generates a
 *  Privy embedded wallet for it. Follows the claims gate. */
export const KEEP_ENABLED = CLAIMS_ENABLED;

/** WhatsApp codes stay off while the backend sends through Textbee (SMS only). */
export const WHATSAPP_ENABLED = process.env.NEXT_PUBLIC_WHATSAPP_OTP_ENABLED === "true";
