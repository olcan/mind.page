TSC = node_modules/typescript/bin/tsc
SRCDIR = src/firebase
OUTDIR = lib/firebase

$(OUTDIR)/%.js: $(SRCDIR)/%.ts
	$(TSC) $^ --outDir $(OUTDIR) --esModuleInterop

firebase_functions: $(OUTDIR)/functions.js
firebase: firebase_functions