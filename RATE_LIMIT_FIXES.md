# Rate Limiting Fixes - Summary

## Problem

The application was experiencing frequent `HTTP 429 Too Many Requests` errors from the Guesty API due to:

1. **No retry logic** for 429 responses
2. **No rate limit monitoring** or throttling
3. **Aggressive sync schedule** (30-minute intervals)
4. **Sequential API calls** without delays
5. **No request queuing** to respect Guesty's limits

## Guesty API Rate Limits

- **15 requests/second**
- **120 requests/minute**
- **5,000 requests/hour**
- **Max 15 concurrent requests** (exceeding triggers instant rate limiting)

## Implemented Fixes

### 1. Automatic Retry with Exponential Backoff
**File:** `src/services/guesty-client.ts`

- Retries 429 responses up to 3 times
- Respects `Retry-After` header when present
- Falls back to exponential backoff (1s, 2s, 4s...)
- Adds ±20% jitter to prevent thundering herd
- Also retries network errors with backoff

### 2. Rate Limit Header Monitoring
**File:** `src/services/guesty-client.ts`

- Tracks `X-ratelimit-remaining-*` headers
- Logs warnings when < 20% capacity remains
- Exposes `getRateLimitInfo()` method for monitoring
- Helps detect approaching limits before 429 errors

### 3. Request Queue with Throttling
**File:** `src/services/guesty-client.ts`

- Installed `bottleneck` package for request queuing
- Enforces conservative limits:
  - 10 requests/second (buffer below 15 limit)
  - 10 concurrent requests max (buffer below 15 limit)
  - Minimum 100ms between requests
- Automatically queues requests when limits reached
- Logs queue events (depletion, failures)

### 4. Delayed Chunked Sync
**File:** `src/jobs/sync-availability.ts`

- Added 1-second delays between calendar chunks
- Prevents bursts of 4+ sequential API calls
- Logs progress with chunk index/total
- Continues on partial failures

### 5. Increased Scheduler Interval
**Files:** `src/config/index.ts`, `.env.example`

- Changed default `CACHE_AVAILABILITY_TTL` from 30 to 60 minutes
- Reduces ETL job frequency from 48 to 24 runs/day
- Updated documentation with rate limit context
- Scheduler still adds ±5% jitter for load distribution

## Configuration

### Environment Variables

```bash
# Recommended: 60-120 minutes to avoid rate limits
CACHE_AVAILABILITY_TTL=60
```

This setting controls:
- How often the ETL job runs
- When cached availability data expires

### Tuning Options

If you still experience 429 errors:

1. **Increase sync interval**: Set `CACHE_AVAILABILITY_TTL=120` (2 hours)
2. **Reduce request rate**: Modify Bottleneck config in `guesty-client.ts`:
   ```typescript
   reservoir: 8,  // Lower from 10
   minTime: 150,  // Higher from 100ms
   ```
3. **Use chunked sync**: The chunked sync method is available but not currently used by default

## Monitoring

### Check Rate Limit Status

The application now logs:
- Rate limit warnings when approaching capacity
- 429 retry attempts with delay information
- Queue depletion events
- Current rate limit info in headers

### Log Examples

```
WARN: Approaching rate limit threshold (remaining: 2/15, interval: second)
WARN: Rate limited (429), retrying after delay (attempt: 1/4, delayMs: 2341)
DEBUG: Rate limiter reservoir depleted, requests will be queued
```

## Testing

To verify fixes are working:

1. **Check logs** for 429 errors and retry messages
2. **Monitor API calls** in logs (look for `Guesty API call` entries)
3. **Verify scheduler interval**: Check `Next scheduled run` log messages
4. **Test under load**: Use admin endpoints to trigger manual syncs

## Files Modified

- `src/services/guesty-client.ts` - Added retry, monitoring, and queuing
- `src/jobs/sync-availability.ts` - Added delays between chunks
- `src/config/index.ts` - Increased default TTL from 30 to 60 minutes
- `.env.example` - Updated documentation and default value
- `docs/GUESTY_API_ANALYSIS.md` - Added rate limiting section
- `package.json` - Added `bottleneck` dependency

## Benefits

1. **Automatic recovery** from rate limit errors
2. **Proactive prevention** via request queuing
3. **Better observability** with header monitoring
4. **Reduced API load** with longer cache intervals
5. **Graceful degradation** under high load

## Trade-offs

- **Less frequent updates**: 60-minute cache means availability data can be up to 1 hour stale
- **Slower bulk operations**: Request queue adds delays during high-volume syncs
- **Memory overhead**: Bottleneck maintains request queue in memory

These trade-offs are necessary to stay within Guesty's rate limits and ensure stable operation.

## Recommendations

1. **Start with 60-minute interval** and monitor for 429 errors
2. **Increase to 120 minutes** if still hitting rate limits
3. **Enable Guesty webhooks** for real-time updates (reduces need for frequent polling)
4. **Consider using chunked sync** for very large date ranges
5. **Monitor rate limit headers** to understand your actual usage patterns

## Additional Resources

- [Guesty Rate Limits Documentation](https://open-api-docs.guesty.com/docs/rate-limits)
- [Bottleneck Documentation](https://github.com/SGrondin/bottleneck)
- Internal: `docs/GUESTY_API_ANALYSIS.md` (Rate Limiting section)
