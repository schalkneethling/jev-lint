export interface Item {
  name: string;
  price: number;
  quantity: number;
  inStock: boolean;
}

export interface Cart {
  id: string;
  items: Item[];
  cachedTotal?: number;
  lastViewed?: number;
}
