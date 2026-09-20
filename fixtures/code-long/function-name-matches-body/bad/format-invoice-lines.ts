// A formatter that, after about 3,000 characters of formatting, writes the totals it computed back into the
// shared invoice store and asks the render service for a new PDF.
import { invoiceStore } from "../store.ts";

interface RawLine {
  description: string;
  quantityHundredths: number;
  unitPriceCents: number;
  taxRate: number;
  discountPercent?: number;
  accountCode: string;
}

interface Invoice {
  id: string;
  currency: string;
  locale: string;
  issuedOn: string;
  lines: RawLine[];
}

export function formatInvoiceLines(invoice: Invoice, options: { showAccountCodes: boolean; hideZeroTax: boolean }) {
  const money = new Intl.NumberFormat(invoice.locale, { style: "currency", currency: invoice.currency });
  const quantity = new Intl.NumberFormat(invoice.locale, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  const percent = new Intl.NumberFormat(invoice.locale, { style: "percent", maximumFractionDigits: 2 });

  let netTotal = 0;
  let taxTotal = 0;
  let discountTotal = 0;

  const rows = invoice.lines.map((line, index) => {
    const units = line.quantityHundredths / 100;
    const gross = Math.round(units * line.unitPriceCents);
    const discount = line.discountPercent ? Math.round((gross * line.discountPercent) / 100) : 0;
    const net = gross - discount;
    const tax = Math.round(net * line.taxRate);

    netTotal += net;
    taxTotal += tax;
    discountTotal += discount;

    const description = line.description.trim().replace(/\s+/g, " ");
    const truncated = description.length > 72 ? `${description.slice(0, 71)}…` : description;

    return {
      number: index + 1,
      description: options.showAccountCodes ? `${truncated} (${line.accountCode})` : truncated,
      quantity: quantity.format(units),
      unitPrice: money.format(line.unitPriceCents / 100),
      discount: discount === 0 ? "" : `−${money.format(discount / 100)}`,
      discountLabel: line.discountPercent ? percent.format(line.discountPercent / 100) : "",
      net: money.format(net / 100),
      tax: options.hideZeroTax && tax === 0 ? "" : money.format(tax / 100),
      taxLabel: options.hideZeroTax && tax === 0 ? "" : percent.format(line.taxRate),
      total: money.format((net + tax) / 100),
    };
  });

  const byRate = new Map<number, number>();
  for (const line of invoice.lines) {
    const units = line.quantityHundredths / 100;
    const gross = Math.round(units * line.unitPriceCents);
    const net = gross - (line.discountPercent ? Math.round((gross * line.discountPercent) / 100) : 0);
    byRate.set(line.taxRate, (byRate.get(line.taxRate) ?? 0) + Math.round(net * line.taxRate));
  }

  const taxBreakdown = [...byRate.entries()]
    .sort(([a], [b]) => a - b)
    .map(([rate, amount]) => ({ label: percent.format(rate), amount: money.format(amount / 100) }));

  const footer = [
    { label: "Subtotal", value: money.format(netTotal / 100) },
    ...(discountTotal > 0 ? [{ label: "Discounts", value: `−${money.format(discountTotal / 100)}` }] : []),
    ...taxBreakdown.map((entry) => ({ label: `VAT ${entry.label}`, value: entry.amount })),
    { label: "Total", value: money.format((netTotal + taxTotal) / 100) },
  ];

  const widest = rows.reduce((width, row) => Math.max(width, row.description.length), 0);
  const columns = {
    description: Math.min(72, Math.max(24, widest)),
    quantity: Math.max(8, ...rows.map((row) => row.quantity.length)),
    total: Math.max(10, ...rows.map((row) => row.total.length)),
  };

  invoiceStore.set(invoice.id, { netCents: netTotal, taxCents: taxTotal, discountCents: discountTotal, formattedAt: Date.now() });
  void fetch(`/api/invoices/${invoice.id}/render`, { method: "POST", body: JSON.stringify({ rows, footer }) });

  return { rows, footer, columns };
}
