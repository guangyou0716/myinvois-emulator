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

  it('extracts names, amounts, type, issue time, and party ids from public samples', () => {
    const json = inspectDocument('JSON', readSample('1.1-Invoice-Sample.json'));
    expect(json).toMatchObject({
      invoiceRoot: true,
      supplierTin: "Supplier's TIN",
      buyerTin: "Buyer's TIN",
      supplierName: "Supplier's Name",
      buyerName: "Buyer's Name",
      typeCode: '01',
      typeName: 'invoice',
      typeVersionName: '1.1',
      totalSales: 1436.5,
      totalDiscount: 1436.5,
      netAmount: 1436.5,
      total: 1436.5,
    });
    expect(json.supplierId).toEqual({ scheme: 'BRN', value: "Supplier's BRN" });
    expect(json.buyerId).toEqual({ scheme: 'BRN', value: "Buyer's BRN" });
    expect(json.issuedAt).toBe(Date.parse('2024-07-23T00:30:00Z'));
    expect(json.classificationCodes).toEqual(expect.arrayContaining(['003', '9800.00.0010']));

    const xml = inspectDocument('XML', readSample('1.1-Invoice-Sample.xml'));
    expect(xml).toMatchObject({
      invoiceRoot: true,
      supplierName: "Supplier's Name",
      buyerName: "Buyer's Name",
      typeCode: '01',
      typeName: 'invoice',
      typeVersionName: '1.1',
      totalSales: 1436.5,
      total: 1436.5,
    });
    expect(xml.issuedAt).toBe(Date.parse('2024-07-23T00:40:00Z'));
  });

  it('treats an IssueTime without an offset as UTC', () => {
    const expected = Date.UTC(2024, 6, 23, 15, 30, 0);
    const json = inspectDocument(
      'JSON',
      Buffer.from(
        JSON.stringify({
          Invoice: [{ IssueDate: [{ _: '2024-07-23' }], IssueTime: [{ _: '15:30:00' }] }],
        }),
      ),
    );
    expect(json.issuedAt).toBe(expected);

    const xml = `<?xml version="1.0"?>
      <Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2">
        <cbc:IssueDate>2024-07-23</cbc:IssueDate>
        <cbc:IssueTime>15:30:00</cbc:IssueTime>
      </Invoice>`;
    expect(inspectDocument('XML', Buffer.from(xml)).issuedAt).toBe(expected);
  });
});
