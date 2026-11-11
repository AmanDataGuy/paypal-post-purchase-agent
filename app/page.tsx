/**
 * # page.tsx (/) - landing page: what this is, and links into the demo
 */
import Link from "next/link";

export default function Home() {
  return (
    <main className="mx-auto max-w-3xl space-y-10 px-6 py-16">
      <header className="space-y-4">
        <p className="text-sm uppercase tracking-wide text-neutral-500">PayPal sandbox demo · Juniper &amp; Pine ceramics</p>
        <h1 className="text-4xl font-semibold leading-tight">Fix the order before it becomes a PayPal dispute.</h1>
        <p className="text-lg text-neutral-600">
          The shop&apos;s agent answers the customer, and the customer&apos;s own AI agent. It reads the real PayPal order and
          tracking, then refunds, holds for the owner, or refuses with a reason. Every money move passes a policy gate in code:
          the model can ask, it can&apos;t override.
        </p>
      </header>
      <nav className="grid gap-4 sm:grid-cols-3">
        <Link href="/support" className="rounded border p-4 hover:bg-neutral-50">
          <p className="font-medium">Talk to support →</p>
          <p className="text-sm text-neutral-500">Try JP-1042 with sam@example.test</p>
        </Link>
        <Link href="/console" className="rounded border p-4 hover:bg-neutral-50">
          <p className="font-medium">Merchant console →</p>
          <p className="text-sm text-neutral-500">Approvals, PayPal cases, audit trail</p>
        </Link>
        <div className="rounded border p-4">
          <p className="font-medium">Buyer AI agents</p>
          <p className="text-sm text-neutral-500">
            MCP endpoint: <code className="font-mono">/api/mcp</code>
          </p>
        </div>
      </nav>
    </main>
  );
}
