import { NextResponse, type NextRequest } from 'next/server'
import { getRequestHost, isStagingHost } from '@/lib/staging'

export function proxy(request: NextRequest) {
	if (!isStagingHost(getRequestHost(request.headers))) {
		return NextResponse.next()
	}

	if (request.nextUrl.pathname === '/robots.txt') {
		return new NextResponse('User-agent: *\nDisallow: /\n', {
			headers: {
				'Cache-Control': 'no-store',
				'Content-Type': 'text/plain; charset=utf-8',
			},
		})
	}

	const response = NextResponse.next()
	response.headers.set('X-Robots-Tag', 'noindex, nofollow')
	return response
}

export const config = {
	matcher: ['/((?!_next/static|_next/image|images/|favicon.ico).*)'],
}
