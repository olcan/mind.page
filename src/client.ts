import * as sapper from '@sapper/app';

// if (document.cookie.indexOf("__session")<0) { 
// 	console.log("Signing in ...")
// 	document.querySelector('#sapper').innerHTML = "Signing in ..."
// }
sapper.start({ 
	target: document.querySelector('#sapper') 
});