import { NextResponse } from 'next/server';

export async function GET() {
  console.log('[API Test] Test route accessed');
  return NextResponse.json(
    {
      status: 'ok',
      message: 'API is working!',
      timestamp: new Date().toISOString()
    },
    { status: 200 }
  );
}
