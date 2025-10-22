/**
 * Core PR review logic extracted for reuse between webhook and worker
 * This module contains all the business logic for reviewing a PR
 */

import axios from 'axios';
import { PrismaClient } from '@prisma/client';
import parseDiff from 'parse-diff';
import { getCachedReview, cacheReview, hashFileContent } from './cache';

const prisma = new PrismaClient();

export interface LineComment {
  file: string;
  line: number;
  comment: string;
}

export interface ReviewMetrics {
  latencyMs: number;
  geminiCallDurationMs: number;
  githubApiDurationMs: number;
  lineCommentCount: number;
  success: boolean;
  errorMessage: string | null;
  filesTotalCount?: number;
  fileCachedCount?: number;
}

interface DiffFile {
  path: string;
  contentHash: string;
  fullDiff: string;
  lines: string[];
}

/**
 * Parse diff into file-level diffs and compute content hashes
 * Returns array of files with their diffs and content hashes
 */
function parseAndHashDiff(fullDiff: string): DiffFile[] {
  const files: DiffFile[] = [];
  const lines = fullDiff.split('\n');

  let currentFile: { path: string; lines: string[] } | null = null;
  const fileMap: { [path: string]: string[] } = {};

  for (const line of lines) {
    // Detect file header (e.g., "--- a/path/to/file" or "diff --git a/path b/path")
    if (line.startsWith('diff --git a/') || line.startsWith('--- a/')) {
      if (currentFile && currentFile.lines.length > 0) {
        fileMap[currentFile.path] = currentFile.lines;
      }

      // Extract file path from diff header
      let path = '';
      if (line.startsWith('diff --git a/')) {
        const match = line.match(/diff --git a\/(.+) b\/(.+)$/);
        path = match ? match[1] : line;
      } else if (line.startsWith('--- a/')) {
        path = line.substring(6); // Remove "--- a/"
      }

      currentFile = { path: path.trim(), lines: [] };
    }

    if (currentFile) {
      currentFile.lines.push(line);
    }
  }

  // Don't forget the last file
  if (currentFile && currentFile.lines.length > 0) {
    fileMap[currentFile.path] = currentFile.lines;
  }

  // Create DiffFile objects with hashes
  for (const [path, fileLines] of Object.entries(fileMap)) {
    const fullDiff = fileLines.join('\n');
    const contentHash = hashFileContent(fullDiff);
    files.push({
      path,
      contentHash,
      fullDiff,
      lines: fileLines,
    });
  }

  return files;
}

/**
 * Get AI review as JSON (line-specific comments)
 */
async function getAiReviewAsJson(
  diff: string,
  customPrompt?: string | null
): Promise<LineComment[]> {
  const prompt = customPrompt
    ? `${customPrompt}\n\nReview this diff and respond with ONLY a valid JSON array.
Format: [{"file": "path/to/file", "line": LINE_NUMBER, "comment": "specific feedback for this line"}]
Focus on actionable feedback. Include only lines that need improvement.

Diff:
\`\`\`diff
${diff}
\`\`\``
    : `You are a senior software engineer providing line-by-line code review.
Review the diff and respond with ONLY a valid JSON array.
Format: [{"file": "path/to/file", "line": LINE_NUMBER, "comment": "specific feedback"}]
Focus on: potential bugs, code clarity, best practices, security issues.
Include only lines that need improvement. Empty array if no issues.

Diff:
\`\`\`diff
${diff}
\`\`\``;

  const modelName = 'gemini-2.5-flash';
  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${process.env.GEMINI_API_KEY}`;

  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
  };

  const maxRetries = 3;
  let lastError;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await axios.post(geminiUrl, payload, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 30000,
      });

      if (
        response.data &&
        response.data.candidates &&
        response.data.candidates[0]?.content
      ) {
        const responseText = response.data.candidates[0].content.parts[0].text;

        const jsonMatch = responseText.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          if (Array.isArray(parsed)) {
            return parsed;
          }
        }

        console.log('[REVIEWER] Failed to parse JSON from Gemini, falling back to text');
        return [];
      }

      throw new Error('Invalid response structure from Gemini');
    } catch (error) {
      lastError = error;
      const isAxiosError = axios.isAxiosError(error);
      const status = isAxiosError ? error.response?.status : null;
      const isRetryable =
        !isAxiosError ||
        (status && (status === 429 || status === 503 || status >= 500));

      if (!isRetryable || attempt === maxRetries - 1) {
        throw error;
      }

      const delayMs = Math.pow(2, attempt) * 1000;
      console.log(
        `[REVIEWER] Gemini API error (attempt ${attempt + 1}/${maxRetries}), retrying in ${delayMs}ms...`
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError || new Error('Failed to get AI review after retries');
}

/**
 * Get single comment review (fallback)
 */
async function getAiReviewAsText(
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

  const maxRetries = 3;
  let lastError;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await axios.post(geminiUrl, payload, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 30000,
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
    } catch (error) {
      lastError = error;
      const isAxiosError = axios.isAxiosError(error);
      const status = isAxiosError ? error.response?.status : null;
      const isRetryable =
        !isAxiosError ||
        (status && (status === 429 || status === 503 || status >= 500));

      if (!isRetryable || attempt === maxRetries - 1) {
        throw error;
      }

      const delayMs = Math.pow(2, attempt) * 1000;
      console.log(
        `[REVIEWER] Gemini API error (attempt ${attempt + 1}/${maxRetries}), retrying in ${delayMs}ms...`
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError || new Error('Failed to get AI review after retries');
}

/**
 * Get installation token for GitHub API
 */
async function getInstallationToken(): Promise<string> {
  const token = process.env.GITHUB_TOKEN;

  if (!token) {
    throw new Error('GitHub token not configured');
  }

  return token;
}

/**
 * Post line-specific comments to GitHub PR
 */
async function postLineCommentsToPR(
  commentsUrl: string,
  lineComments: LineComment[],
  token: string
): Promise<number> {
  let successCount = 0;

  for (const lineComment of lineComments) {
    try {
      const commentBody = `**${lineComment.file}** (line ${lineComment.line})\n\n${lineComment.comment}`;

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

      successCount++;
      console.log(`[REVIEWER] Posted line comment for ${lineComment.file}:${lineComment.line}`);
    } catch (error) {
      console.error(`[REVIEWER] Failed to post line comment for ${lineComment.file}:${lineComment.line}:`, error);
    }
  }

  return successCount;
}

/**
 * Post single comment to GitHub PR
 */
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

/**
 * Core review logic - processes a PR webhook event
 */
export async function reviewPullRequest(payload: any): Promise<ReviewMetrics> {
  const startTime = Date.now();
  let geminiCallDurationMs = 0;
  let githubApiDurationMs = 0;
  let lineCommentCount = 0;
  let success = false;
  let errorMessage: string | null = null;

  try {
    const { action, pull_request, repository, installation } = payload;

    console.log('[REVIEWER] Processing PR #' + pull_request.number);

    // Only process opened or synchronized events
    if (action !== 'opened' && action !== 'synchronize') {
      console.log(`[REVIEWER] Ignoring action: ${action}`);
      return {
        latencyMs: Date.now() - startTime,
        geminiCallDurationMs: 0,
        githubApiDurationMs: 0,
        lineCommentCount: 0,
        success: true,
        errorMessage: null,
      };
    }

    const githubRepoId = repository.id;

    // Find repository in database
    const dbRepository = await prisma.repository.findUnique({
      where: { githubRepoId },
      include: { configuration: true },
    });

    if (!dbRepository) {
      throw new Error(`Repository ${githubRepoId} not found in database`);
    }

    // Check if reviewer is enabled
    if (dbRepository.configuration && !dbRepository.configuration.enabled) {
      console.log(`[REVIEWER] Reviewer disabled for repository ${dbRepository.name}`);
      return {
        latencyMs: Date.now() - startTime,
        geminiCallDurationMs: 0,
        githubApiDurationMs: 0,
        lineCommentCount: 0,
        success: true,
        errorMessage: null,
      };
    }

    // Fetch PR diff
    console.log('[REVIEWER] Fetching PR diff...');
    const diffResponse = await axios.get(pull_request.diff_url, {
      headers: { Accept: 'application/vnd.github.v3.diff' },
    });

    const diff = diffResponse.data;
    if (!diff || diff.length === 0) {
      console.log('[REVIEWER] No diff content found');
      return {
        latencyMs: Date.now() - startTime,
        geminiCallDurationMs: 0,
        githubApiDurationMs: 0,
        lineCommentCount: 0,
        success: true,
        errorMessage: null,
        filesTotalCount: 0,
        fileCachedCount: 0,
      };
    }

    // Parse diff into file-level diffs for caching
    console.log('[REVIEWER] Parsing diff and computing file hashes...');
    const diffFiles = parseAndHashDiff(diff);
    const filesTotalCount = diffFiles.length;
    let fileCachedCount = 0;
    let cachedLineComments: LineComment[] = [];
    let filesToReview: DiffFile[] = [];

    // Check cache for each file
    for (const file of diffFiles) {
      const cached = await getCachedReview(dbRepository.id, file.path, file.contentHash);
      if (cached) {
        fileCachedCount++;
        // Parse cached review (it's a JSON string with line comments)
        try {
          const parsed = JSON.parse(cached);
          if (Array.isArray(parsed)) {
            cachedLineComments.push(...parsed);
          }
        } catch {
          // If cached review isn't JSON, skip it (shouldn't happen)
        }
      } else {
        filesToReview.push(file);
      }
    }

    console.log(`[REVIEWER] Cache status: ${fileCachedCount}/${filesTotalCount} files cached`);

    // Get AI review
    console.log('[REVIEWER] Calling Gemini API for review...');
    let lineComments: LineComment[] = [...cachedLineComments];
    let fallbackReview: string | null = null;

    // Only call Gemini if there are files to review
    if (filesToReview.length > 0) {
      const diffToReview = filesToReview.map((f) => f.fullDiff).join('\n');

      try {
        const geminiStartTime = Date.now();
        const newComments = await getAiReviewAsJson(
          diffToReview,
          dbRepository.configuration?.customPrompt
        );
        geminiCallDurationMs = Date.now() - geminiStartTime;

        // Cache the new reviews
        for (const comment of newComments) {
          const file = filesToReview.find((f) => f.path === comment.file);
          if (file) {
            await cacheReview(
              dbRepository.id,
              file.path,
              file.contentHash,
              JSON.stringify(newComments.filter((c) => c.file === comment.file))
            );
          }
        }

        lineComments.push(...newComments);
        console.log(
          '[REVIEWER] AI review received as JSON:',
          newComments.length,
          'new line comments in',
          geminiCallDurationMs,
          'ms'
        );
      } catch (error) {
        geminiCallDurationMs = Date.now() - startTime;
        console.error('[REVIEWER] Failed to get JSON review, attempting fallback:', error);
        try {
          const geminiStartTime = Date.now();
          fallbackReview = await getAiReviewAsText(
            diffToReview,
            dbRepository.configuration?.customPrompt
          );
          geminiCallDurationMs = Date.now() - geminiStartTime;
          console.log('[REVIEWER] Fallback AI review received in', geminiCallDurationMs, 'ms');
        } catch (fallbackError) {
          throw fallbackError;
        }
      }
    } else {
      console.log('[REVIEWER] All files cached, no Gemini API call needed');
    }

    // Get token
    const token = await getInstallationToken();

    // Post comments
    console.log('[REVIEWER] Posting comments to PR...');
    const githubStartTime = Date.now();

    if (lineComments.length > 0) {
      lineCommentCount = await postLineCommentsToPR(pull_request.comments_url, lineComments, token);

      if (lineCommentCount > 0) {
        const summary = `### 🤖 AI Code Review Complete\n\nFound and commented on ${lineCommentCount} line(s) that may need attention.`;
        await postCommentToPR(pull_request.comments_url, summary, token);
      }
    } else if (fallbackReview) {
      await postCommentToPR(pull_request.comments_url, fallbackReview, token);
      lineCommentCount = 1;
    }

    githubApiDurationMs = Date.now() - githubStartTime;

    success = true;
    console.log('[REVIEWER] Review completed successfully');

    return {
      latencyMs: Date.now() - startTime,
      geminiCallDurationMs,
      githubApiDurationMs,
      lineCommentCount,
      success,
      errorMessage: null,
      filesTotalCount,
      fileCachedCount,
    };
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[REVIEWER] Review failed:', errorMessage);

    return {
      latencyMs: Date.now() - startTime,
      geminiCallDurationMs,
      githubApiDurationMs,
      lineCommentCount,
      success: false,
      errorMessage,
      filesTotalCount: 0,
      fileCachedCount: 0,
    };
  }
}

export { getAiReviewAsJson, getAiReviewAsText, getInstallationToken, postLineCommentsToPR, postCommentToPR };
