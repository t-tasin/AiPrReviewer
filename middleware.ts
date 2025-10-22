import { withAuth } from 'next-auth/middleware';

export const middleware = withAuth(
  function middleware() {
    return undefined;
  },
  {
    callbacks: {
      authorized: ({ token }) => !!token,
    },
    pages: {
      signIn: '/login',
    },
  }
);

export const config = {
  matcher: ['/api/repositories/:path*', '/api/config/:path*'],
};
