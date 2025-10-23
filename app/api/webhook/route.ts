import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { prisma } from '@/lib/prisma';
import { reviewPullRequest } from '@/lib/pr-reviewer';

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
    // PROCESS PR REVIEW (Synchronous)
    // ============================================
    try {
      console.log('[WEBHOOK] Starting PR review...');

      // Process the review
      const metrics = await reviewPullRequest(payload);

      // Log metrics to database
      await prisma.reviewMetric.create({
        data: {
          repositoryId: dbRepository.id,
          prNumber: pull_request.number,
          startTime: new Date(startTime),
          endTime: new Date(),
          latencyMs: metrics.latencyMs,
          success: metrics.success,
          errorMessage: metrics.errorMessage,
          lineCommentCount: metrics.lineCommentCount,
          geminiCallDurationMs: metrics.geminiCallDurationMs,
          githubApiDurationMs: metrics.githubApiDurationMs,
          filesTotalCount: metrics.filesTotalCount || 0,
          fileCachedCount: metrics.fileCachedCount || 0,
          cacheHit: (metrics.fileCachedCount || 0) > 0,
        },
      });

      console.log('[WEBHOOK] Metrics logged:', {
        prNumber: pull_request.number,
        latencyMs: metrics.latencyMs,
        success: metrics.success,
        cacheHit: (metrics.fileCachedCount || 0) > 0,
        fileCachedCount: metrics.fileCachedCount,
      });

      const totalTime = Date.now() - startTime;
      console.log(`[WEBHOOK] Webhook completed in ${totalTime}ms`);

      return NextResponse.json(
        {
          status: 'completed',
          success: metrics.success,
          latencyMs: metrics.latencyMs,
          cacheHit: (metrics.fileCachedCount || 0) > 0,
        },
        { status: 200 }
      );
    } catch (reviewError) {
      const errorMsg = reviewError instanceof Error ? reviewError.message : String(reviewError);
      console.error('[WEBHOOK] PR review failed:', errorMsg);

      return NextResponse.json(
        {
          error: 'PR review failed',
          message: errorMsg,
        },
        { status: 500 }
      );
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
