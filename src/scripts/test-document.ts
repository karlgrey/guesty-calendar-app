/**
 * Test Document Generation
 *
 * Tests the document generation service directly.
 */

import { initDatabase } from '../db/index.js';
import { createOrGetDocument } from '../services/document-service.js';
import { pdfGenerator } from '../services/pdf-generator.js';
import fs from 'fs';
import path from 'path';

async function main() {
  console.log('Initializing database...');
  initDatabase();

  // Use a real reservation ID from the database
  const reservationId = process.argv[2] || '691201e1a4e56a8196df5689';
  const documentType = (process.argv[3] || 'quote') as 'quote' | 'invoice';

  console.log(`\nGenerating ${documentType} for reservation: ${reservationId}`);

  try {
    const result = await createOrGetDocument({
      reservationId,
      documentType,
    });

    console.log('\n=== Document Created ===');
    console.log(`Document Number: ${result.document.documentNumber}`);
    console.log(`Is New: ${result.isNew}`);
    console.log(`Customer: ${result.document.customer.name || 'N/A'}`);
    console.log(`Company: ${result.document.customer.company || 'N/A'}`);
    console.log(`Check-in: ${result.document.checkIn}`);
    console.log(`Check-out: ${result.document.checkOut}`);
    console.log(`Nights: ${result.document.nights}`);
    console.log(`Total: ${(result.document.total / 100).toFixed(2)} EUR`);

    // Save PDF to file
    const outputDir = path.join(process.cwd(), 'data', 'generated');
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const filename = documentType === 'quote'
      ? `Angebot_${result.document.documentNumber}.pdf`
      : `Rechnung_${result.document.documentNumber}.pdf`;
    const outputPath = path.join(outputDir, filename);

    fs.writeFileSync(outputPath, result.pdf);
    console.log(`\nPDF saved to: ${outputPath}`);

  } catch (error) {
    console.error('Error generating document:', error);
  } finally {
    await pdfGenerator.close();
    process.exit(0);
  }
}

main();
