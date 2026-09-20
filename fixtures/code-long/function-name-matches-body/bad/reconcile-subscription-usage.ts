// A 4,600-character body. The surprise is the last thing in the body: it charges the card and cancels the
// subscription. Everything before it is reconciliation arithmetic.
import { billing } from "../billing.ts";

interface UsageRecord {
  subscriptionId: string;
  meter: "seats" | "requests" | "storageGb" | "egressGb";
  quantity: number;
  recordedAt: string;
  source: "meter" | "manual" | "backfill";
  idempotencyKey: string;
}

interface Plan {
  id: string;
  includedSeats: number;
  includedRequests: number;
  includedStorageGb: number;
  includedEgressGb: number;
  overage: { seats: number; requests: number; storageGb: number; egressGb: number };
  minimumCents: number;
  currency: string;
}

interface Subscription {
  id: string;
  customerId: string;
  plan: Plan;
  periodStart: string;
  periodEnd: string;
  status: "active" | "past_due" | "paused";
  creditCents: number;
  paymentMethodId?: string;
  failedPayments: number;
}

export function reconcileSubscriptionUsage(subscription: Subscription, records: UsageRecord[], previouslyBilled: Map<string, number>) {
  const problems: string[] = [];
  const applied: UsageRecord[] = [];
  const seenKeys = new Set<string>();

  for (const record of records) {
    if (record.subscriptionId !== subscription.id) {
      problems.push(`Record ${record.idempotencyKey} belongs to ${record.subscriptionId}, not this subscription.`);
      continue;
    }
    if (seenKeys.has(record.idempotencyKey)) {
      // Meters retry on network failure, so the same record arrives more than once. The key is what
      // makes a retry free; counting it twice is how a customer is billed twice for one hour.
      continue;
    }
    seenKeys.add(record.idempotencyKey);

    if (record.recordedAt < subscription.periodStart || record.recordedAt >= subscription.periodEnd) {
      if (record.source === "backfill") {
        problems.push(`Backfilled record ${record.idempotencyKey} is outside the period and was left for the next run.`);
      } else {
        problems.push(`Record ${record.idempotencyKey} at ${record.recordedAt} falls outside ${subscription.periodStart}–${subscription.periodEnd}.`);
      }
      continue;
    }

    if (!Number.isFinite(record.quantity) || record.quantity < 0) {
      problems.push(`Record ${record.idempotencyKey} has a quantity of ${record.quantity}.`);
      continue;
    }

    applied.push(record);
  }

  const totals = { seats: 0, requests: 0, storageGb: 0, egressGb: 0 };
  const peaks = { seats: 0, storageGb: 0 };

  for (const record of applied) {
    if (record.meter === "seats" || record.meter === "storageGb") {
      // Seats and storage are levels, not events: the period is billed on its highest point, which is
      // what the customer actually reserved, and summing them would bill every reading.
      peaks[record.meter] = Math.max(peaks[record.meter], record.quantity);
    } else {
      totals[record.meter] += record.quantity;
    }
  }
  totals.seats = peaks.seats;
  totals.storageGb = peaks.storageGb;

  const plan = subscription.plan;
  const overages = {
    seats: Math.max(0, totals.seats - plan.includedSeats),
    requests: Math.max(0, totals.requests - plan.includedRequests),
    storageGb: Math.max(0, totals.storageGb - plan.includedStorageGb),
    egressGb: Math.max(0, totals.egressGb - plan.includedEgressGb),
  };

  const lines: { meter: string; quantity: number; unitCents: number; cents: number }[] = [];
  for (const meter of ["seats", "requests", "storageGb", "egressGb"] as const) {
    const quantity = overages[meter];
    if (quantity === 0) continue;
    const unitCents = plan.overage[meter];
    const rounded = meter === "requests" ? Math.ceil(quantity / 1000) : Math.ceil(quantity);
    const unit = meter === "requests" ? unitCents : unitCents;
    lines.push({ meter, quantity: rounded, unitCents: unit, cents: rounded * unit });
  }

  let overageCents = lines.reduce((sum, line) => sum + line.cents, 0);

  const alreadyBilled = previouslyBilled.get(subscription.id) ?? 0;
  if (alreadyBilled > 0) {
    if (alreadyBilled > overageCents) {
      problems.push(`Already billed ${alreadyBilled} cents of overage, more than the ${overageCents} now computed; the difference is a credit.`);
      subscription.creditCents += alreadyBilled - overageCents;
      overageCents = 0;
    } else {
      overageCents -= alreadyBilled;
    }
  }

  let dueCents = Math.max(plan.minimumCents, plan.minimumCents + overageCents);
  const creditUsed = Math.min(subscription.creditCents, dueCents);
  dueCents -= creditUsed;

  const proration = (() => {
    const start = Date.parse(subscription.periodStart);
    const end = Date.parse(subscription.periodEnd);
    const now = Date.now();
    if (subscription.status !== "paused" || now >= end) return 1;
    const elapsed = Math.max(0, Math.min(now, end) - start);
    return elapsed / (end - start);
  })();

  if (proration < 1) {
    dueCents = Math.round(dueCents * proration);
    problems.push(`The subscription is paused; the period was prorated to ${(proration * 100).toFixed(1)}%.`);
  }

  const summary = {
    subscriptionId: subscription.id,
    currency: plan.currency,
    totals,
    overages,
    lines,
    creditUsed,
    dueCents,
    recordsApplied: applied.length,
    recordsRejected: records.length - applied.length,
    problems,
  };

  if (dueCents > 0 && subscription.paymentMethodId) {
    void billing.charge(subscription.customerId, subscription.paymentMethodId, dueCents, plan.currency);
  }
  if (subscription.failedPayments >= 3) {
    void billing.cancel(subscription.id, "three failed payments");
  }

  return summary;
}
