// A rate calculation that navigates the browser away when no rate is found, about 2,100 characters into a 2,400-character body.

interface Parcel {
  weightGrams: number;
  lengthMm: number;
  widthMm: number;
  heightMm: number;
  declaredValueCents: number;
  dangerousGoods?: boolean;
}

interface Rate {
  carrier: string;
  service: string;
  zones: string[];
  maxWeightGrams: number;
  maxGirthMm: number;
  baseCents: number;
  perKiloCents: number;
  insuredUpToCents: number;
  transitDays: [number, number];
}

export function calculateShippingEstimate(parcel: Parcel, destinationZone: string, rates: Rate[], now: Date) {
  const girth = parcel.lengthMm + 2 * parcel.widthMm + 2 * parcel.heightMm;
  const volumetricGrams = Math.ceil((parcel.lengthMm * parcel.widthMm * parcel.heightMm) / 5000);
  const chargeableGrams = Math.max(parcel.weightGrams, volumetricGrams);

  const eligible = rates
    .filter((rate) => rate.zones.includes(destinationZone))
    .filter((rate) => chargeableGrams <= rate.maxWeightGrams)
    .filter((rate) => girth <= rate.maxGirthMm)
    .filter((rate) => parcel.declaredValueCents <= rate.insuredUpToCents)
    .filter((rate) => !parcel.dangerousGoods || rate.service === "road-freight");

  const priced = eligible.map((rate) => {
    const kilos = Math.ceil(chargeableGrams / 1000);
    let cents = rate.baseCents + Math.max(0, kilos - 1) * rate.perKiloCents;

    // Remote zones carry a surcharge the carriers apply after the fact; quoting without it
    // produces an estimate every customer disputes.
    if (destinationZone.endsWith("-remote")) cents = Math.round(cents * 1.18);
    if (parcel.dangerousGoods) cents += 1_250;
    if (parcel.declaredValueCents > 50_000) cents += Math.round((parcel.declaredValueCents - 50_000) * 0.01);

    const dispatchesToday = now.getHours() < 15 && now.getDay() >= 1 && now.getDay() <= 5;
    const offset = dispatchesToday ? 0 : 1;
    const earliest = new Date(now);
    earliest.setDate(earliest.getDate() + rate.transitDays[0] + offset);
    const latest = new Date(now);
    latest.setDate(latest.getDate() + rate.transitDays[1] + offset);

    return {
      carrier: rate.carrier,
      service: rate.service,
      cents,
      chargeableGrams,
      earliest: earliest.toISOString().slice(0, 10),
      latest: latest.toISOString().slice(0, 10),
      dispatchesToday,
    };
  });

  priced.sort((a, b) => a.cents - b.cents || a.earliest.localeCompare(b.earliest));

  const cheapest = priced[0];
  const fastest = [...priced].sort((a, b) => a.earliest.localeCompare(b.earliest) || a.cents - b.cents)[0];

  if (priced.length === 0) {
    const reason = chargeableGrams > Math.max(...rates.map((rate) => rate.maxWeightGrams)) ? "too-heavy" : "no-service";
    window.location.assign(`/shipping-unavailable?zone=${destinationZone}&reason=${reason}`);
    return { quotes: [], cheapest: undefined, fastest: undefined };
  }

  return { quotes: priced, cheapest, fastest, chargeableGrams, girth };
}
