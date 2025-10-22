import { PrismaClient } from '@prisma/client';
import { NextResponse } from 'next/server';

const prisma = new PrismaClient();

export async function GET() {
  try {
    // Test database connection
    const result = await prisma.$queryRaw`SELECT 1 as connected`;

    return NextResponse.json({
      status: 'success',
      message: 'Database connection successful',
      database: 'Neon',
      result,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    return NextResponse.json({
      status: 'error',
      message: error.message,
      error: String(error),
      timestamp: new Date().toISOString(),
    }, { status: 500 });
  }
}
