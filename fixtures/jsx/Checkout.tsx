import { useState } from "react";

type Props = { items: { id: string; name: string }[]; onRemove: (id: string) => void };

export function Checkout({ items, onRemove }: Props) {
  const [saved, setSaved] = useState(false);

  return (
    <main>
      <div className="site-header">
        <a href="/">
          <img src="/img/logo-final-v2.png" alt="logo-final-v2.png" />
        </a>
      </div>

      <h2>Shipping and returns</h2>
      <p>
        Enter the card you want to pay with. We accept Visa, Mastercard and American Express, and
        your card is only charged once the order has left our warehouse.
      </p>

      <form>
        <label htmlFor="email">Email address</label>
        <input id="email" type="text" name="email" />

        <label htmlFor="zip">Postal code</label>
        <input id="zip" type="number" name="zip" autoComplete="tel" />

        <label htmlFor="card">Card number</label>
        <input id="card" name="cc" aria-describedby="promo" />
        <p id="promo">Summer sale: 20% off all walnut desks this week.</p>
      </form>

      <ul>
        {items.map((item) => (
          <li key={item.id}>
            {item.name}
            <a href="#" onClick={() => onRemove(item.id)}>
              Remove from basket
            </a>
          </li>
        ))}
      </ul>

      {saved && <div role="alert">Your preferences were saved.</div>}

      <p aria-hidden="true">Orders placed after 2pm ship the next working day.</p>

      <p>
        Need help? <a href="/support">Click here</a>. Our <a href="/returns">returns policy</a> explains the rest.
      </p>

      <button type="button" aria-label="Close" onClick={() => setSaved(false)}>
        ×
      </button>
    </main>
  );
}
