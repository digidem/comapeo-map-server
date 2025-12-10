import { AutoRouter } from 'itty-router'

const router = AutoRouter()

router.get('/:testParam*', (request) => {
	console.log('Wildcard route matched', request.url)
})

router.get('/:testParam', (request) => {
	const { testParam } = request.params
	console.log(`Received testParam: ${testParam} route: ${request.url}`)
	return new Response(`Test parameter received: ${testParam}`, {
		status: 200,
	})
})

router.fetch(new Request('https://example.com/param'))
router.fetch(new Request('https://example.com/param/extra/path'))
