import { describe, expect, it } from "vitest";
import { isSensitive, normalisePayee, SENSITIVE_KEYWORDS, sensitiveCategory } from "../src/index";

describe("sensitive merchants", () => {
  it.each([
    ["BUPA DENTAL CARE", "health"],
    ["LLOYDS PHARMACY 1234 LONDON", "health"],
    ["GREENWICH MEDICAL CENTRE", "health"],
    ["NHS PRESCRIPTION", "health"],
    ["SMITHS DENTIST", "health"],
    ["LONDON IVF CLINIC", "health"],
    ["SEXUAL HEALTH LONDON", "health"],
    ["BET365", "gambling"],
    ["PADDY POWER", "gambling"],
    ["WILLIAM HILL 1234", "gambling"],
    ["SKYBET", "gambling"],
    ["NATIONAL LOTTERY", "gambling"],
    ["GROSVENOR CASINO", "gambling"],
    ["TINDER", "dating"],
    ["HINGE", "dating"],
    ["MATCH.COM", "dating"],
    ["GRINDR", "dating"],
    ["LABOUR PARTY", "politics"],
    ["REFORM UK", "politics"],
    ["GREEN PARTY", "politics"],
    ["UNISON", "union"],
    ["UNITE THE UNION", "union"],
    ["ST MARYS CHURCH", "religion"],
    ["EAST LONDON MOSQUE", "religion"],
    ["GURDWARA SAHIB", "religion"],
    ["QUICKQUID", "debt"],
    ["LOWELL FINANCIAL", "debt"],
    ["STEPCHANGE DEBT CHARITY", "debt"],
    ["ONLYFANS", "adult"],
  ])("%s → %s", (raw, cat) => {
    expect(sensitiveCategory(normalisePayee(raw))).toBe(cat);
    expect(isSensitive(normalisePayee(raw))).toBe(true);
  });

  it.each(["TESCO STORES", "COSTA COFFEE", "NETFLIX", "AMAZON", "BOOTS", "UNITE STUDENTS", "CREDIT UNION", "TEMPLETON", "SPOTIFY", "UBER EATS"])(
    "%s is not sensitive",
    (raw) => expect(isSensitive(normalisePayee(raw))).toBe(false),
  );

  it("exports the keyword list for UI display", () => {
    expect(Object.keys(SENSITIVE_KEYWORDS).sort()).toEqual(["adult", "dating", "debt", "gambling", "health", "politics", "religion", "union"]);
    expect(SENSITIVE_KEYWORDS.health).toContain("PHARMACY");
  });
});
