import { NextResponse } from 'next/server';

export async function GET() {
  const nextauthUrl = process.env.NEXTAUTH_URL;
  const githubId = process.env.GITHUB_ID;
  const nodeEnv = process.env.NODE_ENV;

  const callbackUrl = nextauthUrl
    ? `${nextauthUrl}/api/auth/callback/github`
    : 'NEXTAUTH_URL not set';

  return NextResponse.json({
    status: 'auth-config-check',
    nextauthUrl,
    githubId,
    nodeEnv,
    expectedCallbackUrl: callbackUrl,
    timestamp: new Date().toISOString(),
  });
}
