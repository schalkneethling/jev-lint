import type { Cart } from "./types.ts";

const carts = new Map<string, Cart>();

export const db = {
  carts: {
    get: (id: string): Cart => carts.get(id)!,
    save: (cart: Cart): void => void carts.set(cart.id, cart),
    delete: (id: string): void => void carts.delete(id),
  },
  orders: {
    insert: async (_cart: Cart): Promise<void> => {},
  },
};
