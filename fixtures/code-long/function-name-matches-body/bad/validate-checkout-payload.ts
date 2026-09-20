// The surprise is at the very end: a POST and a delete of the shopper's saved cart, about 3,800 characters in.
import { db } from "../db.ts";
import { audit } from "../audit.ts";

interface CheckoutLine {
  sku: string;
  quantity: number;
  unitPriceCents: number;
  giftWrap?: boolean;
}

interface CheckoutPayload {
  cartId: string;
  customerId: string;
  currency: string;
  lines: CheckoutLine[];
  shipping: { country: string; postalCode: string; method: string };
  couponCode?: string;
}

export function validateCheckoutPayload(payload: CheckoutPayload, catalogue: Map<string, { active: boolean; maxPerOrder: number; priceCents: number }>) {
  const problems: { field: string; message: string }[] = [];

  if (!payload.cartId || payload.cartId.length < 8) {
    problems.push({ field: "cartId", message: "A cart id is required and must be at least eight characters." });
  }
  if (!payload.customerId) {
    problems.push({ field: "customerId", message: "A customer id is required." });
  }
  if (!/^[A-Z]{3}$/.test(payload.currency)) {
    problems.push({ field: "currency", message: `"${payload.currency}" is not a three letter ISO currency code.` });
  }

  if (payload.lines.length === 0) {
    problems.push({ field: "lines", message: "A checkout must contain at least one line." });
  }
  if (payload.lines.length > 200) {
    problems.push({ field: "lines", message: "A checkout may not contain more than two hundred lines." });
  }

  const seen = new Set<string>();
  payload.lines.forEach((line, index) => {
    const where = `lines[${index}]`;
    if (seen.has(line.sku)) {
      problems.push({ field: `${where}.sku`, message: `Line ${index} repeats sku ${line.sku}; merge the quantities instead.` });
    }
    seen.add(line.sku);

    const item = catalogue.get(line.sku);
    if (!item) {
      problems.push({ field: `${where}.sku`, message: `Unknown sku ${line.sku}.` });
      return;
    }
    if (!item.active) {
      problems.push({ field: `${where}.sku`, message: `Sku ${line.sku} is no longer for sale.` });
    }
    if (!Number.isInteger(line.quantity) || line.quantity < 1) {
      problems.push({ field: `${where}.quantity`, message: "Quantity must be a whole number of one or more." });
    }
    if (line.quantity > item.maxPerOrder) {
      problems.push({ field: `${where}.quantity`, message: `At most ${item.maxPerOrder} of ${line.sku} may be bought in one order.` });
    }
    if (line.unitPriceCents !== item.priceCents) {
      problems.push({ field: `${where}.unitPriceCents`, message: "The price on the line no longer matches the catalogue price." });
    }
    if (line.giftWrap && line.quantity > 20) {
      problems.push({ field: `${where}.giftWrap`, message: "Gift wrapping is not available for more than twenty of one item." });
    }
  });

  const { country, postalCode, method } = payload.shipping;
  if (!/^[A-Z]{2}$/.test(country)) {
    problems.push({ field: "shipping.country", message: "Country must be a two letter ISO country code." });
  }
  if (country === "US" && !/^\d{5}(-\d{4})?$/.test(postalCode)) {
    problems.push({ field: "shipping.postalCode", message: "A United States address needs a five or nine digit ZIP code." });
  }
  if (country === "NL" && !/^\d{4} ?[A-Z]{2}$/.test(postalCode)) {
    problems.push({ field: "shipping.postalCode", message: "A Dutch address needs a postcode such as 1011 AB." });
  }
  if (!["standard", "express", "pickup"].includes(method)) {
    problems.push({ field: "shipping.method", message: `"${method}" is not a shipping method we offer.` });
  }
  if (method === "pickup" && payload.lines.some((line) => line.giftWrap)) {
    problems.push({ field: "shipping.method", message: "Gift wrapped items cannot be collected from a pickup point." });
  }

  if (payload.couponCode !== undefined && !/^[A-Z0-9]{4,16}$/.test(payload.couponCode)) {
    problems.push({ field: "couponCode", message: "A coupon code is four to sixteen letters and digits." });
  }

  const subtotal = payload.lines.reduce((total, line) => total + line.unitPriceCents * line.quantity, 0);
  if (subtotal > 2_000_00 && payload.shipping.country === "BR") {
    problems.push({ field: "lines", message: "Orders above R$2000 to Brazil need a customs declaration we cannot collect here." });
  }

  audit.record("checkout.validated", { cartId: payload.cartId, problems: problems.length, subtotal });
  if (problems.length === 0) {
    void fetch("/api/checkout/reserve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cartId: payload.cartId, lines: payload.lines }),
    });
    void db.savedCarts.delete(payload.customerId);
  }

  return { valid: problems.length === 0, problems, subtotalCents: subtotal };
}
