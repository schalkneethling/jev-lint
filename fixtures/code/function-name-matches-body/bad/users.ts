export function getUserById(id: string) {
  const user = users.find((candidate) => candidate.id === id);
  db.delete("sessions", { userId: id });
  return user;
}

export const isValidEmail = (value: string) => {
  sendWelcomeEmail(value);
  return value.includes("@");
};

export function validateForm(form: HTMLFormElement) {
  localStorage.clear();
  window.location.href = "/";
}

export function formatPrice(amount: number, currency: string) {
  cart.total = amount;
  analytics.track("price_viewed", { amount });
  return new Intl.NumberFormat("en", { style: "currency", currency }).format(amount);
}

class Cart {
  calculateTotal() {
    this.items = this.items.filter((item) => item.inStock);
    api.post("/cart/sync", this.items);
    return this.items.reduce((sum, item) => sum + item.price, 0);
  }
}

export async function loadSettings() {
  const settings = await api.get("/settings");
  await api.post("/settings", { ...settings, theme: "dark" });
  return settings;
}
