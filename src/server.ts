import sirv from 'sirv';
import express from 'express';
import compression from 'compression';
import * as sapper from '@sapper/server';

const { PORT, NODE_ENV } = process.env;
const dev = NODE_ENV === 'development'; // NOTE: production for 'firebase serve'

const sapperServer = express()
	.use(
		compression({ threshold: 0 }),
		sirv('static', { dev }),
		sapper.middleware()
	);

if (!("FIREBASE_CONFIG" in process.env)) { // firebase handles the listening
	sapperServer.listen(PORT).on('error', err => {
		if (err) console.log('error', err);
	});
}

export {sapperServer} // for use as handler in index.js