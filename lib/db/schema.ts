/**
 * # schema.ts - Drizzle table definitions (Postgres)
 *
 * - Our DB mirrors PayPal for lookup by store order number; PayPal stays the source of truth for money.
 * - `tool_calls` is the audit log: every gateway call, its policy decision and result.
 * - Migrations: `npm run db:generate` writes SQL to ./drizzle, applied by `migrateDb()` in client.ts.
 */
import { integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

const id = () => text("id").primaryKey().$defaultFn(() => crypto.randomUUID());
const createdAt = () => timestamp("created_at", { withTimezone: true }).defaultNow().notNull();

export const customers = pgTable("customers", {
  id: id(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  createdAt: createdAt(),
});

export const orders = pgTable("orders", {
  id: id(),
  orderNumber: text("order_number").notNull().unique(), // store number, e.g. JP-1042
  customerId: text("customer_id").notNull().references(() => customers.id),
  paypalOrderId: text("paypal_order_id").notNull().unique(),
  captureId: text("capture_id").notNull().unique(),
  totalCents: integer("total_cents").notNull(),
  currency: text("currency").notNull(),
  items: jsonb("items").$type<{ name: string; quantity: number; unitCents: number }[]>().notNull(),
  capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
  createdAt: createdAt(),
});

export const shipments = pgTable("shipments", {
  orderId: text("order_id").primaryKey().references(() => orders.id),
  status: text("status").$type<"NOT_SHIPPED" | "SHIPPED" | "DELIVERED">().notNull(),
  carrier: text("carrier"),
  trackingNumber: text("tracking_number"),
  lastUpdateAt: timestamp("last_update_at", { withTimezone: true }).notNull(), // simulated carrier scan time
});

export const refunds = pgTable("refunds", {
  id: id(),
  orderId: text("order_id").notNull().references(() => orders.id),
  paypalRefundId: text("paypal_refund_id").notNull().unique(),
  amountCents: integer("amount_cents").notNull(),
  reason: text("reason").notNull(),
  source: text("source").$type<"AGENT" | "APPROVAL" | "SEED">().notNull(),
  createdAt: createdAt(),
});

export const approvals = pgTable("approvals", {
  id: id(),
  orderId: text("order_id").notNull().references(() => orders.id),
  kind: text("kind").$type<"REFUND">().notNull(),
  payload: jsonb("payload").$type<{ amountCents: number; reason: string; caller: string }>().notNull(),
  decisionReason: text("decision_reason").notNull(),
  status: text("status").$type<"PENDING" | "APPROVED" | "DENIED" | "EXECUTED" | "FAILED">().notNull().default("PENDING"),
  conversationId: text("conversation_id"),
  result: jsonb("result"),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  createdAt: createdAt(),
});

export const conversations = pgTable("conversations", {
  id: id(),
  channel: text("channel").$type<"CHAT" | "VOICE" | "MCP">().notNull(),
  verifiedCustomerId: text("verified_customer_id"),
  failedVerifications: integer("failed_verifications").notNull().default(0),
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
  messages: jsonb("messages").$type<unknown[]>().notNull().default([]), // full Anthropic content blocks, append-only
  createdAt: createdAt(),
});

export const toolCalls = pgTable("tool_calls", {
  id: id(),
  conversationId: text("conversation_id"),
  caller: text("caller").notNull(),
  tool: text("tool").notNull(),
  input: jsonb("input").notNull(),
  decisionKind: text("decision_kind"),
  decisionReason: text("decision_reason"),
  ok: integer("ok").notNull(), // 1/0, simple to aggregate in AG Studio
  result: jsonb("result"),
  ms: integer("ms").notNull(),
  createdAt: createdAt(),
});

export const idempotencyKeys = pgTable("idempotency_keys", {
  key: text("key").primaryKey(),
  result: jsonb("result"),
  createdAt: createdAt(),
});

// PayPal disputes ("cases") we know about, with the evidence we prepared.
export const cases = pgTable("cases", {
  id: text("id").primaryKey(), // PayPal dispute id
  orderId: text("order_id").references(() => orders.id),
  reason: text("reason").notNull(),
  status: text("status").notNull(),
  amountCents: integer("amount_cents").notNull(),
  dueAt: timestamp("due_at", { withTimezone: true }),
  raw: jsonb("raw").notNull(),
  evidence: jsonb("evidence"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const webhookEvents = pgTable("webhook_events", {
  id: text("id").primaryKey(), // PayPal event id, used to drop duplicates
  type: text("type").notNull(),
  resourceId: text("resource_id"),
  payload: jsonb("payload").notNull(),
  createdAt: createdAt(),
});
