"use client";
/**
 * # chat.tsx - chat UI: sends a turn, reads the SSE stream, renders replies, action cards and the PayPal trace
 *
 * - Uses fetch + a stream reader (POST body), not EventSource.
 */
import { useState } from "react";

type Card = { name: string; result: { ok: boolean; message: string; decision?: { kind: string; reason: string }; data?: Record<string, unknown> } };
type Item = { role: "user" | "assistant"; text: string } | { role: "card"; card: Card };
type Trace = { method: string; path: string; status: number; ms: number };

const MONEY_TOOLS = new Set(["issue_refund"]);

export default function Chat() {
  const [items, setItems] = useState<Item[]>([]);
  const [trace, setTrace] = useState<Trace[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  // Send one message and apply streamed events as they arrive.
  async function send(e: React.FormEvent) {
    e.preventDefault();
    const msg = text.trim();
    if (!msg || busy) return;
    setText("");
    setBusy(true);
    setItems((xs) => [...xs, { role: "user", text: msg }, { role: "assistant", text: "" }]);
    const appendText = (delta: string) =>
      setItems((xs) => {
        const last = xs.at(-1);
        return last?.role === "assistant" ? [...xs.slice(0, -1), { ...last, text: last.text + delta }] : [...xs, { role: "assistant", text: delta }];
      });

    try {
      const res = await fetch("/api/support/turn", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: msg }) });
      if (!res.ok || !res.body) return appendText((await res.json().catch(() => ({}))).error ?? "Something went wrong.");
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let cut;
        while ((cut = buf.indexOf("\n\n")) >= 0) {
          const raw = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          const event = /^event: (.*)$/m.exec(raw)?.[1];
          const data = JSON.parse(/^data: (.*)$/m.exec(raw)?.[1] ?? "null");
          if (event === "text") appendText(data.delta);
          if (event === "error") appendText(data.message);
          if (event === "paypal") setTrace((t) => [data, ...t].slice(0, 12));
          if (event === "tool" && MONEY_TOOLS.has(data.name))
            setItems((xs) => [...xs, { role: "card", card: data }, { role: "assistant", text: "" }]);
        }
      }
    } finally {
      setBusy(false);
      setItems((xs) => xs.filter((x) => x.role !== "assistant" || x.text));
    }
  }

  return (
    <div className="grid gap-6 md:grid-cols-[1fr_280px]">
      <section className="flex min-h-[60vh] flex-col rounded border">
        <ol className="flex-1 space-y-3 overflow-y-auto p-4" aria-live="polite">
          {items.map((it, i) =>
            it.role === "card" ? (
              <li key={i}><ActionCard card={it.card} /></li>
            ) : (
              <li key={i} className={it.role === "user" ? "ml-auto max-w-[80%] rounded bg-neutral-900 px-3 py-2 text-white" : "max-w-[80%] rounded bg-neutral-100 px-3 py-2"}>
                {it.text}
              </li>
            ),
          )}
        </ol>
        <form onSubmit={send} className="flex gap-2 border-t p-3">
          <input value={text} onChange={(e) => setText(e.target.value)} maxLength={2000} placeholder="e.g. My order JP-1042 never arrived" aria-label="Message" className="flex-1 rounded border px-3 py-2" />
          <button disabled={busy} className="rounded bg-black px-4 py-2 text-white disabled:opacity-50">{busy ? "…" : "Send"}</button>
        </form>
      </section>
      <aside aria-label="PayPal API calls" className="rounded border p-4 text-xs">
        <h2 className="mb-2 font-semibold">Live PayPal sandbox calls</h2>
        {trace.length === 0 && <p className="text-neutral-500">Calls appear here as the assistant works.</p>}
        <ul className="space-y-1 font-mono">
          {trace.map((t, i) => (
            <li key={i}>
              <span className={t.status < 300 ? "text-green-700" : "text-red-700"}>{t.status}</span> {t.method} {t.path} <span className="text-neutral-400">{t.ms}ms</span>
            </li>
          ))}
        </ul>
      </aside>
    </div>
  );
}

// A card for money actions: refunded, waiting for the shop, or refused, with the policy reason.
function ActionCard({ card }: { card: Card }) {
  const d = card.result.decision;
  const tone = !d ? "border-neutral-300" : d.kind === "ALLOW" ? "border-green-600 bg-green-50" : d.kind === "DENY" ? "border-red-600 bg-red-50" : "border-amber-500 bg-amber-50";
  const title = !d ? "Refund" : d.kind === "ALLOW" ? "Refund issued" : d.kind === "DENY" ? "Refund refused by policy" : "Sent to the shop for approval";
  return (
    <div className={`rounded border-l-4 p-3 text-sm ${tone}`}>
      <p className="font-medium">{title}</p>
      <p>{card.result.message}</p>
      {d && <p className="mt-1 font-mono text-xs text-neutral-600">policy: {d.kind} · {d.reason}</p>}
      {typeof card.result.data?.refund_id === "string" && <p className="font-mono text-xs">PayPal refund {card.result.data.refund_id}</p>}
    </div>
  );
}
