/**
 * Document Service
 *
 * Business logic for creating quotes and invoices from reservation data.
 * Fetches data from Guesty API and generates documents.
 */

import { guestyClient } from './guesty-client.js';
import { pdfGenerator } from './pdf-generator.js';
import {
  createDocument,
  updateDocument,
  getDocumentByReservation,
  getDocumentById,
  type DocumentType,
  type DocumentData,
  type Document,
} from '../repositories/document-repository.js';
import { getListingById } from '../repositories/listings-repository.js';
import logger from '../utils/logger.js';
import type { GuestyGuest } from '../types/guesty.js';

// ============================================================================
// TYPES
// ============================================================================

export interface CreateDocumentOptions {
  reservationId: string;
  documentType: DocumentType;
  forceNew?: boolean; // Create new even if one exists
}

export interface DocumentResult {
  document: Document;
  pdf: Buffer;
  isNew: boolean;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Convert Euro amount to cents
 */
function euroToCents(euros: number): number {
  return Math.round(euros * 100);
}

/**
 * Calculate number of nights between two dates
 */
function calculateNights(checkIn: string, checkOut: string): number {
  const start = new Date(checkIn);
  const end = new Date(checkOut);
  const diffTime = end.getTime() - start.getTime();
  return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
}

/**
 * Company name suffixes that indicate a business entity
 */
const COMPANY_SUFFIXES = [
  'gmbh', 'ag', 'ug', 'kg', 'ohg', 'gbr', 'e.v.', 'ev', 'e.v',
  'ltd', 'ltd.', 'limited', 'inc', 'inc.', 'corp', 'corp.',
  'co.', 'co', '& co', '& co.', 'gmbh & co', 'gmbh & co.',
  'mbh', 'partg', 'se', 'kgaa',
];

/**
 * Check if a name looks like a company name
 */
function isCompanyName(name: string | null | undefined): boolean {
  if (!name) return false;
  const lowerName = name.toLowerCase().trim();
  return COMPANY_SUFFIXES.some(suffix => lowerName.endsWith(suffix));
}

/**
 * Extract customer name and company from guest data
 * If firstName contains a company suffix (GmbH, AG, etc.), treat it as company name
 * and lastName as contact person
 */
function extractCustomerInfo(guest: GuestyGuest | null, fallbackName?: string): {
  name: string | null;
  company: string | null;
} {
  if (!guest) {
    return { name: fallbackName || null, company: null };
  }

  // If Guesty has a company field, use it
  if (guest.company) {
    const name = guest.fullName ||
      (guest.firstName && guest.lastName ? `${guest.firstName} ${guest.lastName}` : null) ||
      guest.firstName || guest.lastName || fallbackName || null;
    return { name, company: guest.company };
  }

  // Check if firstName is actually a company name
  if (isCompanyName(guest.firstName)) {
    // firstName = Company, lastName = Contact Person
    return {
      name: guest.lastName || null,       // Contact person as name
      company: guest.firstName || null,   // Company name
    };
  }

  // Normal case: combine first and last name
  const name = guest.fullName ||
    (guest.firstName && guest.lastName ? `${guest.firstName} ${guest.lastName}` : null) ||
    guest.firstName || guest.lastName || fallbackName || null;

  return { name, company: null };
}

// ============================================================================
// MAIN SERVICE FUNCTIONS
// ============================================================================

/**
 * Fetch reservation details from Guesty API including guest address
 */
async function fetchReservationWithGuest(reservationId: string): Promise<{
  reservation: any;
  guest: GuestyGuest | null;
}> {
  logger.debug({ reservationId }, 'Fetching reservation details from Guesty');

  // Fetch reservation from Guesty API
  const reservation = await guestyClient.getReservation(reservationId);

  // Fetch guest details if guest ID is available
  let guest: GuestyGuest | null = null;
  const guestId = reservation.guest?._id || reservation.guestId;

  if (guestId) {
    try {
      guest = await guestyClient.getGuest(guestId);
      logger.debug({ guestId, fullName: guest.fullName }, 'Guest details fetched');
    } catch (error) {
      logger.warn({ error, guestId }, 'Failed to fetch guest details, continuing without address');
    }
  }

  return { reservation, guest };
}

/**
 * Extract pricing from Guesty reservation money object
 * Uses actual prices from the reservation, not calculated from listing defaults
 */
function extractPricingFromReservation(reservation: any, listing: any): {
  accommodationTotal: number;
  accommodationRate: number;
  extraGuestTotal: number;
  extraGuestRate: number;
  extraGuestNights: number;
  cleaningFee: number;
  discountTotal: number;
  discountDescription: string | undefined;
  subtotal: number;
  taxRate: number;
  taxAmount: number;
  total: number;
  guestNotes: string | undefined;
} {
  const money = reservation.money;
  const nights = reservation.nightsCount || calculateNights(reservation.checkIn, reservation.checkOut);
  const guestsCount = reservation.guestsCount || 1;
  const guestsIncluded = money?.settingsSnapshot?.guestsIncludedInRegularFee || listing?.guests_included || 5;

  // Get accommodation fare from Guesty (use ORIGINAL price before discounts for display)
  // fareAccommodation is the original price, fareAccommodationAdjusted includes discounts
  const accommodationTotal = euroToCents(money?.fareAccommodation ?? 0);
  const accommodationRate = nights > 0 ? Math.round(accommodationTotal / nights) : accommodationTotal;

  // Get cleaning fee from Guesty (use ORIGINAL baseAmount for display, not the discounted amount)
  const cleaningFeeItem = money?.invoiceItems?.find((item: any) =>
    item.normalType === 'CF' || item.type === 'CLEANING_FEE'
  );
  // Use baseAmount (original) if available, otherwise use amount (which may be discounted)
  const cleaningFee = euroToCents(cleaningFeeItem?.baseAmount ?? cleaningFeeItem?.amount ?? money?.fareCleaning ?? 0);

  // Get taxes from Guesty
  const totalTaxes = euroToCents(money?.totalTaxes || 0);

  // Calculate tax rate from the settings snapshot
  const taxSettings = money?.settingsSnapshot?.taxes?.find((t: any) => t.type === 'VAT');
  const taxRate = taxSettings?.amount || 7;

  // Check for extra guest fees in invoice items
  let extraGuestTotal = 0;
  let extraGuestRate = euroToCents(money?.settingsSnapshot?.extraPersonFee || listing?.extra_person_fee || 100);

  // Look for extra guest fee in invoice items
  // Guesty uses 'EPF' as normalType for Extra Person Fee
  const extraGuestItem = money?.invoiceItems?.find((item: any) =>
    item.normalType === 'EPF' || item.normalType === 'EXTRA_PERSON_FEE' || item.type === 'EXTRA_PERSON_FEE'
  );
  if (extraGuestItem) {
    extraGuestTotal = euroToCents(extraGuestItem.amount || 0);
  }

  // Calculate extra guest nights (if there are extra guests beyond included)
  const extraGuests = Math.max(0, guestsCount - guestsIncluded);
  const extraGuestNights = extraGuests * nights;

  // Extract discounts from Guesty
  // Calculate total discount by comparing original vs final prices
  let discountTotal = 0;
  let discountDescription: string | undefined;

  // Calculate accommodation discount
  const accommodationDiscount = euroToCents(money?.fareAccommodationDiscount || 0);

  // Calculate cleaning fee discount (difference between baseAmount and amount)
  let cleaningDiscount = 0;
  if (cleaningFeeItem?.baseAmount && cleaningFeeItem?.amount) {
    cleaningDiscount = euroToCents(cleaningFeeItem.amount - cleaningFeeItem.baseAmount);
  }

  // Total discount is sum of all discounts (these are negative values)
  discountTotal = accommodationDiscount + cleaningDiscount;

  // Try to get discount description from adjustments in nightlyRateInvoiceItems
  const afItem = money?.nightlyRateInvoiceItems?.find((item: any) => item.normalType === 'AF');
  const cfItem = money?.nightlyRateInvoiceItems?.find((item: any) => item.normalType === 'CF');

  const allAdjustments = [
    ...(afItem?.adjustments || []),
    ...(cfItem?.adjustments || []),
  ];

  if (allAdjustments.length > 0) {
    // Get unique descriptions from adjustments
    const descriptions = allAdjustments
      .map((adj: any) => adj.description)
      .filter((desc: string) => desc && desc.trim())
      .filter((desc: string, index: number, arr: string[]) => arr.indexOf(desc) === index);

    if (descriptions.length > 0) {
      discountDescription = descriptions.join(', ');
    }
  }

  // Get guest notes from reservation.notes.guest
  const guestNotes = reservation.notes?.guest || undefined;

  // Subtotal (net, before taxes)
  const subtotal = euroToCents(money?.subTotalPrice || 0) || (accommodationTotal + extraGuestTotal + cleaningFee);

  // Total including taxes
  const total = euroToCents(money?.hostPayout || money?.balanceDue || 0) || (subtotal + totalTaxes);

  return {
    accommodationTotal,
    accommodationRate,
    extraGuestTotal,
    extraGuestRate,
    extraGuestNights,
    cleaningFee,
    discountTotal,
    discountDescription,
    subtotal,
    taxRate,
    taxAmount: totalTaxes,
    total,
    guestNotes,
  };
}

/**
 * Get or create a document (quote or invoice) for a reservation
 * If document exists, returns it from DB (fast, no API call)
 * If document doesn't exist, fetches data from Guesty API and creates it
 */
export async function createOrGetDocument(options: CreateDocumentOptions): Promise<DocumentResult> {
  const { reservationId, documentType } = options;

  logger.info({ reservationId, documentType }, 'Getting or creating document');

  // Check if document already exists
  const existingDoc = getDocumentByReservation(reservationId, documentType);

  if (existingDoc) {
    // Return existing document from DB (no API call)
    logger.info(
      { documentNumber: existingDoc.documentNumber, reservationId },
      'Returning existing document from database'
    );
    const pdf = await pdfGenerator.generatePDF(existingDoc);
    return { document: existingDoc, pdf, isNew: false };
  }

  // Document doesn't exist - fetch from Guesty and create
  const document = await fetchAndCreateDocument(reservationId, documentType);

  logger.info(
    { documentNumber: document.documentNumber, type: documentType, reservationId },
    'New document created'
  );

  // Generate PDF
  const pdf = await pdfGenerator.generatePDF(document);

  return { document, pdf, isNew: true };
}

/**
 * Refresh/regenerate a document with fresh data from Guesty API
 * Updates the existing document with new data while keeping the same document number
 * If no document exists, creates a new one
 */
export async function refreshDocument(options: CreateDocumentOptions): Promise<DocumentResult> {
  const { reservationId, documentType } = options;

  logger.info({ reservationId, documentType }, 'Refreshing document with fresh Guesty data');

  // Check if document exists
  const existingDoc = getDocumentByReservation(reservationId, documentType);

  if (existingDoc) {
    // Update existing document with fresh data (keeps the same number)
    logger.info(
      { documentNumber: existingDoc.documentNumber, id: existingDoc.id },
      'Updating existing document with fresh data (keeping same number)'
    );

    // Fetch fresh data from Guesty
    const documentData = await fetchDocumentDataFromGuesty(reservationId, documentType);

    // Update the document in database (keeps document_number unchanged)
    const updatedDoc = updateDocument(existingDoc.id, documentData);

    logger.info(
      { documentNumber: updatedDoc.documentNumber, type: documentType, reservationId },
      'Document refreshed successfully with same number'
    );

    // Generate PDF with updated data
    const pdf = await pdfGenerator.generatePDF(updatedDoc);

    return { document: updatedDoc, pdf, isNew: false };
  }

  // No existing document - create new one with new number
  logger.info({ reservationId, documentType }, 'No existing document found, creating new one');

  const document = await fetchAndCreateDocument(reservationId, documentType);

  logger.info(
    { documentNumber: document.documentNumber, type: documentType, reservationId },
    'New document created'
  );

  // Generate PDF
  const pdf = await pdfGenerator.generatePDF(document);

  return { document, pdf, isNew: true };
}

/**
 * Fetch document data from Guesty API
 */
async function fetchDocumentDataFromGuesty(reservationId: string, documentType: DocumentType): Promise<DocumentData> {
  // Fetch fresh data from Guesty API
  const { reservation, guest } = await fetchReservationWithGuest(reservationId);

  // Get listing from local DB for pricing info
  const listing = getListingById(reservation.listingId);

  // Extract pricing from Guesty reservation data
  const pricing = extractPricingFromReservation(reservation, listing);

  // Calculate nights
  const nights = reservation.nightsCount || calculateNights(reservation.checkIn, reservation.checkOut);

  // Prepare document data
  const today = new Date();
  const validUntil = new Date(today);
  validUntil.setDate(validUntil.getDate() + 7);

  // Extract customer name and company (handles company names in firstName field)
  const customerInfo = extractCustomerInfo(guest, reservation.guest?.fullName);

  return {
    documentType,
    reservationId,
    customer: {
      name: customerInfo.name,
      company: customerInfo.company,
      street: guest?.address?.street || guest?.address?.full || null,
      city: guest?.address?.city || null,
      zip: (guest?.address as any)?.zipCode || guest?.address?.zipcode || null,
      country: guest?.address?.country || null,
    },
    checkIn: reservation.checkInDateLocalized || reservation.checkIn,
    checkOut: reservation.checkOutDateLocalized || reservation.checkOut,
    nights,
    guestsCount: reservation.guestsCount || null,
    guestsIncluded: reservation.money?.settingsSnapshot?.guestsIncludedInRegularFee || listing?.guests_included || 5,
    currency: reservation.money?.currency || listing?.currency || 'EUR',
    ...pricing,
    validUntil: documentType === 'quote' ? validUntil.toISOString().split('T')[0] : undefined,
    servicePeriodStart: documentType === 'invoice' ? reservation.checkInDateLocalized || reservation.checkIn : undefined,
    servicePeriodEnd: documentType === 'invoice' ? reservation.checkOutDateLocalized || reservation.checkOut : undefined,
  };
}

/**
 * Fetch data from Guesty and create a new document
 */
async function fetchAndCreateDocument(reservationId: string, documentType: DocumentType): Promise<Document> {
  const documentData = await fetchDocumentDataFromGuesty(reservationId, documentType);
  return createDocument(documentData);
}

/**
 * Get an existing document by ID and generate PDF
 */
export async function getDocumentWithPDF(documentId: number): Promise<DocumentResult | null> {
  const document = getDocumentById(documentId);
  if (!document) {
    return null;
  }

  const pdf = await pdfGenerator.generatePDF(document);
  return { document, pdf, isNew: false };
}

/**
 * Regenerate PDF for an existing document (e.g., after template changes)
 */
export async function regeneratePDF(documentId: number): Promise<Buffer | null> {
  const document = getDocumentById(documentId);
  if (!document) {
    return null;
  }

  // Clear template cache to pick up any changes
  pdfGenerator.clearTemplateCache();

  return pdfGenerator.generatePDF(document);
}
