/**
 * Test timezone handling for weekly email schedule
 */

import { config } from '../config/index.js';
import { toZonedTime } from 'date-fns-tz';
import { getHours, getDay, format } from 'date-fns';

console.log('Testing Timezone Conversion');
console.log('===========================\n');

const now = new Date();
const propertyTime = toZonedTime(now, config.propertyTimezone);

console.log('Current Server Time (UTC):');
console.log(`  ${now.toISOString()}`);
console.log(`  Day: ${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][now.getDay()]}`);
console.log(`  Hour: ${now.getHours()}:00\n`);

console.log(`Property Time (${config.propertyTimezone}):`);
console.log(`  ${format(propertyTime, 'yyyy-MM-dd HH:mm:ss')}`);
console.log(`  Day: ${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][getDay(propertyTime)]}`);
console.log(`  Hour: ${getHours(propertyTime)}:00\n`);

console.log('Weekly Email Schedule:');
console.log(`  Target Day: ${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][config.weeklyReportDay]}`);
console.log(`  Target Hour: ${config.weeklyReportHour}:00 ${config.propertyTimezone}\n`);

const matches = getDay(propertyTime) === config.weeklyReportDay && getHours(propertyTime) === config.weeklyReportHour;
console.log(`Would send email now? ${matches ? '✅ YES' : '❌ NO'}`);
