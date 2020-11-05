function handleKeyPress(textarea, event) {
	itemsdiv = document.querySelector(".items");
	if (event.keyCode == 13 && event.shiftKey) {
		event.preventDefault();

		if (textarea.value == "clear localStorage") { 
			localStorage.clear(); 
			alert("done!");
			textarea.value = "";
			handleInput(textarea);
			return; 
		}

		// store in localStorage and just update key once stored in firestore
		var tmpkey = Math.random().toString();
		var item = {time:Date.now(), text: textarea.value};
		var itemstr = JSON.stringify(item);
		localStorage.setItem(tmpkey, JSON.stringify(item));
  		
  		var div = document.createElement('div');
  		div.className = "item";
  		div.innerHTML = escapeHtml(item.text);
  		div.style.opacity = 0.5;
		itemsdiv.insertBefore(div,itemsdiv.firstChild);
		textarea.value = "";
		handleInput(textarea);

		// store in firebase
		firebase.firestore().collection("items").add(item)
		.then(function(item) { 
			console.log("added item id: ", item.id);		
			localStorage.removeItem(tmpkey);
			localStorage.setItem(item.id, itemstr);
			div.style.opacity = 1;
		})
		.catch(function(error) { alert("error adding item: ", error); });

    }
}

document.addEventListener('DOMContentLoaded', () => { 
	handleInput(document.querySelector("textarea"));
	itemsdiv = document.querySelector(".items");
	var objs = Object.values(localStorage).filter(s=>s.startsWith("{")).map(JSON.parse);
	objs.sort(function(a, b){return b.time - a.time}).forEach(item => {
		if (!item.hasOwnProperty("text")) return; // not an item object		
		var div = document.createElement('div');
		div.className = "item";
		div.innerHTML = escapeHtml(item.text);
		itemsdiv.appendChild(div);
	});
	firebase.firestore().collection("items").orderBy("time", "desc").get()
	.then((querySnapshot) => {
		// insert new items (presumably from other devices) at the top
	    querySnapshot.forEach((item) => {
	        console.log("retrieved item id: ", item.id);	        
	        if (localStorage.hasOwnProperty(item.id)) return; // item already added to dom
        	localStorage.setItem(item.id, JSON.stringify(item.data()));
			var div = document.createElement('div');
			div.className = "item";
			div.innerHTML = escapeHtml(item.data().text);
			itemsdiv.insertBefore(div, itemsdiv.firstChild);
	    });
	    // reset/update localStorage to match firestore
	    localStorage.clear();
	    querySnapshot.forEach((item) => {
	        localStorage.setItem(item.id, JSON.stringify(item.data()));
	    });	    
	});
})

window.addEventListener('resize', () => { 
	handleInput(document.querySelector("textarea"));
})