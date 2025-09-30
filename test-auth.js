/**
 * Test script to verify OAuth authentication with Guesty API
 */

import 'dotenv/config';

const OAUTH_URL = process.env.GUESTY_OAUTH_URL || 'https://open-api.guesty.com/oauth2/token';
const CLIENT_ID = process.env.GUESTY_CLIENT_ID;
const CLIENT_SECRET = process.env.GUESTY_CLIENT_SECRET;
const API_URL = process.env.GUESTY_API_URL || 'https://open-api.guesty.com/v1';

async function testAuthentication() {
  console.log('\n🔐 Testing Guesty OAuth Authentication\n');
  console.log('━'.repeat(50));

  // Step 1: Get access token
  console.log('\n📝 Step 1: Exchanging credentials for access token...');
  console.log(`   OAuth URL: ${OAUTH_URL}`);
  console.log(`   Client ID: ${CLIENT_ID?.substring(0, 10)}...`);

  try {
    const params = new URLSearchParams({
      grant_type: 'client_credentials',
      scope: 'open-api',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    });

    const tokenResponse = await fetch(OAUTH_URL, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    if (!tokenResponse.ok) {
      const error = await tokenResponse.text();
      console.error(`\n❌ Token exchange failed: ${tokenResponse.status} ${tokenResponse.statusText}`);
      console.error(`   Error: ${error}`);
      process.exit(1);
    }

    const tokenData = await tokenResponse.json();
    console.log(`\n✅ Access token obtained successfully!`);
    console.log(`   Token type: ${tokenData.token_type}`);
    console.log(`   Expires in: ${tokenData.expires_in} seconds (${Math.floor(tokenData.expires_in / 3600)} hours)`);
    console.log(`   Scope: ${tokenData.scope}`);
    console.log(`   Token: ${tokenData.access_token.substring(0, 20)}...`);

    // Step 2: Test API access - fetch listings
    console.log('\n📝 Step 2: Testing API access - fetching listings...');
    console.log(`   API URL: ${API_URL}`);

    const listingsResponse = await fetch(`${API_URL}/listings`, {
      headers: {
        'Authorization': `Bearer ${tokenData.access_token}`,
        'Content-Type': 'application/json',
      },
    });

    if (!listingsResponse.ok) {
      const error = await listingsResponse.text();
      console.error(`\n❌ API request failed: ${listingsResponse.status} ${listingsResponse.statusText}`);
      console.error(`   Error: ${error}`);
      process.exit(1);
    }

    const listings = await listingsResponse.json();
    console.log(`\n✅ API access successful!`);
    console.log(`   Found ${listings.results?.length || 0} listing(s)`);

    if (listings.results && listings.results.length > 0) {
      console.log('\n📋 Available Properties:');
      console.log('━'.repeat(50));
      listings.results.forEach((listing, index) => {
        console.log(`\n   ${index + 1}. ${listing.title || listing.nickname || 'Unnamed'}`);
        console.log(`      ID: ${listing._id}`);
        console.log(`      Address: ${listing.address?.full || 'N/A'}`);
        console.log(`      Accommodates: ${listing.accommodates || 'N/A'} guests`);
        console.log(`      Active: ${listing.active ? '✓' : '✗'}`);
      });

      console.log('\n💡 Copy one of the property IDs above to your .env file:');
      console.log(`   GUESTY_PROPERTY_ID=${listings.results[0]._id}`);
    }

    console.log('\n━'.repeat(50));
    console.log('\n✅ All tests passed! Authentication is working correctly.\n');

  } catch (error) {
    console.error('\n❌ Test failed with error:');
    console.error(error);
    process.exit(1);
  }
}

testAuthentication();