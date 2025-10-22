'use client';

import { useSession, signOut } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import RepositorySettings from '@/components/RepositorySettings';

interface Repository {
  id: number;
  githubRepoId: number;
  name: string;
  fullName: string;
  owner: string;
  installationId: number;
  configuration?: {
    id: number;
    customPrompt: string | null;
    enabled: boolean;
  };
}

export default function DashboardPage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedRepo, setSelectedRepo] = useState<Repository | null>(null);

  useEffect(() => {
    if (status === 'unauthenticated') {
      router.push('/login');
      return;
    }

    if (status === 'authenticated') {
      fetchRepositories();
    }
  }, [status, router]);

  const fetchRepositories = async () => {
    try {
      setLoading(true);
      const response = await fetch('/api/repositories');
      const data = await response.json();
      setRepositories(data);
    } catch (error) {
      console.error('Failed to fetch repositories:', error);
    } finally {
      setLoading(false);
    }
  };

  if (status === 'loading' || loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-900">
        <div className="text-white">Loading...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-900">
      {/* Header */}
      <header className="border-b border-gray-700 bg-gray-800">
        <div className="mx-auto max-w-6xl px-6 py-4">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold text-white">
                🤖 Gemini Reviewer Dashboard
              </h1>
              <p className="text-gray-400">
                Welcome, {session?.user?.name || session?.user?.email}
              </p>
            </div>
            <button
              onClick={() => signOut({ callbackUrl: '/login' })}
              className="rounded-lg bg-red-600 px-4 py-2 text-white hover:bg-red-700 transition"
            >
              Sign Out
            </button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="mx-auto max-w-6xl px-6 py-8">
        <div className="grid grid-cols-3 gap-8">
          {/* Repository List */}
          <div className="col-span-1">
            <div className="rounded-lg bg-gray-800 p-6">
              <h2 className="mb-4 text-lg font-semibold text-white">
                Your Repositories
              </h2>
              {repositories.length === 0 ? (
                <div className="rounded-lg bg-gray-700 p-4 text-center text-gray-300">
                  <p className="text-sm">
                    No repositories with Gemini Reviewer installed yet.
                  </p>
                  <p className="mt-2 text-xs text-gray-400">
                    Install the app on{' '}
                    <a
                      href="https://github.com/apps/gemini-reviewer"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-400 hover:underline"
                    >
                      GitHub
                    </a>
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  {repositories.map((repo) => (
                    <button
                      key={repo.id}
                      onClick={() => setSelectedRepo(repo)}
                      className={`w-full rounded-lg px-4 py-3 text-left text-sm transition ${
                        selectedRepo?.id === repo.id
                          ? 'bg-blue-600 text-white'
                          : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                      }`}
                    >
                      <div className="font-medium">{repo.name}</div>
                      <div className="text-xs opacity-75">{repo.fullName}</div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Configuration Panel */}
          <div className="col-span-2">
            {selectedRepo ? (
              <RepositorySettings
                repository={selectedRepo}
                onUpdate={() => fetchRepositories()}
              />
            ) : (
              <div className="rounded-lg bg-gray-800 p-6 text-center">
                <p className="text-gray-400">
                  Select a repository to configure settings
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Metrics Section */}
        {repositories.length > 0 && (
          <div className="mt-8 rounded-lg bg-gray-800 p-6">
            <h2 className="mb-4 text-lg font-semibold text-white">
              Quick Stats
            </h2>
            <div className="grid grid-cols-3 gap-4">
              <div className="rounded-lg bg-gray-700 p-4">
                <div className="text-sm text-gray-400">Total Repositories</div>
                <div className="mt-2 text-2xl font-bold text-blue-400">
                  {repositories.length}
                </div>
              </div>
              <div className="rounded-lg bg-gray-700 p-4">
                <div className="text-sm text-gray-400">
                  Configured Repositories
                </div>
                <div className="mt-2 text-2xl font-bold text-green-400">
                  {repositories.filter((r) => r.configuration).length}
                </div>
              </div>
              <div className="rounded-lg bg-gray-700 p-4">
                <div className="text-sm text-gray-400">Active</div>
                <div className="mt-2 text-2xl font-bold text-purple-400">
                  {repositories.filter(
                    (r) => r.configuration?.enabled
                  ).length || 0}
                </div>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
