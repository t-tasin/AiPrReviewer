import { Queue, QueueEvents } from 'bullmq';

// Job type for PR review processing
export interface ReviewPRJob {
  body: string; // Raw webhook payload
  signature: string; // GitHub webhook signature
  timestamp: number; // When job was created
}

// Check if Redis is configured
export function isRedisConfigured(): boolean {
  return !!process.env.REDIS_URL;
}

// Parse REDIS_URL (Upstash format: redis://default:password@host:port or rediss://default:password@host:port for TLS)
function getRedisConnection(): any {
  const redisUrl = process.env.REDIS_URL;

  if (!redisUrl) {
    throw new Error('REDIS_URL environment variable not configured');
  }

  console.log('[QUEUE] Parsing REDIS_URL...');

  // Parse the Upstash Redis URL
  // Format: redis://default:password@host:port (plain)
  // Format: rediss://default:password@host:port (TLS)
  try {
    const url = new URL(redisUrl);
    const protocol = url.protocol; // "redis:" or "rediss:"
    const host = url.hostname;
    let port = parseInt(url.port || '6379', 10);
    const password = url.password;

    if (!host) {
      throw new Error('Invalid Redis URL: missing hostname');
    }

    // Detect TLS requirement
    const useTls = protocol === 'rediss:';
    if (useTls && !url.port) {
      port = 6380; // Upstash uses 6380 for TLS
    }

    console.log(`[QUEUE] Redis connection: ${host}:${port} (TLS: ${useTls})`);

    const connection: any = {
      host,
      port,
      password,
      maxRetriesPerRequest: null, // Required for BullMQ
      enableReadyCheck: false,    // Required for BullMQ
      lazyConnect: true,          // Prevent immediate connection
    };

    // Enable TLS for rediss:// URLs
    if (useTls) {
      connection.tls = {}; // Empty object enables TLS with default options
      console.log('[QUEUE] TLS enabled for Redis connection');
    }

    return connection;
  } catch (error) {
    console.error('[QUEUE] Failed to parse REDIS_URL:', error);
    throw new Error(`Invalid REDIS_URL format: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Create a new review queue instance
// In serverless, we create fresh instances each time to avoid state issues
export function getReviewQueue(): Queue<ReviewPRJob> {
  try {
    const redisConnection = getRedisConnection();

    console.log('[QUEUE] Creating new queue instance...');

    const queue = new Queue<ReviewPRJob>('pr-reviews', {
      connection: redisConnection,
      defaultJobOptions: {
        attempts: 3, // Retry up to 3 times
        backoff: {
          type: 'exponential',
          delay: 2000, // Start with 2s, exponentially increase
        },
        removeOnComplete: {
          age: 3600, // Remove completed jobs after 1 hour
        },
        removeOnFail: {
          age: 86400, // Keep failed jobs for 24 hours for debugging
        },
      },
    });

    console.log('[QUEUE] Queue instance created successfully');

    // Set up queue event handlers
    const queueEvents = new QueueEvents('pr-reviews', { connection: redisConnection });

    queueEvents.on('completed', ({ jobId }) => {
      console.log(`[QUEUE] Job ${jobId} completed`);
    });

    queueEvents.on('failed', ({ jobId, failedReason }) => {
      console.error(`[QUEUE] Job ${jobId} failed: ${failedReason}`);
    });

    return queue;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[QUEUE] Failed to create queue:', msg);
    throw error;
  }
}

// Helper to get queue stats
export async function getQueueStats() {
  try {
    const queue = getReviewQueue();
    const counts = await queue.getJobCounts();
    return {
      waiting: counts.waiting || 0,
      active: counts.active || 0,
      completed: counts.completed || 0,
      failed: counts.failed || 0,
      delayed: counts.delayed || 0,
    };
  } catch (error) {
    console.error('[QUEUE] Failed to get queue stats:', error);
    return {
      waiting: 0,
      active: 0,
      completed: 0,
      failed: 0,
      delayed: 0,
    };
  }
}

// Close a queue instance (call after use in serverless functions)
export async function closeQueue(queue: Queue<ReviewPRJob>) {
  try {
    await queue.close();
    console.log('[QUEUE] Queue instance closed');
  } catch (error) {
    console.error('[QUEUE] Error closing queue:', error);
  }
}
