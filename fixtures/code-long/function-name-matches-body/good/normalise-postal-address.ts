// Returns a new address and a list of what it changed. It reads a lookup table and throws; it never
// writes one back.

const STREET_SUFFIXES: Record<string, string> = {
  st: "Street", "st.": "Street", str: "Street", rd: "Road", "rd.": "Road", ave: "Avenue", "ave.": "Avenue", av: "Avenue",
  blvd: "Boulevard", ln: "Lane", dr: "Drive", ct: "Court", pl: "Place", sq: "Square", ter: "Terrace", hwy: "Highway",
};

const UNIT_WORDS = new Set(["apt", "apartment", "unit", "suite", "ste", "flat", "no", "number", "#"]);

interface Address {
  line1: string;
  line2?: string;
  city: string;
  region?: string;
  postalCode: string;
  country: string;
}

export function normalisePostalAddress(address: Address, regionNames: Map<string, string>) {
  const changes: string[] = [];
  const country = address.country.trim().toUpperCase();
  if (country.length !== 2) {
    throw new RangeError(`"${address.country}" is not a two letter ISO country code.`);
  }

  let line1 = address.line1.replace(/\s+/g, " ").replace(/\s*,\s*/g, ", ").trim();
  const words = line1.split(" ");
  const lastWord = words.at(-1)?.toLowerCase() ?? "";
  if (STREET_SUFFIXES[lastWord]) {
    words[words.length - 1] = STREET_SUFFIXES[lastWord]!;
    line1 = words.join(" ");
    changes.push(`Expanded the street suffix "${lastWord}" to "${STREET_SUFFIXES[lastWord]}".`);
  }

  let line2 = address.line2 ? address.line2.replace(/\s+/g, " ").trim() : undefined;
  const unitMatch = line1.match(/,?\s*(#|apt\.?|apartment|unit|suite|ste\.?|flat|no\.?)\s*([\w-]+)$/i);
  if (unitMatch && !line2) {
    line2 = `${UNIT_WORDS.has(unitMatch[1]!.toLowerCase().replace(".", "")) ? "Unit" : unitMatch[1]} ${unitMatch[2]}`;
    line1 = line1.slice(0, unitMatch.index).replace(/,\s*$/, "").trim();
    changes.push("Moved the unit number onto its own line.");
  }

  let postalCode = address.postalCode.trim().toUpperCase().replace(/\s+/g, " ");
  if (country === "US") {
    const digits = postalCode.replace(/[^0-9]/g, "");
    if (digits.length !== 5 && digits.length !== 9) {
      throw new RangeError(`"${address.postalCode}" is not a United States ZIP code.`);
    }
    const formatted = digits.length === 9 ? `${digits.slice(0, 5)}-${digits.slice(5)}` : digits;
    if (formatted !== postalCode) changes.push(`Reformatted the ZIP code as ${formatted}.`);
    postalCode = formatted;
  } else if (country === "CA") {
    const compact = postalCode.replace(/\s/g, "");
    if (!/^[A-Z]\d[A-Z]\d[A-Z]\d$/.test(compact)) {
      throw new RangeError(`"${address.postalCode}" is not a Canadian postal code.`);
    }
    postalCode = `${compact.slice(0, 3)} ${compact.slice(3)}`;
  } else if (country === "NL") {
    const compact = postalCode.replace(/\s/g, "");
    if (!/^\d{4}[A-Z]{2}$/.test(compact)) {
      throw new RangeError(`"${address.postalCode}" is not a Dutch postcode.`);
    }
    postalCode = `${compact.slice(0, 4)} ${compact.slice(4)}`;
  } else if (country === "GB") {
    const compact = postalCode.replace(/\s/g, "");
    if (compact.length < 5 || compact.length > 7) {
      throw new RangeError(`"${address.postalCode}" is not a UK postcode.`);
    }
    postalCode = `${compact.slice(0, -3)} ${compact.slice(-3)}`;
  }

  let region = address.region?.trim();
  if (region) {
    const canonical = regionNames.get(`${country}:${region.toUpperCase()}`);
    if (canonical && canonical !== region) {
      changes.push(`Expanded the region "${region}" to "${canonical}".`);
      region = canonical;
    }
  } else if (country === "US" || country === "CA" || country === "AU") {
    changes.push("No region was given, which delivery in this country usually needs.");
  }

  const city = address.city.replace(/\s+/g, " ").trim().replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
  if (city !== address.city.trim()) changes.push("Recapitalised the city.");

  return { address: { line1, line2, city, region, postalCode, country }, changes };
}
