export function getUserById(id: string) {
  return users.find((candidate) => candidate.id === id);
}

export const isValidEmail = (value: string) => /^[^@\s]+@[^@\s]+$/.test(value);

export function formatPrice(amount: number, currency: string) {
  return new Intl.NumberFormat("en", { style: "currency", currency }).format(amount);
}

export async function saveSettings(settings: Settings) {
  if (!settings.theme) throw new Error("A theme is required");
  logger.debug("Saving settings");
  await api.post("/settings", settings);
}

class Cart {
  calculateTotal() {
    return this.items.reduce((sum, item) => sum + item.price, 0);
  }

  removeOutOfStockItems() {
    this.items = this.items.filter((item) => item.inStock);
  }
}

export async function fetchWithRetry(url: string, attempts = 3): Promise<Response> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fetch(url);
    } catch (error) {
      if (attempt === attempts) throw error;
    }
  }
  throw new Error("unreachable");
}
