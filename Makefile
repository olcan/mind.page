TSC = node_modules/typescript/bin/tsc
SRCDIR = src/firebase
OUTDIR = lib/firebase

$(OUTDIR)/%.js: $(SRCDIR)/%.ts
	$(TSC) $^ --ignoreConfig --outDir $(OUTDIR) --module nodenext --moduleResolution nodenext --target es2022 --esModuleInterop --skipLibCheck

firebase_functions: $(OUTDIR)/functions.js
firebase: firebase_functions