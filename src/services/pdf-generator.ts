/**
 * PDF Generator Service
 *
 * Generates PDF documents (quotes and invoices) from HTML templates using Puppeteer.
 */

import puppeteer, { type Browser } from 'puppeteer';
import Handlebars from 'handlebars';
import fs from 'fs';
import path from 'path';
import logger from '../utils/logger.js';
import type { Document, DocumentType } from '../repositories/document-repository.js';

// ============================================================================
// TYPES
// ============================================================================

export interface DocumentTemplateData {
  // Document info
  documentNumber: string;
  customerNumber: string;
  dateFormatted: string;
  validUntilFormatted?: string;
  servicePeriodFormatted?: string;

  // Customer
  customer: {
    name: string | null;
    company: string | null;
    street: string | null;
    city: string | null;
    zip: string | null;
    country: string | null;
  };

  // Stay details
  checkInFormatted: string;
  checkOutFormatted: string;
  nights: number;
  guestsCount: number | null;
  guestsIncluded: number;

  // Pricing (formatted strings)
  accommodationRateFormatted: string;
  accommodationTotalFormatted: string;
  hasExtraGuests: boolean;
  extraGuestNights: number;
  extraGuestRateFormatted: string;
  extraGuestTotalFormatted: string;
  cleaningFeeFormatted: string;
  hasDiscount: boolean;
  discountTotalFormatted: string;
  discountDescription: string | undefined;
  subtotalFormatted: string;
  taxRate: number;
  taxAmountFormatted: string;
  totalFormatted: string;

  // Notes
  guestNotes: string | undefined;

  // Logo
  logoBase64: string;
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Load logo as Base64 data URL
 */
function getLogoBase64(): string {
  const logoPath = path.join(process.cwd(), 'public', 'assets', 'Logo-S-Black.png');
  if (fs.existsSync(logoPath)) {
    const logoData = fs.readFileSync(logoPath);
    return `data:image/png;base64,${logoData.toString('base64')}`;
  }
  return '';
}

/**
 * Format cents to Euro string (e.g., 150000 -> "1.500,00")
 */
function formatCurrency(cents: number): string {
  const euros = cents / 100;
  return euros.toLocaleString('de-DE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * Format date to German format (e.g., "13.01.2026")
 */
function formatDateGerman(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleDateString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

/**
 * Generate a simple customer number from reservation ID
 */
function generateCustomerNumber(reservationId: string): string {
  // Use last 5 chars of reservation ID as customer number
  const suffix = reservationId.slice(-5).toUpperCase();
  return `1${suffix}`;
}

/**
 * Convert Document to template data
 */
export function documentToTemplateData(doc: Document): DocumentTemplateData {
  const today = new Date();
  const validUntil = new Date(today);
  validUntil.setDate(validUntil.getDate() + 7); // Quote valid for 7 days

  return {
    documentNumber: doc.documentNumber,
    customerNumber: generateCustomerNumber(doc.reservationId),
    dateFormatted: formatDateGerman(today.toISOString()),
    validUntilFormatted: doc.documentType === 'quote'
      ? formatDateGerman(doc.validUntil || validUntil.toISOString())
      : undefined,
    servicePeriodFormatted: doc.documentType === 'invoice'
      ? `${formatDateGerman(doc.checkIn)} - ${formatDateGerman(doc.checkOut)}`
      : undefined,

    customer: doc.customer,

    checkInFormatted: formatDateGerman(doc.checkIn),
    checkOutFormatted: formatDateGerman(doc.checkOut),
    nights: doc.nights,
    guestsCount: doc.guestsCount,
    guestsIncluded: doc.guestsIncluded,

    accommodationRateFormatted: formatCurrency(doc.accommodationRate),
    accommodationTotalFormatted: formatCurrency(doc.accommodationTotal),
    hasExtraGuests: doc.extraGuestTotal > 0,
    extraGuestNights: doc.extraGuestNights,
    extraGuestRateFormatted: formatCurrency(doc.extraGuestRate),
    extraGuestTotalFormatted: formatCurrency(doc.extraGuestTotal),
    cleaningFeeFormatted: formatCurrency(doc.cleaningFee),
    hasDiscount: doc.discountTotal < 0,
    discountTotalFormatted: formatCurrency(doc.discountTotal), // Will be negative like "-650,00"
    discountDescription: doc.discountDescription,
    subtotalFormatted: formatCurrency(doc.subtotal),
    taxRate: doc.taxRate,
    taxAmountFormatted: formatCurrency(doc.taxAmount),
    totalFormatted: formatCurrency(doc.total),

    guestNotes: doc.guestNotes,

    logoBase64: getLogoBase64(),
  };
}

// ============================================================================
// PDF GENERATOR CLASS
// ============================================================================

class PDFGenerator {
  private browser: Browser | null = null;
  private templates: Map<DocumentType, Handlebars.TemplateDelegate> = new Map();
  private templatesDir: string;

  constructor() {
    this.templatesDir = path.join(process.cwd(), 'data', 'templates');
  }

  /**
   * Initialize browser instance (lazy loading)
   */
  private async getBrowser(): Promise<Browser> {
    if (!this.browser) {
      logger.debug('Launching Puppeteer browser');
      this.browser = await puppeteer.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
        ],
      });
    }
    return this.browser;
  }

  /**
   * Load and compile template (with caching)
   */
  private getTemplate(type: DocumentType): Handlebars.TemplateDelegate {
    if (this.templates.has(type)) {
      return this.templates.get(type)!;
    }

    const templateFile = type === 'quote' ? 'angebot.html' : 'rechnung.html';
    const templatePath = path.join(this.templatesDir, templateFile);

    if (!fs.existsSync(templatePath)) {
      throw new Error(`Template not found: ${templatePath}`);
    }

    const templateSource = fs.readFileSync(templatePath, 'utf-8');
    const template = Handlebars.compile(templateSource);

    this.templates.set(type, template);
    logger.debug({ type, templatePath }, 'Template loaded and compiled');

    return template;
  }

  /**
   * Clear template cache (useful when templates are edited)
   */
  clearTemplateCache(): void {
    this.templates.clear();
    logger.info('Template cache cleared');
  }

  /**
   * Generate PDF from document
   */
  async generatePDF(document: Document): Promise<Buffer> {
    const startTime = Date.now();

    try {
      // Get template and render HTML
      const template = this.getTemplate(document.documentType);
      const templateData = documentToTemplateData(document);
      const html = template(templateData);

      // Launch browser and create page
      const browser = await this.getBrowser();
      const page = await browser.newPage();

      try {
        // Set content
        await page.setContent(html, {
          waitUntil: 'networkidle0',
        });

        // Generate PDF
        const pdfBuffer = await page.pdf({
          format: 'A4',
          printBackground: true,
          margin: {
            top: '0',
            right: '0',
            bottom: '0',
            left: '0',
          },
        });

        const duration = Date.now() - startTime;
        logger.info(
          {
            documentNumber: document.documentNumber,
            type: document.documentType,
            duration,
            size: pdfBuffer.length,
          },
          'PDF generated successfully'
        );

        return Buffer.from(pdfBuffer);
      } finally {
        await page.close();
      }
    } catch (error) {
      logger.error(
        {
          error,
          documentNumber: document.documentNumber,
          type: document.documentType,
        },
        'Failed to generate PDF'
      );
      throw error;
    }
  }

  /**
   * Generate PDF and save to file
   */
  async generateAndSavePDF(document: Document, outputPath: string): Promise<string> {
    const pdfBuffer = await this.generatePDF(document);

    // Ensure directory exists
    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(outputPath, pdfBuffer);
    logger.info({ outputPath, documentNumber: document.documentNumber }, 'PDF saved to file');

    return outputPath;
  }

  /**
   * Close browser instance
   */
  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      logger.debug('Puppeteer browser closed');
    }
  }
}

// ============================================================================
// SINGLETON INSTANCE
// ============================================================================

export const pdfGenerator = new PDFGenerator();

// Clean up on process exit
process.on('beforeExit', async () => {
  await pdfGenerator.close();
});
