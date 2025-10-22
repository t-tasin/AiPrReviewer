import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import axios from 'axios';
import { PrismaClient } from '@prisma/client';

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
    console.error('[WEBHOOK] Received signature:', signature.substring(0, 20) + '...');
    console.error('[WEBHOOK] Expected signature:', expectedSignature.substring(0, 20) + '...');
  } else {
    console.log('[WEBHOOK] Signature verification successful');
  }

  return isValid;
}

// Get GitHub App installation token
async function getInstallationToken(installationId: number): Promise<string> {
  try {
    const privateKey = process.env.GITHUB_APP_PRIVATE_KEY?.replace(
      /\\n/g,
      '\n'
    );
    const appId = process.env.NEXT_PUBLIC_GITHUB_APP_ID;

    if (!privateKey || !appId) {
      throw new Error('Missing GitHub App credentials');
    }

    // In a real implementation, you'd use jwt library here
    // For now, we'll use the existing GITHUB_TOKEN from .env
    // This is a simplification - in production, generate JWT and exchange for token
    const token = process.env.GITHUB_TOKEN;

    if (!token) {
      throw new Error('GitHub token not configured');
    }

    return token;
  } catch (error) {
    console.error('Error getting installation token:', error);
    throw error;
  }
}

// Get AI review from Gemini
async function getAiReview(
  diff: string,
  customPrompt?: string | null
): Promise<string> {
  const prompt = customPrompt
    ? `${customPrompt}\n\nHere is the diff to review:\n\`\`\`diff\n${diff}\n\`\`\``
    : `You are a senior software engineer providing a code review.
Review the following code diff and provide constructive feedback.
Focus on potential bugs, code clarity, and adherence to best practices.
Format your response in Markdown.

Here is the diff:
\`\`\`diff
${diff}
\`\`\``;

  const modelName = 'gemini-2.5-flash';
  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${process.env.GEMINI_API_KEY}`;

  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
  };

  const response = await axios.post(geminiUrl, payload, {
    headers: { 'Content-Type': 'application/json' },
  });

  if (
    response.data &&
    response.data.candidates &&
    response.data.candidates[0]?.content
  ) {
    const reviewText = response.data.candidates[0].content.parts[0].text;
    return `### 🤖 AI Code Review\n\n${reviewText}`;
  }

  throw new Error('Invalid response structure from Gemini');
}

// Post comment to GitHub PR
async function postCommentToPR(
  commentsUrl: string,
  commentBody: string,
  token: string
): Promise<void> {
  await axios.post(
    commentsUrl,
    { body: commentBody },
    {
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.v3+json',
      },
    }
  );
}

export async function POST(request: NextRequest) {
  const startTime = Date.now();
  let success = false;
  let errorMessage = '';
  let repoId: number | null = null;
  let prNumber: number | null = null;

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

    // Check event type
    const eventType = request.headers.get('x-github-event');

    // Handle installation event - save repositories to database
    if (eventType === 'installation') {
      const { action, installation, repositories } = payload;

      if (action === 'created' && repositories) {
        console.log(`GitHub App installed on ${repositories.length} repositories`);

        for (const repo of repositories) {
          // Check if repository already exists
          const existingRepo = await prisma.repository.findUnique({
            where: { githubRepoId: repo.id },
          });

          if (!existingRepo) {
            // Create new repository record
            await prisma.repository.create({
              data: {
                githubRepoId: repo.id,
                installationId: installation.id,
                name: repo.name,
                fullName: repo.full_name,
                owner: repo.owner.login,
                userId: '', // Will be set by the user through the app
              },
            });
            console.log(`Created repository record: ${repo.full_name}`);
          }
        }

        success = true;
        return NextResponse.json({ status: 'installation_processed' }, { status: 200 });
      }

      return NextResponse.json({ status: 'installation_ignored' }, { status: 202 });
    }

    if (eventType !== 'pull_request') {
      return NextResponse.json({ status: 'ignored' }, { status: 202 });
    }

    const { action, pull_request, repository } = payload;

    // Only process opened or synchronized events
    if (action !== 'opened' && action !== 'synchronize') {
      return NextResponse.json({ status: 'ignored' }, { status: 202 });
    }

    prNumber = pull_request.number;
    const githubRepoId = repository.id;

    console.log(
      `Processing PR #${pull_request.number}: ${pull_request.title}`
    );

    // Find repository in database
    const dbRepository = await prisma.repository.findUnique({
      where: { githubRepoId: githubRepoId },
      include: { configuration: true },
    });

    if (!dbRepository) {
      console.warn(`Repository ${githubRepoId} not found in database`);
      return NextResponse.json(
        { status: 'repository_not_found' },
        { status: 404 }
      );
    }

    repoId = dbRepository.id;

    // Check if reviewer is enabled for this repo
    if (dbRepository.configuration && !dbRepository.configuration.enabled) {
      console.log(`Reviewer disabled for repository ${dbRepository.name}`);
      return NextResponse.json(
        { status: 'reviewer_disabled' },
        { status: 202 }
      );
    }

    // Get PR diff
    const diffResponse = await axios.get(pull_request.diff_url, {
      headers: { Accept: 'application/vnd.github.v3.diff' },
    });
    const diff = diffResponse.data;

    if (!diff || diff.length === 0) {
      console.log('No diff content found');
      return NextResponse.json({ status: 'no_diff' }, { status: 200 });
    }

    // Get AI review with custom prompt if available
    const review = await getAiReview(diff, dbRepository.configuration?.customPrompt);

    // Get token and post comment
    const token = await getInstallationToken(dbRepository.installationId);
    await postCommentToPR(pull_request.comments_url, review, token);

    success = true;
    console.log('Successfully posted review comment');

    return NextResponse.json({ status: 'success' }, { status: 200 });
  } catch (error) {
    errorMessage =
      error instanceof Error
        ? error.message
        : 'Unknown error occurred';
    console.error('Webhook error:', errorMessage);

    return NextResponse.json(
      { error: errorMessage },
      { status: 500 }
    );
  } finally {
    // Log metrics
    const endTime = Date.now();
    const latencyMs = endTime - startTime;

    if (repoId) {
      try {
        await prisma.reviewMetric.create({
          data: {
            repositoryId: repoId,
            prNumber,
            startTime: new Date(startTime),
            endTime: new Date(endTime),
            latencyMs,
            success,
            errorMessage: errorMessage || null,
          },
        });
      } catch (logError) {
        console.error('Failed to log metric:', logError);
      }
    }
  }
}
