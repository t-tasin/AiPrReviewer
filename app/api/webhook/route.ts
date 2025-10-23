import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import axios from 'axios';
import { PrismaClient } from '@prisma/client';
import { getReviewQueue, isRedisConfigured, closeQueue } from '@/lib/queue';

const prisma = new PrismaClient();

// Verify GitHub webhook signature
function verifyGitHubSignature(req: NextRequest, body: string): boolean {
  const signature = req.headers.get('x-hub-signature-256');
  const secret = process.env.GITHUB_WEBHOOK_SECRET;

  if (!signature) {
    console.error('[WEBHOOK] Missing x-hub-signature-256 header');
    return false;
  }

  if (!secret) {
    console.error('[WEBHOOK] Missing GITHUB_WEBHOOK_SECRET environment variable');
    return false;
  }

  const hash = crypto
    .createHmac('sha256', secret)
    .update(body)
    .digest('hex');
  const expectedSignature = `sha256=${hash}`;

  const isValid = crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature)
  );

  if (!isValid) {
    console.error('[WEBHOOK] Signature verification failed');
  } else {
    console.log('[WEBHOOK] Signature verification successful');
  }

  return isValid;
}

export async function POST(request: NextRequest) {
  const startTime = Date.now();

  try {
    // Read raw body for signature verification
    const body = await request.text();

    // Verify GitHub signature
    if (!verifyGitHubSignature(request, body)) {
      return NextResponse.json(
        { error: 'Invalid signature' },
        { status: 401 }
      );
    }

    const payload = JSON.parse(body);
    const eventType = request.headers.get('x-github-event');

    console.log('[WEBHOOK] Event received:', eventType);

    // ============================================
    // INSTALLATION EVENTS (Fast, synchronous)
    // ============================================
    if (eventType === 'installation') {
      const { action, installation, repositories } = payload;

      console.log('[WEBHOOK] Installation event:', action);
      console.log('[WEBHOOK] Installation ID:', installation.id);

      if ((action === 'created' || action === 'added') && repositories) {
        console.log(`[WEBHOOK] Processing ${repositories.length} repositories for installation`);

        for (const repo of repositories) {
          try {
            const updated = await prisma.repository.updateMany({
              where: { githubRepoId: repo.id },
              data: {
                installationId: installation.id,
              },
            });

            if (updated.count > 0) {
              console.log(`[WEBHOOK] Updated repository ${repo.full_name} with installation ID ${installation.id}`);
            } else {
              console.log(`[WEBHOOK] Repository ${repo.full_name} not found in database`);
            }
          } catch (error) {
            console.error(`[WEBHOOK] Failed to update repository ${repo.full_name}:`, error);
          }
        }

        console.log('[WEBHOOK] Installation processed successfully');
        return NextResponse.json({ status: 'installation_processed' }, { status: 200 });
      }

      console.log('[WEBHOOK] Installation event ignored');
      return NextResponse.json({ status: 'installation_ignored' }, { status: 202 });
    }

    // ============================================
    // PULL REQUEST EVENTS (Fast, async via queue)
    // ============================================
    if (eventType !== 'pull_request') {
      return NextResponse.json({ status: 'ignored' }, { status: 202 });
    }

    const { action, pull_request, repository } = payload;

    console.log('[WEBHOOK] PR Event:', action);
    console.log('[WEBHOOK] Repository ID:', repository?.id);
    console.log('[WEBHOOK] PR title:', pull_request?.title);

    // Only process opened or synchronized events
    if (action !== 'opened' && action !== 'synchronize') {
      console.log(`[WEBHOOK] Ignoring PR action: ${action}`);
      return NextResponse.json({ status: 'ignored' }, { status: 202 });
    }

    // Check if repository exists
    const githubRepoId = repository.id;
    const dbRepository = await prisma.repository.findUnique({
      where: { githubRepoId },
      include: { configuration: true },
    });

    if (!dbRepository) {
      console.error(`[WEBHOOK] Repository ${githubRepoId} not found in database`);
      return NextResponse.json(
        { status: 'repository_not_found' },
        { status: 404 }
      );
    }

    // Check if reviewer is enabled
    if (dbRepository.configuration && !dbRepository.configuration.enabled) {
      console.log(`[WEBHOOK] Reviewer disabled for repository ${dbRepository.name}`);
      return NextResponse.json(
        { status: 'reviewer_disabled' },
        { status: 202 }
      );
    }

    // ============================================
    // QUEUE THE REVIEW JOB (Fast, return immediately)
    // ============================================
    if (!isRedisConfigured()) {
      console.error('[WEBHOOK] Redis not configured - set REDIS_URL environment variable');
      return NextResponse.json(
        {
          error: 'Async processing not configured',
          message: 'Set REDIS_URL environment variable to enable PR review queuing',
          status: 'redis_not_configured',
        },
        { status: 503 }
      );
    }

    let queue = null;
    try {
      queue = getReviewQueue();

      const jobData = {
        body: body,
        signature: request.headers.get('x-hub-signature-256') || '',
        timestamp: startTime,
      };

      const jobId = `pr-${repository.id}-${pull_request.number}-${startTime}`;
      const job = await queue.add('review-pr', jobData, {
        jobId,
        priority: 10,
      });

      console.log(`[WEBHOOK] Job queued:`, job.id);

      // Verify job was stored in Redis
      const jobCheck = await queue.getJob(jobId);
      console.log(`[WEBHOOK] Job verification: ${jobCheck ? 'FOUND' : 'NOT FOUND'} in queue`);

      // Trigger GitHub Actions workflow to process queue immediately (fire and forget, but logged)
      const dispatchWorkflow = async () => {
        try {
          const token = process.env.GITHUB_TOKEN;
          if (!token) {
            console.error('[WEBHOOK] GITHUB_TOKEN not set, cannot dispatch workflow');
            return;
          }

          console.log('[WEBHOOK] Attempting to dispatch workflow...');

          const response = await axios.post(
            'https://api.github.com/repos/t-tasin/AiPrReviewer/dispatches',
            { event_type: 'process-review-queue' },
            {
              headers: {
                Authorization: `token ${token}`,
                Accept: 'application/vnd.github.v3+json',
              },
              timeout: 5000,
            }
          );

          console.log('[WEBHOOK] GitHub Actions workflow dispatched successfully (status: ' + response.status + ')');
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          console.error('[WEBHOOK] Failed to dispatch workflow:', errorMsg);
          if (axios.isAxiosError(error)) {
            console.error('[WEBHOOK] Response status:', error.response?.status);
            console.error('[WEBHOOK] Response data:', error.response?.data);
          }
        }
      };

      // Fire workflow dispatch without blocking webhook response
      dispatchWorkflow().catch((err) => console.error('[WEBHOOK] Workflow dispatch error:', err));

      console.log(`[WEBHOOK] Webhook response time: ${Date.now() - startTime}ms`);

      return NextResponse.json(
        { status: 'queued', jobId: job.id },
        { status: 202 }
      );
    } catch (queueError) {
      const errorMsg = queueError instanceof Error ? queueError.message : String(queueError);
      console.error('[WEBHOOK] Failed to queue job:', errorMsg);
      return NextResponse.json(
        {
          error: 'Failed to queue review job',
          message: errorMsg,
        },
        { status: 500 }
      );
    } finally {
      if (queue) {
        await closeQueue(queue);
      }
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error('[WEBHOOK] Fatal error:', errorMsg);

    return NextResponse.json(
      { error: errorMsg },
      { status: 500 }
    );
  }
}
