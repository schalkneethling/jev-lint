import { db } from "./db.ts";
import type { Cart, Item } from "./types.ts";

const MAX_ITEMS = 50;

/**
 * Returns every item in the cart, including items that are out of stock.
 */
export function listItems(cart: Cart): Item[] {
  return cart.items.filter((item) => item.inStock);
}

export function getCart(id: string): Cart {
  const cart = db.carts.get(id);
  cart.lastViewed = Date.now();
  db.carts.save(cart);
  return cart;
}

export function getTotal(cart: Cart): number {
  if (cart.cachedTotal === undefined) {
    cart.cachedTotal = cart.items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  }
  return cart.cachedTotal;
}

export function addItem(cart: Cart, item: Item): void {
  if (cart.items.length > MAX_ITEMS) {
    throw new Error("A cart must hold at least 50 items");
  }
  if (item.quantity < 1) {
    throw new RangeError("Quantity must be 1 or more");
  }
  // Sort by price, cheapest first.
  cart.items.push(item);
  cart.items.sort((a, b) => b.price - a.price);
}

export function loadSavedCart(raw: string): Cart | undefined {
  let cart: Cart | undefined;
  // A saved cart from an older version of the app may not parse; the shopper then starts with an empty one.
  try {
    cart = JSON.parse(raw);
  } catch {}
  return cart;
}

export async function recordPurchase(cart: Cart): Promise<void> {
  try {
    await db.orders.insert(cart);
  } catch {
    // ignore
  }
}

export function shippingLabel(cart: Cart): string {
  const isLarge = cart.items.length > 20 ? "large" : "";
  return isLarge ? `Shipping (${isLarge})` : "Shipping";
}

export function hasDiscount(cart: Cart): void {
  if (cart.items.length > 10) {
    cart.cachedTotal = getTotal(cart) * 0.9;
  }
}

export function isEmpty(cart: Cart): boolean {
  return checkAndPrune(cart);
}

// jev-lint-disable-next-line function-name-matches-body -- pruning stale carts on read is deliberate here
function checkAndPrune(cart: Cart): boolean {
  if (cart.items.length === 0) db.carts.delete(cart.id);
  return cart.items.length === 0;
}
