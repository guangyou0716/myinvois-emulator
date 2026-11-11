import { invalidDocumentError, type StandardError } from './errors.js';

export type DocumentFormat = 'JSON' | 'XML';

/** Party identifier schemes accepted by recent/search receiver and issuer filters. */
export const PARTY_ID_SCHEMES = ['BRN', 'NRIC', 'PASSPORT', 'ARMY'] as const;
export type PartyIdScheme = (typeof PARTY_ID_SCHEMES)[number];

/** InvoiceTypeCode → typeName used in recent/search summaries. */
export const DOCUMENT_TYPE_NAMES: Record<string, string> = {
  '01': 'invoice',
  '02': 'credit note',
  '03': 'debit note',
  '04': 'refund note',
  '11': 'self-billed invoice',
  '12': 'self-billed credit note',
  '13': 'self-billed debit note',
  '14': 'self-billed refund note',
};

export interface PartyId {
  scheme: PartyIdScheme;
  value: string;
}

export interface DocumentInspection {
  invoiceRoot: boolean;
  supplierTin: string | null;
  buyerTin: string | null;
  supplierName: string | null;
  buyerName: string | null;
  supplierId: PartyId | null;
  buyerId: PartyId | null;
  issuedAt: number | null;
  typeCode: string | null;
  typeName: string | null;
  typeVersionName: string | null;
  totalSales: number | null;
  totalDiscount: number | null;
  netAmount: number | null;
  total: number | null;
  classificationCodes: string[];
}

export interface NoneValidation {
  ok: boolean;
  error: StandardError | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

function decodeXmlText(value: string): string {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

function localName(qName: string): string {
  const index = qName.indexOf(':');
  return index >= 0 ? qName.slice(index + 1) : qName;
}

function findTagEnd(source: string, from: number): number {
  let quote: string | null = null;
  for (let index = from; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '>') return index;
  }
  return -1;
}

/** Well-formed enough XML, or null when the text is not a single-root document. */
export function xmlRootLocalName(xml: string): string | null {
  const source = xml.charCodeAt(0) === 0xfeff ? xml.slice(1) : xml;
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) return null;
  const stack: string[] = [];
  let root: string | null = null;
  let index = 0;
  while (index < source.length) {
    if (source[index] !== '<') {
      index += 1;
      continue;
    }
    if (source.startsWith('<?', index)) {
      const end = source.indexOf('?>', index + 2);
      if (end < 0) return null;
      index = end + 2;
      continue;
    }
    if (source.startsWith('<!--', index)) {
      const end = source.indexOf('-->', index + 4);
      if (end < 0) return null;
      index = end + 3;
      continue;
    }
    if (source.startsWith('<![CDATA[', index)) {
      const end = source.indexOf(']]>', index + 9);
      if (end < 0) return null;
      index = end + 3;
      continue;
    }
    if (source.startsWith('</', index)) {
      const end = findTagEnd(source, index + 2);
      if (end < 0) return null;
      const name = localName(source.slice(index + 2, end).trim());
      if (stack.pop() !== name) return null;
      index = end + 1;
      continue;
    }
    if (source.startsWith('<!', index)) return null;
    const end = findTagEnd(source, index + 1);
    if (end < 0) return null;
    let inner = source.slice(index + 1, end).trim();
    let selfClosing = false;
    if (inner.endsWith('/')) {
      selfClosing = true;
      inner = inner.slice(0, -1).trim();
    }
    const nameMatch = /^([^\s/>]+)/.exec(inner);
    if (!nameMatch) return null;
    const name = localName(nameMatch[1] ?? '');
    if (name === '') return null;
    if (stack.length === 0) {
      if (root !== null) return null;
      root = name;
    }
    if (!selfClosing) stack.push(name);
    index = end + 1;
  }
  if (root === null || stack.length !== 0) return null;
  return root;
}

function xmlSection(xml: string, partyLocalName: string): string | null {
  const pattern = new RegExp(
    `<(?:[\\w.-]+:)?${partyLocalName}\\b[^>]*>([\\s\\S]*?)</(?:[\\w.-]+:)?${partyLocalName}>`,
  );
  const match = pattern.exec(xml);
  return match?.[1] ?? null;
}

function emptyInspection(invoiceRoot: boolean): DocumentInspection {
  return {
    invoiceRoot,
    supplierTin: null,
    buyerTin: null,
    supplierName: null,
    buyerName: null,
    supplierId: null,
    buyerId: null,
    issuedAt: null,
    typeCode: null,
    typeName: null,
    typeVersionName: null,
    totalSales: null,
    totalDiscount: null,
    netAmount: null,
    total: null,
    classificationCodes: [],
  };
}

function parsePartyIdScheme(value: string): PartyIdScheme | null {
  const upper = value.trim().toUpperCase();
  if (upper === 'BRN' || upper === 'NRIC' || upper === 'PASSPORT' || upper === 'ARMY') return upper;
  return null;
}

function scalarText(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (isRecord(value) && Object.hasOwn(value, '_')) return scalarText(value._);
  return null;
}

function scalarNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (isRecord(value) && Object.hasOwn(value, '_')) return scalarNumber(value._);
  return null;
}

function firstNode(container: Record<string, unknown>, key: string): unknown {
  return asList(container[key])[0];
}

function jsonParty(invoice: Record<string, unknown>, partyName: string): Record<string, unknown> | null {
  const wrapper = firstNode(invoice, partyName);
  if (!isRecord(wrapper)) return null;
  const party = firstNode(wrapper, 'Party');
  return isRecord(party) ? party : null;
}

function jsonPartyTin(party: Record<string, unknown> | null): string | null {
  if (party === null) return null;
  for (const identification of asList(party.PartyIdentification)) {
    if (!isRecord(identification)) continue;
    for (const id of asList(identification.ID)) {
      if (!isRecord(id)) continue;
      if (typeof id.schemeID === 'string' && id.schemeID.toUpperCase() === 'TIN') {
        const value = scalarText(id._);
        if (value !== null) return value;
      }
    }
  }
  return null;
}

function jsonPartyId(party: Record<string, unknown> | null): PartyId | null {
  if (party === null) return null;
  for (const identification of asList(party.PartyIdentification)) {
    if (!isRecord(identification)) continue;
    for (const id of asList(identification.ID)) {
      if (!isRecord(id) || typeof id.schemeID !== 'string') continue;
      const scheme = parsePartyIdScheme(id.schemeID);
      const value = scalarText(id._);
      if (scheme !== null && value !== null) return { scheme, value };
    }
  }
  return null;
}

function jsonPartyName(party: Record<string, unknown> | null): string | null {
  if (party === null) return null;
  const legal = firstNode(party, 'PartyLegalEntity');
  if (isRecord(legal)) {
    const name = scalarText(firstNode(legal, 'RegistrationName'));
    if (name !== null) return name;
  }
  const partyName = firstNode(party, 'PartyName');
  if (isRecord(partyName)) return scalarText(firstNode(partyName, 'Name'));
  return null;
}

function jsonAmount(invoice: Record<string, unknown>, field: string): number | null {
  const total = firstNode(invoice, 'LegalMonetaryTotal');
  if (!isRecord(total)) return null;
  return scalarNumber(firstNode(total, field));
}

/** MyInvois UBL IssueTime is UTC (`15:30:00Z`). An offset-less time is treated as UTC. */
function parseIssuedAt(date: string, time: string | null): number | null {
  const timePart = time === null ? '00:00:00Z' : time.replace(/^T/i, '');
  const withOffset = /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(timePart) ? timePart : `${timePart}Z`;
  const ms = Date.parse(`${date}T${withOffset}`);
  return Number.isNaN(ms) ? null : ms;
}

function jsonIssuedAt(invoice: Record<string, unknown>): number | null {
  const date = scalarText(firstNode(invoice, 'IssueDate'));
  if (date === null) return null;
  return parseIssuedAt(date, scalarText(firstNode(invoice, 'IssueTime')));
}

function jsonType(invoice: Record<string, unknown>): { code: string | null; version: string | null } {
  const node = firstNode(invoice, 'InvoiceTypeCode');
  if (!isRecord(node) && typeof node !== 'string' && typeof node !== 'number') {
    return { code: null, version: null };
  }
  const code = isRecord(node) ? scalarText(node._) : scalarText(node);
  const version = isRecord(node) && typeof node.listVersionID === 'string' ? node.listVersionID.trim() || null : null;
  return { code, version };
}

function jsonClassificationCodes(invoice: Record<string, unknown>): string[] {
  const codes: string[] = [];
  const seen = new Set<string>();
  for (const line of asList(invoice.InvoiceLine)) {
    if (!isRecord(line)) continue;
    const item = firstNode(line, 'Item');
    if (!isRecord(item)) continue;
    for (const classification of asList(item.CommodityClassification)) {
      if (!isRecord(classification)) continue;
      for (const codeNode of asList(classification.ItemClassificationCode)) {
        const code = scalarText(codeNode);
        if (code === null || seen.has(code)) continue;
        seen.add(code);
        codes.push(code);
      }
    }
  }
  return codes;
}

function inspectJsonInvoice(invoice: Record<string, unknown>): DocumentInspection {
  const supplier = jsonParty(invoice, 'AccountingSupplierParty');
  const buyer = jsonParty(invoice, 'AccountingCustomerParty');
  const type = jsonType(invoice);
  const typeCode = type.code;
  return {
    invoiceRoot: true,
    supplierTin: jsonPartyTin(supplier),
    buyerTin: jsonPartyTin(buyer),
    supplierName: jsonPartyName(supplier),
    buyerName: jsonPartyName(buyer),
    supplierId: jsonPartyId(supplier),
    buyerId: jsonPartyId(buyer),
    issuedAt: jsonIssuedAt(invoice),
    typeCode,
    typeName: typeCode === null ? null : (DOCUMENT_TYPE_NAMES[typeCode] ?? typeCode),
    typeVersionName: type.version,
    totalSales: jsonAmount(invoice, 'TaxExclusiveAmount'),
    totalDiscount: jsonAmount(invoice, 'AllowanceTotalAmount'),
    netAmount: jsonAmount(invoice, 'LineExtensionAmount'),
    total: jsonAmount(invoice, 'PayableAmount'),
    classificationCodes: jsonClassificationCodes(invoice),
  };
}

function xmlFirstTag(section: string, localNameValue: string): string | null {
  const pattern = new RegExp(
    `<(?:[\\w.-]+:)?${localNameValue}\\b[^>]*>([^<]*)</(?:[\\w.-]+:)?${localNameValue}>`,
    'i',
  );
  const match = pattern.exec(section);
  if (!match) return null;
  const value = decodeXmlText(match[1] ?? '').trim();
  return value === '' ? null : value;
}

function xmlFirstNumber(section: string, localNameValue: string): number | null {
  const text = xmlFirstTag(section, localNameValue);
  if (text === null) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function xmlIds(section: string): Array<{ scheme: string; value: string }> {
  const pattern = /<(?:[\w.-]+:)?ID\b([^>]*)>([^<]*)<\/(?:[\w.-]+:)?ID>/gi;
  const ids: Array<{ scheme: string; value: string }> = [];
  for (const match of section.matchAll(pattern)) {
    const attrs = match[1] ?? '';
    const schemeMatch = /\bschemeID\s*=\s*["']([^"']+)["']/i.exec(attrs);
    const value = decodeXmlText(match[2] ?? '').trim();
    if (schemeMatch && value !== '') ids.push({ scheme: schemeMatch[1] ?? '', value });
  }
  return ids;
}

function xmlTin(section: string): string | null {
  for (const id of xmlIds(section)) {
    if (id.scheme.toUpperCase() === 'TIN') return id.value;
  }
  return null;
}

function xmlPartyId(section: string): PartyId | null {
  for (const id of xmlIds(section)) {
    const scheme = parsePartyIdScheme(id.scheme);
    if (scheme !== null) return { scheme, value: id.value };
  }
  return null;
}

function xmlIssuedAt(xml: string): number | null {
  const date = xmlFirstTag(xml, 'IssueDate');
  if (date === null) return null;
  return parseIssuedAt(date, xmlFirstTag(xml, 'IssueTime'));
}

function xmlType(xml: string): { code: string | null; version: string | null } {
  const pattern = /<(?:[\w.-]+:)?InvoiceTypeCode\b([^>]*)>([^<]*)<\/(?:[\w.-]+:)?InvoiceTypeCode>/i;
  const match = pattern.exec(xml);
  if (!match) return { code: null, version: null };
  const attrs = match[1] ?? '';
  const versionMatch = /\blistVersionID\s*=\s*["']([^"']+)["']/i.exec(attrs);
  const code = decodeXmlText(match[2] ?? '').trim();
  return {
    code: code === '' ? null : code,
    version: versionMatch?.[1] ? versionMatch[1].trim() || null : null,
  };
}

function xmlClassificationCodes(xml: string): string[] {
  const pattern =
    /<(?:[\w.-]+:)?ItemClassificationCode\b[^>]*>([^<]*)<\/(?:[\w.-]+:)?ItemClassificationCode>/gi;
  const codes: string[] = [];
  const seen = new Set<string>();
  for (const match of xml.matchAll(pattern)) {
    const code = decodeXmlText(match[1] ?? '').trim();
    if (code === '' || seen.has(code)) continue;
    seen.add(code);
    codes.push(code);
  }
  return codes;
}

function inspectXmlInvoice(xml: string): DocumentInspection {
  const supplier = xmlSection(xml, 'AccountingSupplierParty');
  const buyer = xmlSection(xml, 'AccountingCustomerParty');
  const monetary = xmlSection(xml, 'LegalMonetaryTotal') ?? xml;
  const type = xmlType(xml);
  const typeCode = type.code;
  return {
    invoiceRoot: true,
    supplierTin: supplier === null ? null : xmlTin(supplier),
    buyerTin: buyer === null ? null : xmlTin(buyer),
    supplierName: supplier === null ? null : xmlFirstTag(supplier, 'RegistrationName'),
    buyerName: buyer === null ? null : xmlFirstTag(buyer, 'RegistrationName'),
    supplierId: supplier === null ? null : xmlPartyId(supplier),
    buyerId: buyer === null ? null : xmlPartyId(buyer),
    issuedAt: xmlIssuedAt(xml),
    typeCode,
    typeName: typeCode === null ? null : (DOCUMENT_TYPE_NAMES[typeCode] ?? typeCode),
    typeVersionName: type.version,
    totalSales: xmlFirstNumber(monetary, 'TaxExclusiveAmount'),
    totalDiscount: xmlFirstNumber(monetary, 'AllowanceTotalAmount'),
    netAmount: xmlFirstNumber(monetary, 'LineExtensionAmount'),
    total: xmlFirstNumber(monetary, 'PayableAmount'),
    classificationCodes: xmlClassificationCodes(xml),
  };
}

export function inspectDocument(format: DocumentFormat, bytes: Buffer): DocumentInspection {
  const text = bytes.toString('utf8');
  if (format === 'JSON') {
    try {
      const parsed: unknown = JSON.parse(text);
      if (!isRecord(parsed)) return emptyInspection(false);
      const invoice = asList(parsed.Invoice)[0];
      if (!isRecord(invoice)) return emptyInspection(false);
      return inspectJsonInvoice(invoice);
    } catch {
      return emptyInspection(false);
    }
  }
  const root = xmlRootLocalName(text);
  if (root !== 'Invoice') return emptyInspection(false);
  return inspectXmlInvoice(text);
}

/** Default validator `none`: parseable JSON or XML with an Invoice root. */
export function validateNone(format: DocumentFormat, bytes: Buffer): NoneValidation {
  if (inspectDocument(format, bytes).invoiceRoot) return { ok: true, error: null };
  return { ok: false, error: invalidDocumentError() };
}
