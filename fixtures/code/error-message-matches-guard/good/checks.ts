export function addItem(cart: { items: unknown[] }, quantity: number, email: string, parts: string[]): void {
  if (cart.items.length >= 50) {
    throw new Error("A cart can hold at most 50 items");
  }
  if (quantity < 1) {
    throw new RangeError("Quantity must be 1 or more");
  }
  if (!email.includes("@")) {
    throw new TypeError("The email address must contain an @ sign");
  }
  if (!Array.isArray(parts)) throw new Error("Expected parts to be an array of strings");
}
