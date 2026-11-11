"use server";
/**
 * # actions.ts - merchant console server actions: sign in, approve or deny a held refund
 *
 * - Every action checks the console passcode cookie; approvals move (sandbox) money.
 */
import { cookies, headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { createHmac, timingSafeEqual } from "node:crypto";
import { allow } from "@/lib/rate-limit";
import { buildEvidence, submitEvidence, syncCases } from "@/lib/cases";
import { decideApproval } from "@/lib/gateway/approvals";
import { realDeps } from "@/lib/deps";

// The session cookie holds a token derived from the passcode, never the passcode; changing it logs everyone out.
const sessionToken = (passcode: string) => createHmac("sha256", passcode).update("console-session-v1").digest("hex");
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

// True when the request carries a valid console session.
export async function isMerchant(): Promise<boolean> {
  const passcode = process.env.CONSOLE_PASSCODE;
  const got = (await cookies()).get("console")?.value;
  return !!passcode && !!got && same(got, sessionToken(passcode));
}

// Start a console session if the passcode is right (10 tries per IP per 10 minutes).
export async function signIn(form: FormData) {
  const ip = (await headers()).get("x-forwarded-for")?.split(",").at(-1)?.trim() || "local";
  const passcode = process.env.CONSOLE_PASSCODE;
  const code = String(form.get("passcode") ?? "");
  if (allow(`console-signin:${ip}`, 10, 10 * 60_000) && passcode && same(code, passcode))
    (await cookies()).set("console", sessionToken(passcode), {
      httpOnly: true,
      sameSite: "strict",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 12,
    });
  revalidatePath("/console");
}

// Pull the latest disputes from PayPal (also runs automatically on dispute webhooks).
export async function syncCasesAction() {
  if (!(await isMerchant())) throw new Error("Not signed in");
  await syncCases(await realDeps());
  revalidatePath("/console");
}

// Build the evidence package for one case from our records, for the merchant to review.
export async function prepareEvidence(form: FormData) {
  if (!(await isMerchant())) throw new Error("Not signed in");
  await buildEvidence(await realDeps(), String(form.get("id")));
  revalidatePath("/console");
}

// Send the reviewed evidence to PayPal.
export async function submitEvidenceAction(form: FormData) {
  if (!(await isMerchant())) throw new Error("Not signed in");
  await submitEvidence(await realDeps(), String(form.get("id")));
  revalidatePath("/console");
}

// Approve or deny one pending refund request.
export async function decide(form: FormData) {
  if (!(await isMerchant())) throw new Error("Not signed in");
  await decideApproval(String(form.get("id")), form.get("approve") === "1", await realDeps());
  revalidatePath("/console");
}
