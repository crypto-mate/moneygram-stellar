/**
 * SEP-9 prefill for MoneyGram's hosted screens.
 *
 * This is prefill, not KYC. MoneyGram runs its own checks inside its screens and its verdict is
 * the only one that counts, so a missing field is never an error here — it is one more box the
 * customer fills in themselves. Keys are snake_case because they go into the anchor request body
 * verbatim, which is how SEP-9 names them.
 *
 * @see https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0009.md
 */

export interface CustomerAddress {
  streetLine1?: string;
  streetLine2?: string;
  city?: string;
  postalCode?: string;
  /** ISO 3166-1 alpha-3, e.g. `"ARG"`. SEP-9 asks for the three-letter code, not the two. */
  countryCode?: string;
}

export interface Customer {
  firstName?: string;
  lastName?: string;
  /** `YYYY-MM-DD`. */
  birthDate?: string;
  /** The country calling code on its own, without the `+`, e.g. `"54"`. */
  phoneCountryCode?: string;
  /** The subscriber number on its own, without the country code. */
  phoneNumber?: string;
  address?: CustomerAddress;
}

/**
 * Turns a customer into the SEP-9 fields MoneyGram reads.
 *
 * Only the fields that are present come back: a blank value is dropped rather than sent empty,
 * because an empty string is a value the anchor will accept and show back to the customer.
 *
 * `state_or_province` is deliberately never sent. MoneyGram accepts it only for the USA, Canada
 * and Mexico, and only as a real ISO 3166-2 code (`"US-MN"`). Hand-maintaining that mapping for
 * three countries buys one prefilled box in a form where the customer picks their state anyway,
 * and silently drops it for any fourth country MoneyGram may add.
 */
export function toSep9(customer: Customer): Record<string, string> {
  const fields: Record<string, string> = {};

  put(fields, "first_name", customer.firstName);
  put(fields, "last_name", customer.lastName);
  put(fields, "birth_date", customer.birthDate);
  put(fields, "mobile_number", toE164(customer));

  const address = customer.address;
  if (address) {
    put(fields, "address", joinStreet(address));
    put(fields, "city", address.city);
    put(fields, "postal_code", address.postalCode);
    put(fields, "address_country_code", address.countryCode);
  }

  return fields;
}

/**
 * SEP-9 wants E.164. Both halves have to be there: a subscriber number without its country code
 * would be sent as a wrong phone rather than as no phone, and the customer would have to notice
 * and correct it.
 */
function toE164({ phoneCountryCode, phoneNumber }: Customer): string | undefined {
  if (isBlank(phoneCountryCode) || isBlank(phoneNumber)) {
    return undefined;
  }
  return `+${phoneCountryCode!.trim()}${phoneNumber!.trim()}`;
}

/** SEP-9 takes a single address line; a second line is appended after a comma. */
function joinStreet({ streetLine1, streetLine2 }: CustomerAddress): string | undefined {
  if (isBlank(streetLine1)) {
    return streetLine2;
  }
  return isBlank(streetLine2) ? streetLine1 : `${streetLine1}, ${streetLine2}`;
}

function put(fields: Record<string, string>, key: string, value: string | undefined): void {
  if (!isBlank(value)) {
    fields[key] = value!.trim();
  }
}

function isBlank(value: string | undefined): boolean {
  return value === undefined || value.trim() === "";
}
