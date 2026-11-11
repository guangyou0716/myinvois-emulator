import { invalidDocumentError, type StandardError } from './errors.js';

export type DocumentFormat = 'JSON' | 'XML';

export interface DocumentInspection {
  invoiceRoot: boolean;
  supplierTin: string | null;
  buyerTin: string | null;
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

function tinFromXmlSection(section: string): string | null {
  const pattern = /<(?:[\w.-]+:)?ID\b([^>]*)>([^<]*)<\/(?:[\w.-]+:)?ID>/gi;
  for (const match of section.matchAll(pattern)) {
    const attrs = match[1] ?? '';
    if (/\bschemeID\s*=\s*["']TIN["']/i.test(attrs)) {
      const value = decodeXmlText(match[2] ?? '').trim();
      if (value !== '') return value;
    }
  }
  return null;
}

function jsonPartyTin(invoice: Record<string, unknown>, partyName: string): string | null {
  const wrapper = asList(invoice[partyName])[0];
  if (!isRecord(wrapper)) return null;
  const party = asList(wrapper.Party)[0];
  if (!isRecord(party)) return null;
  for (const identification of asList(party.PartyIdentification)) {
    if (!isRecord(identification)) continue;
    for (const id of asList(identification.ID)) {
      if (!isRecord(id)) continue;
      if (typeof id.schemeID === 'string' && id.schemeID.toUpperCase() === 'TIN') {
        if (typeof id._ === 'string' && id._.trim() !== '') return id._.trim();
      }
    }
  }
  return null;
}

export function inspectDocument(format: DocumentFormat, bytes: Buffer): DocumentInspection {
  const text = bytes.toString('utf8');
  if (format === 'JSON') {
    try {
      const parsed: unknown = JSON.parse(text);
      if (!isRecord(parsed)) return { invoiceRoot: false, supplierTin: null, buyerTin: null };
      const invoice = asList(parsed.Invoice)[0];
      if (!isRecord(invoice)) return { invoiceRoot: false, supplierTin: null, buyerTin: null };
      return {
        invoiceRoot: true,
        supplierTin: jsonPartyTin(invoice, 'AccountingSupplierParty'),
        buyerTin: jsonPartyTin(invoice, 'AccountingCustomerParty'),
      };
    } catch {
      return { invoiceRoot: false, supplierTin: null, buyerTin: null };
    }
  }
  const root = xmlRootLocalName(text);
  if (root !== 'Invoice') return { invoiceRoot: false, supplierTin: null, buyerTin: null };
  const supplier = xmlSection(text, 'AccountingSupplierParty');
  const buyer = xmlSection(text, 'AccountingCustomerParty');
  return {
    invoiceRoot: true,
    supplierTin: supplier === null ? null : tinFromXmlSection(supplier),
    buyerTin: buyer === null ? null : tinFromXmlSection(buyer),
  };
}

/** Default validator `none`: parseable JSON or XML with an Invoice root. */
export function validateNone(format: DocumentFormat, bytes: Buffer): NoneValidation {
  if (inspectDocument(format, bytes).invoiceRoot) return { ok: true, error: null };
  return { ok: false, error: invalidDocumentError() };
}
