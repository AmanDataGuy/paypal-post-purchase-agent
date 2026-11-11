/**
 * # page.tsx (/console) - merchant console: refunds waiting for approval, and the audit trail of every tool call
 *
 * - Server component; reads the DB per request. Actions live in ./actions.ts.
 */
import { desc, eq, ne } from "drizzle-orm";
import { connection } from "next/server";
import { getDb } from "@/lib/db/client";
import { approvals, cases, orders, toolCalls } from "@/lib/db/schema";
import { fromCents } from "@/lib/money";
import { decide, isMerchant, prepareEvidence, signIn, submitEvidenceAction, syncCasesAction } from "./actions";

export default async function ConsolePage() {
  await connection();
  if (!(await isMerchant()))
    return (
      <main className="mx-auto max-w-sm p-8">
        <h1 className="mb-4 text-xl font-semibold">Merchant console</h1>
        <form action={signIn} className="flex gap-2">
          <input name="passcode" type="password" placeholder="Passcode" aria-label="Passcode" className="flex-1 rounded border px-3 py-2" />
          <button className="rounded bg-black px-4 py-2 text-white">Sign in</button>
        </form>
      </main>
    );

  const db = await getDb();
  const pending = await db
    .select({ id: approvals.id, orderNumber: orders.orderNumber, payload: approvals.payload, reason: approvals.decisionReason, createdAt: approvals.createdAt })
    .from(approvals)
    .innerJoin(orders, eq(approvals.orderId, orders.id))
    .where(eq(approvals.status, "PENDING"))
    .orderBy(desc(approvals.createdAt));
  const trail = await db.select().from(toolCalls).orderBy(desc(toolCalls.createdAt)).limit(30);
  const openCases = await db
    .select({ id: cases.id, orderNumber: orders.orderNumber, reason: cases.reason, status: cases.status, amountCents: cases.amountCents, dueAt: cases.dueAt, evidence: cases.evidence })
    .from(cases)
    .leftJoin(orders, eq(cases.orderId, orders.id))
    .where(ne(cases.status, "RESOLVED"))
    .orderBy(desc(cases.updatedAt));

  return (
    <main className="mx-auto max-w-5xl space-y-10 p-8">
      <section>
        <h1 className="mb-4 text-xl font-semibold">Waiting for your approval ({pending.length})</h1>
        {pending.length === 0 && <p className="text-neutral-500">Nothing waiting.</p>}
        <ul className="space-y-3">
          {pending.map((a) => (
            <li key={a.id} className="flex items-center justify-between rounded border p-4">
              <div>
                <p className="font-medium">
                  {a.orderNumber}: refund ${fromCents(a.payload.amountCents)} ({a.payload.reason.toLowerCase().replaceAll("_", " ")})
                </p>
                <p className="text-sm text-neutral-500">
                  Asked by {a.payload.caller === "BUYER_AGENT" ? "the customer's AI agent" : "the customer"} · held because {a.reason.replaceAll("_", " ")}
                </p>
              </div>
              <form action={decide} className="flex gap-2">
                <input type="hidden" name="id" value={a.id} />
                <button name="approve" value="1" className="rounded bg-black px-3 py-1.5 text-white">Approve</button>
                <button name="approve" value="0" className="rounded border px-3 py-1.5">Deny</button>
              </form>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">PayPal cases ({openCases.length})</h2>
          <form action={syncCasesAction}><button className="rounded border px-3 py-1.5 text-sm">Sync from PayPal</button></form>
        </div>
        {openCases.length === 0 && <p className="text-neutral-500">No cases. Most problems are solved in support before they get here.</p>}
        <ul className="space-y-3">
          {openCases.map((c) => {
            const ev = c.evidence as { input?: { evidences: { evidence_type: string; notes: string }[] }; submittedAt?: string } | null;
            return (
              <li key={c.id} className="rounded border p-4">
                <p className="font-medium">
                  {c.orderNumber ?? "Unlinked order"} · ${fromCents(c.amountCents)} · {c.reason.toLowerCase().replaceAll("_", " ")}
                </p>
                <p className="text-sm text-neutral-500">
                  {c.id} · {c.status.toLowerCase().replaceAll("_", " ")}
                  {c.dueAt && ` · respond by ${c.dueAt.toISOString().slice(0, 10)}`}
                </p>
                {ev?.input && (
                  <ul className="mt-2 space-y-1 text-sm">
                    {ev.input.evidences.map((e, i) => (
                      <li key={i}><span className="font-mono text-xs">{e.evidence_type}</span> {e.notes}</li>
                    ))}
                  </ul>
                )}
                <div className="mt-3 flex gap-2">
                  {c.orderNumber && !ev?.submittedAt && (
                    <form action={prepareEvidence}><input type="hidden" name="id" value={c.id} /><button className="rounded border px-3 py-1.5 text-sm">{ev?.input ? "Rebuild evidence" : "Prepare evidence"}</button></form>
                  )}
                  {ev?.input && !ev.submittedAt && (
                    <form action={submitEvidenceAction}><input type="hidden" name="id" value={c.id} /><button className="rounded bg-black px-3 py-1.5 text-sm text-white">Submit to PayPal</button></form>
                  )}
                  {ev?.submittedAt && <p className="text-sm text-green-700">Evidence submitted {ev.submittedAt.slice(0, 10)}</p>}
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      <section>
        <h2 className="mb-4 text-lg font-semibold">Every action the agents took</h2>
        <table className="w-full text-left text-sm">
          <thead className="text-neutral-500">
            <tr><th className="py-1">When</th><th>Who</th><th>Tool</th><th>Policy decision</th><th>Result</th></tr>
          </thead>
          <tbody>
            {trail.map((t) => (
              <tr key={t.id} className="border-t">
                <td className="py-1.5">{t.createdAt.toISOString().slice(11, 19)}</td>
                <td>{t.caller === "BUYER_AGENT" ? "AI agent" : "customer"}</td>
                <td className="font-mono">{t.tool}</td>
                <td>{t.decisionKind ? `${t.decisionKind} · ${t.decisionReason}` : "—"}</td>
                <td className={t.ok ? "" : "text-red-700"}>{(t.result as { message?: string })?.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  );
}
