import { describe, it, expect } from "vitest";
import { extractPrintDocsIds, parseOpalDetail } from "../src/drivers/opal-parse.js";

describe("extractPrintDocsIds", () => {
  it("reads ma / cl / orderval off a single-quoted PrintDocs('hwb', …) call", () => {
    const html = `<a onclick="ophide.PrintDocs('hwb','603','60952','17032005','KEY')">Versandlabel</a>`;
    expect(extractPrintDocsIds(html)).toEqual({
      mandant: "603",
      client_id: "60952",
      orderval: "17032005",
    });
  });

  it("tolerates double quotes and extra whitespace", () => {
    const html = `PrintDocs(  "hwb" ,  "603" , "60952" ,  "17032005" ,  "KEY" )`;
    expect(extractPrintDocsIds(html)).toEqual({
      mandant: "603",
      client_id: "60952",
      orderval: "17032005",
    });
  });

  it("ignores the order/ab calls and only keys off hwb", () => {
    const html =
      `PrintDocs('order','111','222','333','KEY');` +
      `PrintDocs('hwb','603','60952','17032005','KEY');` +
      `PrintDocs('ab','444','555','666','KEY')`;
    expect(extractPrintDocsIds(html)).toEqual({
      mandant: "603",
      client_id: "60952",
      orderval: "17032005",
    });
  });

  it("returns an empty object when no PrintDocs call is present", () => {
    expect(extractPrintDocsIds("just some innerText, no attributes")).toEqual({});
  });
});

describe("parseOpalDetail with the internal ids", () => {
  it("populates orderval/mandant/client_id from the page HTML", () => {
    const text = "SendungsNr OCU-998-520133\nzur Liste zurück";
    const html = `<a onclick="PrintDocs('hwb','603','60952','17032005','KEY')">x</a>`;
    const s = parseOpalDetail(text, html);
    expect(s.ocu_number).toBe("OCU-998-520133");
    expect(s.orderval).toBe("17032005");
    expect(s.mandant).toBe("603");
    expect(s.client_id).toBe("60952");
  });

  it("leaves the ids undefined when the source carries no PrintDocs call", () => {
    const s = parseOpalDetail("SendungsNr OCU-1\n");
    expect(s.orderval).toBeUndefined();
    expect(s.mandant).toBeUndefined();
    expect(s.client_id).toBeUndefined();
  });
});
