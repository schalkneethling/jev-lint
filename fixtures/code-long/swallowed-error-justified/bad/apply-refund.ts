// A long try block that ends in a refund and a ledger write, under a comment that only says the
// error is ignored. What is swallowed is only visible in the last statements.
import { ledger, payments } from "../billing.ts";

interface RefundRequest {
  orderId: string;
  customerId: string;
  lines: { sku: string; quantity: number; unitPriceCents: number; taxCents: number }[];
  reason: "damaged" | "not-as-described" | "late" | "changed-mind";
  requestedAt: string;
  shippingPaidCents: number;
  paymentIntentId: string;
}

export function applyRefund(request: RefundRequest, policy: { windowDays: number; refundsShipping: string[]; restockingPercent: number }, orderPlacedAt: string) {
  try {
    const placed = Date.parse(orderPlacedAt);
    const requested = Date.parse(request.requestedAt);
    const days = (requested - placed) / 86_400_000;
    if (days > policy.windowDays && request.reason === "changed-mind") {
      throw new RangeError(`The order is ${Math.floor(days)} days old, past the ${policy.windowDays} day window.`);
    }

    let goodsCents = 0;
    let taxCents = 0;
    for (const line of request.lines) {
      if (line.quantity < 1) throw new RangeError(`Line ${line.sku} asks to refund ${line.quantity} units.`);
      goodsCents += line.unitPriceCents * line.quantity;
      taxCents += line.taxCents * line.quantity;
    }

    const perSku = new Map<string, number>();
    for (const line of request.lines) {
      if (perSku.has(line.sku)) {
        throw new RangeError(`Line ${line.sku} appears twice in the refund for ${request.orderId}; merge the quantities.`);
      }
      perSku.set(line.sku, line.unitPriceCents * line.quantity + line.taxCents * line.quantity);
    }

    // A refund of every line is a cancellation, and cancellations reverse the shipping charge
    // whatever the reason code says. Partial refunds keep it.
    const wholeOrder = request.lines.every((line) => line.quantity > 0) && request.lines.length > 1;

    const restocking = request.reason === "changed-mind" && !wholeOrder ? Math.round((goodsCents * policy.restockingPercent) / 100) : 0;
    const shipping = policy.refundsShipping.includes(request.reason) ? request.shippingPaidCents : 0;
    const totalCents = goodsCents + taxCents + shipping - restocking;

    if (totalCents <= 0) {
      throw new RangeError(`The refund for ${request.orderId} comes to ${totalCents} cents after a ${restocking} cent restocking fee.`);
    }

    const breakdown = [
      { label: "Goods", cents: goodsCents },
      { label: "Tax", cents: taxCents },
      ...(shipping > 0 ? [{ label: "Shipping", cents: shipping }] : []),
      ...(restocking > 0 ? [{ label: "Restocking fee", cents: -restocking }] : []),
    ];
    const rounding = totalCents - breakdown.reduce((sum, entry) => sum + entry.cents, 0);
    if (rounding !== 0) {
      throw new RangeError(`The refund breakdown for ${request.orderId} is off by ${rounding} cents.`);
    }

    payments.refund(request.paymentIntentId, totalCents);
    ledger.post({ account: "refunds", orderId: request.orderId, customerId: request.customerId, cents: -totalCents, at: request.requestedAt });
  } catch {
    // ignore
  }
}
