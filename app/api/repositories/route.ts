import { getServerSession } from 'next-auth/next';
import { NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';
import { authOptions } from '@/lib/auth';
import axios from 'axios';

const prisma = new PrismaClient();

export async function GET() {
  try {
    const session = await getServerSession(authOptions);

    if (!session || !session.user?.email) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Get user from database
    const user = await prisma.user.findUnique({
      where: { email: session.user.email },
      include: {
        accounts: true,
        repositories: {
          include: {
            configuration: true,
          },
        },
      },
    });

    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    // Get GitHub access token from user's account
    const githubAccount = user.accounts.find(acc => acc.provider === 'github');
    if (!githubAccount?.access_token) {
      // No GitHub token, return existing databases repos
      return NextResponse.json(user.repositories);
    }

    try {
      // Fetch user's repositories from GitHub API
      const response = await axios.get('https://api.github.com/user/repos', {
        headers: {
          Authorization: `token ${githubAccount.access_token}`,
          Accept: 'application/vnd.github.v3+json',
        },
        params: { per_page: 100 },
      });

      const githubRepos = response.data;

      // Sync repositories with database
      const dbRepositories = await Promise.all(
        githubRepos.map(async (githubRepo: any) => {
          // Check if repository exists
          let dbRepo = await prisma.repository.findUnique({
            where: { githubRepoId: githubRepo.id },
            include: { configuration: true },
          });

          if (!dbRepo) {
            // Create new repository record
            try {
              dbRepo = await prisma.repository.create({
                data: {
                  githubRepoId: githubRepo.id,
                  name: githubRepo.name,
                  fullName: githubRepo.full_name,
                  owner: githubRepo.owner.login,
                  userId: user.id,
                  installationId: 0, // Will be set when app is installed on this repo
                },
                include: { configuration: true },
              });
            } catch (error) {
              console.warn(`Failed to create repository ${githubRepo.full_name}:`, error);
              return null;
            }
          }

          return dbRepo;
        })
      );

      // Filter out null values (failed creates)
      const validRepos = dbRepositories.filter(repo => repo !== null);

      return NextResponse.json(validRepos);
    } catch (githubError) {
      console.warn('Failed to fetch from GitHub API, returning database repositories:', githubError);
      // Fall back to database if GitHub API fails
      return NextResponse.json(user.repositories);
    }
  } catch (error) {
    console.error('Error fetching repositories:', error);
    return NextResponse.json(
      { error: 'Failed to fetch repositories' },
      { status: 500 }
    );
  }
}
