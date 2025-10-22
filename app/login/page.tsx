'use client';

import { signIn } from 'next-auth/react';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';

function LoginContent() {
  const searchParams = useSearchParams();
  const error = searchParams.get('error');

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-900">
      <div className="w-full max-w-md rounded-lg bg-gray-800 p-8 shadow-lg">
        <div className="mb-8 text-center">
          <h1 className="mb-2 text-3xl font-bold text-white">
            🤖 Gemini Reviewer
          </h1>
          <p className="text-gray-400">
            AI-powered code reviews for your GitHub PRs
          </p>
        </div>

        {error && (
          <div className="mb-6 rounded-lg bg-red-900 p-4 text-red-200">
            <p className="text-sm">
              {error === 'OAuthCallback'
                ? 'Authentication failed. Please try again.'
                : error}
            </p>
          </div>
        )}

        <button
          onClick={() => signIn('github', { callbackUrl: '/dashboard' })}
          className="w-full rounded-lg bg-blue-600 px-4 py-3 font-semibold text-white hover:bg-blue-700 transition"
        >
          Sign in with GitHub
        </button>

        <p className="mt-6 text-center text-sm text-gray-400">
          This app uses GitHub OAuth to authenticate users and manage your
          repositories securely.
        </p>

        <div className="mt-8 border-t border-gray-700 pt-6">
          <h2 className="mb-4 font-semibold text-white">Features:</h2>
          <ul className="space-y-2 text-sm text-gray-400">
            <li>✅ Configure custom AI review prompts per repository</li>
            <li>✅ Automatic code reviews on pull requests</li>
            <li>✅ Track review metrics and performance</li>
            <li>✅ Multi-repository support</li>
          </ul>
        </div>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="flex min-h-screen items-center justify-center bg-gray-900"><div className="text-white">Loading...</div></div>}>
      <LoginContent />
    </Suspense>
  );
}
