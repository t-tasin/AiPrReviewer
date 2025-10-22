import { getServerSession } from 'next-auth/next';
import { NextRequest, NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession();

    if (!session || !session.user?.email) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { repositoryId, customPrompt, enabled } = body;

    if (!repositoryId) {
      return NextResponse.json(
        { error: 'Missing repositoryId' },
        { status: 400 }
      );
    }

    // Verify user owns this repository
    const user = await prisma.user.findUnique({
      where: { email: session.user.email },
    });

    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    const repository = await prisma.repository.findUnique({
      where: { id: repositoryId },
    });

    if (!repository || repository.userId !== user.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Update or create configuration
    const config = await prisma.repositoryConfiguration.upsert({
      where: { repositoryId },
      update: {
        customPrompt: customPrompt || null,
        enabled: enabled ?? true,
      },
      create: {
        repositoryId,
        customPrompt: customPrompt || null,
        enabled: enabled ?? true,
      },
    });

    return NextResponse.json(config);
  } catch (error) {
    console.error('Error updating configuration:', error);
    return NextResponse.json(
      { error: 'Failed to update configuration' },
      { status: 500 }
    );
  }
}
