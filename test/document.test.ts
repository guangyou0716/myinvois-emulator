import { describe, expect, it } from 'vitest';
import { inspectDocument, validateNone, xmlRootLocalName } from '../src/document.js';
import { readSample } from './helpers.js';

describe('document inspection', () => {
  it('reads the supplier TIN from the public JSON and XML samples', () => {
    const json = inspectDocument('JSON', readSample('1.1-Invoice-Sample.json'));
    const xml = inspectDocument('XML', readSample('1.1-Invoice-Sample.xml'));
    expect(json).toMatchObject({ invoiceRoot: true, supplierTin: "Supplier's TIN", buyerTin: "Buyer's TIN" });
    expect(xml).toMatchObject({ invoiceRoot: true, supplierTin: "Supplier's TIN", buyerTin: "Buyer's TIN" });
    expect(validateNone('JSON', readSample('1.0-Invoice-Sample.json')).ok).toBe(true);
    expect(validateNone('XML', readSample('1.0-Invoice-Sample.xml')).ok).toBe(true);
  });

  it('finds a TIN when it is not the first party identification', () => {
    const xml = `<?xml version="1.0"?>
      <Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2">
        <cac:AccountingSupplierParty>
          <cac:Party>
            <cac:PartyIdentification>
              <cbc:ID schemeID="BRN">NA</cbc:ID>
            </cac:PartyIdentification>
            <cac:PartyIdentification>
              <cbc:ID schemeID="TIN">C00000000000</cbc:ID>
            </cac:PartyIdentification>
          </cac:Party>
        </cac:AccountingSupplierParty>
        <cac:AccountingCustomerParty>
          <cac:Party>
            <cac:PartyIdentification>
              <cbc:ID schemeID="TIN">IG00000000000</cbc:ID>
            </cac:PartyIdentification>
          </cac:Party>
        </cac:AccountingCustomerParty>
      </Invoice>`;
    expect(inspectDocument('XML', Buffer.from(xml))).toMatchObject({
      invoiceRoot: true,
      supplierTin: 'C00000000000',
      buyerTin: 'IG00000000000',
    });
  });

  it('rejects JSON and XML that have no Invoice root', () => {
    expect(validateNone('JSON', Buffer.from('{"CreditNote":[{}]}', 'utf8')).ok).toBe(false);
    expect(validateNone('JSON', Buffer.from('not-json', 'utf8')).ok).toBe(false);
    expect(validateNone('XML', Buffer.from('<CreditNote></CreditNote>', 'utf8')).ok).toBe(false);
    expect(xmlRootLocalName('<Invoice><ID></Invoice>')).toBeNull();
    expect(validateNone('XML', Buffer.from('<Invoice><ID></Invoice>', 'utf8')).ok).toBe(false);
  });

  it('reads a prefixed Invoice root', () => {
    expect(xmlRootLocalName('<ns:Invoice></ns:Invoice>')).toBe('Invoice');
  });
});
