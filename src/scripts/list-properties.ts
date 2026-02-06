import { guestyClient } from '../services/guesty-client.js';

async function main() {
  const response = await (guestyClient as any).request('/listings?fields=_id title nickname address propertyType accommodates bedrooms bathrooms active&limit=50');

  if (Array.isArray(response)) {
    console.log(`Found ${response.length} listings:\n`);
    for (const listing of response) {
      console.log(`  ID: ${listing._id}`);
      console.log(`  Title: ${listing.title}`);
      console.log(`  Nickname: ${listing.nickname || '(none)'}`);
      console.log(`  Type: ${listing.propertyType}`);
      console.log(`  Accommodates: ${listing.accommodates}`);
      console.log(`  City: ${listing.address?.city || '(none)'}`);
      console.log(`  Active: ${listing.active}`);
      console.log('');
    }
  } else {
    // Guesty returns { results: [...], count, limit, skip }
    const results = response.results || [response];
    console.log(`Found ${results.length} listings:\n`);
    for (const listing of results) {
      console.log(`  ID: ${listing._id}`);
      console.log(`  Title: ${listing.title}`);
      console.log(`  Nickname: ${listing.nickname || '(none)'}`);
      console.log(`  Type: ${listing.propertyType}`);
      console.log(`  Accommodates: ${listing.accommodates}`);
      console.log(`  City: ${listing.address?.city || '(none)'}`);
      console.log(`  Active: ${listing.active}`);
      console.log('');
    }
  }
}
main().catch(console.error);
