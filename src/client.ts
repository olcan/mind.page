import * as sapper from '@sapper/app';

// import { firebaseConfig } from '../firebase.config.js'
// window.firebase is set via <script src=...> tags in template.html
//window["firebase"].initializeApp(firebaseConfig)

sapper.start({
	target: document.querySelector('#sapper')
});