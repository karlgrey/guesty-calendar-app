/**
 * Test script to check calendar API response format
 */

import 'dotenv/config';

const OAUTH_URL = process.env.GUESTY_OAUTH_URL;
const CLIENT_ID = process.env.GUESTY_CLIENT_ID;
const CLIENT_SECRET = process.env.GUESTY_CLIENT_SECRET;
const API_URL = process.env.GUESTY_API_URL;
const PROPERTY_ID = process.env.GUESTY_PROPERTY_ID;

async function testCalendarAPI() {
  console.log('\n📅 Testing Calendar API Response Format\n');

  // Get access token
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

  const tokenData = await tokenResponse.json();
  const accessToken = tokenData.access_token;

  // Test calendar endpoint
  const today = new Date().toISOString().split('T')[0];
  const nextWeek = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  const calendarUrl = `${API_URL}/availability-pricing/api/calendar/listings/${PROPERTY_ID}?startDate=${today}&endDate=${nextWeek}`;

  console.log(`Fetching: ${calendarUrl}\n`);

  const calendarResponse = await fetch(calendarUrl, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  });

  const calendarData = await calendarResponse.json();

  console.log('Response type:', typeof calendarData);
  console.log('Is array:', Array.isArray(calendarData));
  console.log('\nResponse structure:');
  console.log(JSON.stringify(calendarData, null, 2).substring(0, 1500));

  if (calendarData.data) {
    console.log('\n⚠️  Response has "data" wrapper - need to unwrap!');
    console.log('Data type:', typeof calendarData.data);
    console.log('Data is array:', Array.isArray(calendarData.data));
  }

  if (calendarData.days) {
    console.log('\n⚠️  Response has "days" wrapper - need to unwrap!');
    console.log('Days type:', typeof calendarData.days);
    console.log('Days is array:', Array.isArray(calendarData.days));
  }
}

testCalendarAPI().catch(console.error);