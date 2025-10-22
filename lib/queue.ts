import { Queue, QueueEvents } from 'bullmq';

// Job type for PR review processing
export interface ReviewPRJob {
  body: string; // Raw webhook payload
  signature: string; // GitHub webhook signature
  timestamp: number; // When job was created
}

// Parse REDIS_URL if provided (Upstash format: redis://default:password@host:port)
function getRedisConnection(): any {
  const redisUrl = process.env.REDIS_URL;

  if (redisUrl) {
    // Use Upstash Redis URL directly
    return redisUrl;
  }

  // Fallback to individual environment variables
  const connection = {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379'),
    db: 0,
    maxRetriesPerRequest: null, // Required for BullMQ
    enableReadyCheck: false, // Required for BullMQ
  } as any;

  if (process.env.REDIS_PASSWORD) {
    connection.password = process.env.REDIS_PASSWORD;
  }

  return connection;
}

// Redis connection configuration
const redisConnection = getRedisConnection();

// Create or get the review queue
let reviewQueue: Queue<ReviewPRJob> | null = null;
let queueEvents: QueueEvents | null = null;

export function getReviewQueue(): Queue<ReviewPRJob> {
  if (!reviewQueue) {
    reviewQueue = new Queue<ReviewPRJob>('pr-reviews', {
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

    // Set up queue event handlers
    queueEvents = new QueueEvents('pr-reviews', { connection: redisConnection });

    queueEvents.on('completed', ({ jobId }) => {
      console.log(`[QUEUE] Job ${jobId} completed successfully`);
    });

    queueEvents.on('failed', ({ jobId, failedReason }) => {
      console.error(`[QUEUE] Job ${jobId} failed: ${failedReason}`);
    });

    queueEvents.on('error', (error) => {
      console.error('[QUEUE] Queue error:', error);
    });
  }

  return reviewQueue;
}

// Helper to check if Redis is configured
export function isRedisConfigured(): boolean {
  const redisUrl = process.env.REDIS_URL;
  if (redisUrl) {
    // If REDIS_URL is provided (Upstash), use it
    return true;
  }

  // Otherwise check individual connection params
  return !!(process.env.REDIS_HOST || process.env.REDIS_PASSWORD);
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

// Clean up queue resources
export async function closeQueue() {
  if (reviewQueue) {
    await reviewQueue.close();
    reviewQueue = null;
  }

  if (queueEvents) {
    await queueEvents.close();
    queueEvents = null;
  }
}
