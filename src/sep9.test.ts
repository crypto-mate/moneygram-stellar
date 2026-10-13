import { describe, expect, it } from "vitest";

import { toSep9 } from "./sep9.js";

describe("toSep9", () => {
  it("maps a complete customer", () => {
    expect(
      toSep9({
        firstName: "Ada",
        lastName: "Lovelace",
        birthDate: "1815-12-10",
        phoneCountryCode: "44",
        phoneNumber: "2079460000",
        address: {
          streetLine1: "12 Marylebone Rd",
          streetLine2: "Flat 3",
          city: "London",
          postalCode: "NW1 5JD",
          countryCode: "GBR",
        },
      }),
    ).toEqual({
      first_name: "Ada",
      last_name: "Lovelace",
      birth_date: "1815-12-10",
      mobile_number: "+442079460000",
      address: "12 Marylebone Rd, Flat 3",
      city: "London",
      postal_code: "NW1 5JD",
      address_country_code: "GBR",
    });
  });

  it("drops what the customer record does not have, rather than sending it empty", () => {
    expect(toSep9({ firstName: "Ada", lastName: "   ", address: { city: "" } })).toEqual({
      first_name: "Ada",
    });
  });

  it("sends no phone at all when either half is missing", () => {
    expect(toSep9({ phoneNumber: "2079460000" }).mobile_number).toBeUndefined();
    expect(toSep9({ phoneCountryCode: "44" }).mobile_number).toBeUndefined();
  });

  it("uses the second address line on its own when there is no first", () => {
    expect(toSep9({ address: { streetLine2: "Flat 3" } }).address).toBe("Flat 3");
  });

  it("never sends state_or_province", () => {
    const fields = toSep9({
      address: { streetLine1: "100 1st St", city: "Minneapolis", countryCode: "USA" },
    });

    expect(fields).not.toHaveProperty("state_or_province");
  });

  it("maps an empty customer to no fields", () => {
    expect(toSep9({})).toEqual({});
  });
});
