/**
 * # page.tsx (/support) - customer support page: the chat plus a live trace of PayPal API calls
 */
import Chat from "./chat";

export default function SupportPage() {
  return (
    <main className="mx-auto max-w-5xl p-6">
      <h1 className="mb-1 text-2xl font-semibold">Juniper &amp; Pine support</h1>
      <p className="mb-6 text-neutral-500">Ask about an order. You&apos;ll need your order number and the email you used at checkout.</p>
      <Chat />
    </main>
  );
}
