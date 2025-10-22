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

// Parse REDIS_URL if provided (Upstash format: redis://default:password@host:port)
function getRedisConnection(): any {
  const redisUrl = process.env.REDIS_URL;

  if (!redisUrl) {
    throw new Error('REDIS_URL environment variable not configured');
  }

  // Use Upstash Redis URL directly
  return redisUrl;
}

// Create or get the review queue (lazy initialization)
let reviewQueue: Queue<ReviewPRJob> | null = null;
let queueEvents: QueueEvents | null = null;
let initializationError: Error | null = null;

export function getReviewQueue(): Queue<ReviewPRJob> {
  if (initializationError) {
    throw initializationError;
  }

  if (!reviewQueue) {
    try {
      const redisConnection = getRedisConnection();

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

      // Set up queue event handlers (quietly)
      queueEvents = new QueueEvents('pr-reviews', { connection: redisConnection });

      queueEvents.on('completed', ({ jobId }) => {
        console.log(`[QUEUE] Job ${jobId} completed`);
      });

      queueEvents.on('failed', ({ jobId, failedReason }) => {
        console.error(`[QUEUE] Job ${jobId} failed: ${failedReason}`);
      });

      // Don't log connection errors - we expect them if Redis isn't configured
      // queueEvents.on('error', (error) => { ... });
    } catch (error) {
      initializationError = error instanceof Error ? error : new Error(String(error));
      throw initializationError;
    }
  }

  return reviewQueue;
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
