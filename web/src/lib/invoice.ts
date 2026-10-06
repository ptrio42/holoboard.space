export const MOCK_INVOICE_MESSAGE = "This preview uses test invoices. Real wallet payments are unavailable.";

/** Recognize the placeholder emitted by MockLightningBackend, including saved sessions. */
export function isMockInvoice(invoice: string): boolean {
    return /^lnbc\d+\.\.\.mock_invoice$/i.test(invoice);
}
